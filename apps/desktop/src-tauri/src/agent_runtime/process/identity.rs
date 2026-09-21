//! The kernel's answer to "is the engine this host started still running?".
//!
//! A module of its own because the question has its own reason to change: it is a reading of
//! `/proc`, and what it must rule out — a pid the kernel has handed to somebody else, a process
//! group that still has the engine's own subprocesses in it, a zombie whose parent has not collected
//! it — is a property of this platform rather than of the launch or of any pipe. [`super`]'s other
//! children are about starting an engine and hearing from it; this is the one consulted long
//! afterwards, where a claim held on a dead process would refuse the next start.
//!
//! Nothing here signals anything or reads a stream: it is the reading a *claim* is freed by, and
//! the whole of what makes it safe is that it answers about a process rather than about this host's
//! memory of having started one.

use std::fs;
use std::io;

/// The engine process, as the kernel names it: the pid it was spawned with, and the moment that pid's
/// process started.
///
/// **The one question this answers is the one a claim cannot answer from memory.** §3.4 refuses a
/// second engine on one (agent, profile, vault), and that refusal is honest only while the first
/// engine is *there*. An engine that exits on its own leaves a claim this host still holds, and the
/// next start — the only way a user gets an engine back — is refused on behalf of a process that no
/// longer exists. Answering it means asking about the process rather than about the host's memory of
/// having started one; the epoch the registry keeps is a name, not a fact about a process table.
///
/// **Why not the process group.** `kill(-pgid, 0)` — or a scan of `/proc` by group — answers "is any
/// member of this group still alive", and every subprocess the engine spawned is a member: a dead
/// engine that left a tool subprocess behind would read as alive, which is the same wedge wearing a
/// different process. **Why not the pid alone.** The kernel hands a number out again once it has
/// wrapped (`/proc/sys/kernel/pid_max` is 4194304 here, and a long-lived session allocates pids
/// continuously), so a check that accepted a reused number would keep a start refused on behalf of a
/// process this host never started — §6.3's rule that only the processes this host started may be
/// signalled has the same shape here, where the stake is a claim. **Why not a flag the supervisor
/// sets.** A flag is the host's own recollection that it observed an exit, and this reading can be
/// asked of the kernel again at any moment by anyone.
///
/// **An exited process is gone, whether or not it has been reaped.** `/proc/<pid>` is present for a
/// zombie and reads `Z`, and a zombie is not an engine: the reap is the supervisor's business (see
/// `acp_transport`) and not this question's. That is deliberately the reading that does not depend
/// on the reap having happened yet — the machine this was written on had exactly that state, an
/// engine the host had started, exited and never collected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineProcess {
    pid: i32,
    /// Field 22 of `/proc/<pid>/stat`: the process's start time, in clock ticks since boot.
    ///
    /// Read once, while the pid is certainly this process's own, and compared on every later read:
    /// it is the whole of what makes a reused pid a *different* process rather than the same one.
    started_at: u64,
}

impl EngineProcess {
    /// The identity of a process this host has just spawned.
    ///
    /// `None` when the kernel would not say. A caller must treat that as *unknown* rather than as
    /// *gone*: §3.4's one-engine rule is what a claim protects, so a claim that cannot be judged
    /// stays claimed.
    pub fn of(pid: i32) -> Option<Self> {
        let stat = read_stat(pid).ok()?;
        Some(Self {
            pid,
            started_at: stat.started_at,
        })
    }

    /// The kernel's own answer to "is the engine this host started still running?"
    ///
    /// `false` is the answer that frees a claim, so every arm that cannot *prove* the process is gone
    /// answers `true`:
    ///
    /// - the entry is there under this process's own start time, and its state is neither `Z` (exited,
    ///   not yet reaped) nor `X` (dead): running;
    /// - there is no such entry (`ENOENT`): the kernel has no such process, and its pid is free for
    ///   the next one;
    /// - the entry is there under a *different* start time: this number belongs to somebody else now,
    ///   and the process this identity was taken from is gone;
    /// - anything else — no `/proc` at all, an entry this process may not read, a format this reader
    ///   does not know — is not provable, so it reads as running. A wrong "gone" is how two engines
    ///   end up writing one profile, and a wrong "running" costs one refused start that the next
    ///   attempt clears.
    pub fn is_running(&self) -> bool {
        match read_stat(self.pid) {
            Ok(stat) => stat.started_at == self.started_at && !stat.has_exited(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(_) => true,
        }
    }
}

/// The two fields of `/proc/<pid>/stat` this module judges by.
struct ProcessStat {
    /// Field 3: `R`, `S`, `D`, `Z`, `T`, `t`, `X`, … — one letter, as `proc(5)` lists them.
    state: char,
    /// Field 22, in clock ticks since boot.
    started_at: u64,
}

impl ProcessStat {
    /// Whether the kernel has this process down as finished. `Z` is the state a process the parent
    /// has not collected yet is in; `X` is the one it takes when it is being torn down.
    fn has_exited(&self) -> bool {
        matches!(self.state, 'Z' | 'X')
    }
}

/// One reading of `/proc/<pid>/stat`.
///
/// Parsed from the **last** `)`: field 2 is the command name in parentheses, and a name may contain
/// both spaces and parentheses of its own (`grep -E '(a|b)'` is one), so splitting on whitespace from
/// the left reads a name's words as fields.
fn read_stat(pid: i32) -> io::Result<ProcessStat> {
    let text = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let tail = text
        .rsplit_once(')')
        .map(|(_, tail)| tail)
        .unwrap_or_default();
    let mut fields = tail.split_whitespace();
    let state = fields.next().and_then(|field| field.chars().next());
    // The remaining fields start at ppid (4), so the twentieth of them is starttime (22).
    let started_at = fields.nth(18).and_then(|field| field.parse().ok());
    match (state, started_at) {
        (Some(state), Some(started_at)) => Ok(ProcessStat { state, started_at }),
        // A stat file whose shape this reader does not know is *unreadable* rather than "gone": the
        // caller's rule for an answer it cannot read is the safe one.
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "this reader did not recognise the fields of /proc/<pid>/stat",
        )),
    }
}

#[cfg(test)]
mod engine_process_tests {
    use super::*;
    use std::path::Path;
    use std::process::{Child, Command};
    use std::time::{Duration, Instant};

    /// The reading is about a process this host started, so the tests start one: a child of this test
    /// process, which is the same relationship the transport has to the engine.
    fn spawn_a_child() -> Child {
        Command::new("/bin/sh")
            .arg("-c")
            .arg("sleep 30")
            .spawn()
            .expect("a child to judge")
    }

    fn wait_until(mut done: impl FnMut() -> bool, what: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_running_process_reads_as_running() {
        let mut child = spawn_a_child();
        let engine =
            EngineProcess::of(child.id() as i32).expect("the kernel names a process it has");
        assert!(
            engine.is_running(),
            "a child that is asleep in front of this test is running"
        );
        let _ = child.wait();
    }

    /// The state the machine this was written on was in: an engine the host had started, exited on
    /// its own and never collected. A zombie is not an engine, and a reading that called it one would
    /// leave the next start refused for as long as the app ran.
    #[test]
    fn an_exited_process_reads_as_gone_before_its_parent_reaps_it() {
        let mut child = spawn_a_child();
        let pid = child.id() as i32;
        let engine = EngineProcess::of(pid).expect("the kernel names a process it has");
        assert!(engine.is_running());

        child.kill().expect("SIGKILL to a child of this test");
        wait_until(
            || read_stat(pid).map(|stat| stat.has_exited()).unwrap_or(true),
            "the kernel to record the exit",
        );

        // The positive control, and the whole reason this case is a *reading* rather than an
        // absence: the entry is still there — `/proc/<pid>` is a zombie's directory too — so what
        // `is_running` answered was about the state, not about the file having gone away.
        assert!(
            Path::new(&format!("/proc/{pid}/stat")).exists(),
            "a process killed and not yet waited for is still in the table as a zombie"
        );
        assert!(
            !engine.is_running(),
            "an exited process is not an engine, whether or not this host has collected it"
        );

        // And once it is reaped, the pid is gone from the table altogether — the same answer, from
        // the other reading.
        let _ = child.wait();
        assert!(!engine.is_running(), "a reaped process is gone");
    }

    /// Pid reuse, and the guard against it: the process is alive and in front of this test, and the
    /// identity is still not this engine's, because an identity carries the start time of the process
    /// it was taken from. The kernel hands a number out again once it has wrapped, and a claim kept on
    /// behalf of a process this host never started is a start refused for a stranger.
    ///
    /// Reuse itself cannot be arranged from a test; what is asserted is the reading the guard makes,
    /// on a live process whose start time is wrong by one tick.
    #[test]
    fn a_pid_carrying_another_processs_start_time_is_not_this_engine() {
        let mut child = spawn_a_child();
        let pid = child.id() as i32;
        let real = read_stat(pid)
            .expect("a live child has a stat line")
            .started_at;
        let ours = EngineProcess {
            pid,
            started_at: real,
        };
        let somebody_elses = EngineProcess {
            pid,
            started_at: real + 1,
        };
        assert!(
            ours.is_running(),
            "the control: this identity is this process"
        );
        assert!(
            !somebody_elses.is_running(),
            "the same number under a different start time is a different process"
        );
        let _ = child.wait();
    }

    #[test]
    fn a_pid_the_kernel_does_not_have_is_gone_and_is_not_an_identity() {
        // Above `/proc/sys/kernel/pid_max`, so no process can hold it.
        assert!(
            EngineProcess::of(i32::MAX).is_none(),
            "a process that is not there has no identity to read"
        );
        let absent = EngineProcess {
            pid: i32::MAX,
            started_at: 0,
        };
        assert!(!absent.is_running());
    }
}
