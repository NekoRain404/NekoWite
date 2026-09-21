//! The engine's own end, as this host's supervisor saw it: the process a connection started stopped
//! being a process.
//!
//! A module of its own rather than a third reading inside `process.rs`, and the split is by what
//! makes each one change. `process.rs` moves when the spawning, the pipes or the shutdown sequence
//! do; this moves when the host's answer to "is the engine still there?" does — which is the reason
//! `agent_runtime::environment` is a module of its own rather than another section of `process.rs`,
//! the file that imports the one thing it needs from it. The two readings a *failure* consults are
//! named here together only because a failure names them: [`super::EngineStderr`] is the engine's
//! last words, and this is whether there is an end to those words at all.

use std::time::Duration;

use tokio::sync::watch;

/// How long a call that failed without an answer waits for the host to confirm the engine is gone.
///
/// The wait is normally no wait at all, and for the same reason [`super::STDERR_EOF_BOUND`]'s is
/// not: the failure this corrects is one the engine's own death caused — the exit is what ended the
/// transport — so the process is already gone before the failure is observed, and all that is
/// waited for is the supervisor task that reaps it being polled, which is one signal delivery away.
///
/// The bound is for the case where that is not what happened: the SDK can fail on its own behalf
/// with the engine still alive and answering, and a failure that waits on a healthy engine is the
/// hang this host refuses to introduce. A second is [`super::STDERR_EOF_BOUND`]'s own number, and
/// its reason holds here too: a woken task is thousands of times faster than that on an idle
/// machine, and still well inside it on the loaded one this was measured on.
const ENGINE_EXIT_BOUND: Duration = Duration::from_secs(1);

/// The engine's own end, as this host's supervisor saw it.
///
/// **Why the host keeps a reading of its own.** `TransportError::Disconnected` is the arm that
/// promises an engine's last words — `acp_transport::with_engine_stderr` attaches stderr to it and
/// to nothing else — and the SDK reports most engine deaths that way: clean EOF on the engine's
/// stdout fails every outstanding request with an error carrying its
/// `INCOMING_TRANSPORT_CLOSED_REASON`. One death it does not report that way is a race between two
/// of its own tasks, and the engine's exit is what wakes both of them. The transport ends when the
/// engine goes, and its read half reaches EOF — which is what fails the outstanding replies — while
/// its write half's send to a process that is gone fails, which ends the connection *without*
/// failing them: the read half is then dropped before it has run. A reply dropped rather than
/// failed reaches the caller as the SDK's own internal error — `response to \`initialize\` never
/// received: oneshot canceled` — which names neither the engine nor its exit, and which the caller
/// cannot tell from an answer by reading the error alone. The host can tell, because it owns the
/// process.
///
/// **The measurement.** `an_engine_that_dies_the_moment_it_starts_still_gets_to_say_why`, against
/// an engine that writes one line to stderr and exits at once, failed 1 run in 52 of a 60-run loop
/// on a machine at load 5–17 with exactly that sentence and nothing under it. The failure was
/// noticed by the handshake: `connect` had already succeeded, so the connect path's own reading of
/// stderr was never reached, and both handles — the log a reader never asked, and the process
/// reading nothing consulted — were there the whole time. The same loop after this reading was
/// consulted: 100 runs, 100 green, and the reply-dropped shape recurred in 3 of them and carried
/// the engine's line every time.
///
/// **Why a wait rather than a flag.** The reap belongs to a task of its own (the supervisor in
/// `acp_transport`), so "the engine exited" can be true in the process table before it is visible
/// here. A reader that sampled a flag would be a narrower race rather than a removed one;
/// [`Self::exited`] waits for the condition, bounded by [`ENGINE_EXIT_BOUND`].
pub struct EngineExit {
    exited: watch::Receiver<bool>,
}

impl EngineExit {
    /// The sending half, for the supervisor — the only task that can observe the exit — and the
    /// reading half a failure keeps.
    pub fn watch() -> (watch::Sender<bool>, Self) {
        let (exited, reading) = watch::channel(false);
        (exited, Self { exited: reading })
    }

    /// Waits, bounded by [`ENGINE_EXIT_BOUND`], for the engine to be gone.
    ///
    /// `true` once the supervisor has collected the child. See the constant for why the wait is
    /// normally nothing, and for the case it is there to cut short.
    pub async fn exited(&self) -> bool {
        if *self.exited.borrow() {
            return true;
        }
        let mut exited = self.exited.clone();
        // Either the supervisor said so or it dropped the sender on its way out; neither leaves an
        // exit still to be observed, and the reading below is the answer either way.
        let _ = tokio::time::timeout(ENGINE_EXIT_BOUND, exited.changed()).await;
        *self.exited.borrow()
    }
}

#[cfg(test)]
mod engine_exit_tests {
    use super::*;
    use std::time::Instant;

    /// The reading a failure acts on is only worth having if it says yes when the engine is gone:
    /// that is the whole of what turns a dropped reply into the engine's own account of itself.
    #[tokio::test]
    async fn an_exit_the_supervisor_saw_after_the_failure_was_built_is_still_learned() {
        // The shape the fix is for, at the scale of the two tasks it is between: the reader asks
        // before the supervisor has said anything, and the wait — not a sample — is what makes the
        // answer true. An implementation that read the flag once sees `false` here.
        let (exited, reading) = EngineExit::watch();
        let supervisor = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let _ = exited.send(true);
        });

        assert!(
            reading.exited().await,
            "a failure noticed before the reap must still learn that the engine is gone"
        );
        supervisor.await.expect("the supervisor task");
    }

    /// And the reading that must stay false: an engine that has not exited is one that can still
    /// answer, so a failure beside it is not a disconnection and must not be re-read as one.
    #[tokio::test]
    async fn an_engine_that_has_not_exited_does_not_read_as_gone() {
        let (exited, reading) = EngineExit::watch();
        // Held, so the wait below ends by its bound rather than by a dropped sender.
        assert!(
            !reading.exited().await,
            "nothing has said the engine is gone, so it is not"
        );
        drop(exited);
    }

    /// The cheap half: an exit the supervisor has already reported costs no wait, so the bound is
    /// paid only when the condition genuinely is not there. A regression to "always wait" would
    /// put [`ENGINE_EXIT_BOUND`] in front of every failure this reading is consulted for.
    #[tokio::test]
    async fn an_exit_already_reported_is_read_without_waiting() {
        let (exited, reading) = EngineExit::watch();
        exited.send(true).expect("the reading half is alive");

        let started = Instant::now();
        assert!(reading.exited().await);
        assert!(
            started.elapsed() < ENGINE_EXIT_BOUND / 2,
            "an exit already reported must not cost the bound: {:?}",
            started.elapsed()
        );
    }
}
