//! The process table: what a pid is now, whether it is the bundled engine, and which engines an
//! app started.
//!
//! A pid is a number the kernel reuses, so this file carries `starttime` beside it: two `Proc` readings
//! are the same process only when both agree. `engines_under` walks a parent chain rather than
//! comparing `ppid` to the app, because a start is allowed a wrapper between the two.
//!
//! Every item another file reaches is `pub` — the launch reads the table for an engine and the case reads
//! it after the quit — while `stat_of`, `processes` and `is_engine` stay private, because they are what
//! `engines_under` is built from and nothing outside this file names them.

use std::fs;

use crate::support::ENGINE_NAME;

// ---------------------------------------------------------------------------
// The process table
// ---------------------------------------------------------------------------

/// One process, as much of it as this case reads: who it is, who started it, and when it started.
///
/// `start` is `/proc/<pid>/stat`'s `starttime`, and it is carried for one reason: a pid is a number
/// the kernel reuses, and "the engine is gone" must not be answerable by a *different* process that
/// happens to have taken the engine's number. Two readings that agree on pid and starttime are the
/// same process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub start: u64,
}

/// `/proc/<pid>/stat`'s comm, ppid and starttime.
///
/// Parsed by hand rather than split on whitespace, because the second field is the program name in
/// parentheses and a name may contain both spaces and parentheses (`(sd-pam)`). The last `)` in the
/// line is the field's end — no later field can contain one.
fn stat_of(pid: u32) -> Option<(String, u32, u64)> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let comm = stat[open + 1..close].to_string();
    let rest: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    // After the name: state, ppid, … — ppid is first after the state, and `starttime` is the
    // twenty-second field of the line, nineteenth of the remainder (`proc(5)`).
    Some((
        comm,
        rest.get(1)?.parse().ok()?,
        rest.get(19)?.parse().ok()?,
    ))
}

fn processes() -> Vec<Proc> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir("/proc") else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if let Some((_comm, ppid, start)) = stat_of(pid) {
            out.push(Proc { pid, ppid, start });
        }
    }
    out
}

/// Whether this process is the bundled engine — by the name it carries, or by the executable it
/// runs. Both are read: a program can set either, and the second is the one that cannot be talked
/// into a lie without replacing the file.
pub fn is_engine(pid: u32) -> bool {
    if stat_of(pid).is_some_and(|(comm, _, _)| comm == ENGINE_NAME) {
        return true;
    }
    fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .and_then(|exe| {
            exe.file_name()
                .map(|name| name.to_string_lossy() == ENGINE_NAME)
        })
        .unwrap_or(false)
}

/// The engine processes `root` started: any engine whose parent chain reaches it.
///
/// A chain rather than `ppid == root`, because a start is allowed a wrapper between the app and the
/// engine — the app's own spawn is direct today, and a case that assumed it would report "no
/// engine" the day that changed.
pub fn engines_under(root: u32) -> Vec<Proc> {
    let all = processes();
    let parent = |pid: u32| all.iter().find(|p| p.pid == pid).map(|p| p.ppid);
    all.iter()
        .filter(|p| is_engine(p.pid))
        .filter(|p| {
            let mut current = p.ppid;
            // Bounded rather than a `while`: a cycle in the table (a pid reused while this list
            // was being read) must not be an infinite loop in a test.
            for _ in 0..12 {
                if current == root {
                    return true;
                }
                match parent(current) {
                    Some(next) if current > 1 => current = next,
                    _ => return false,
                }
            }
            false
        })
        .copied()
        .collect()
}
/// Whether a process this case recorded earlier is still the process running now.
pub fn alive(proc: Proc) -> bool {
    stat_of(proc.pid).is_some_and(|(_, _, start)| start == proc.start)
}
/// What a process is running, for a failure message that says which engine was left behind.
pub fn command_line(pid: u32) -> String {
    fs::read(format!("/proc/{pid}/cmdline"))
        .ok()
        .map(|bytes| {
            String::from_utf8_lossy(&bytes)
                .replace('\0', " ")
                .trim()
                .to_string()
        })
        .unwrap_or_default()
}
