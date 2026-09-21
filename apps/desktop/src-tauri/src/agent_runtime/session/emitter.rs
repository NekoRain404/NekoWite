//! The number a published frame carries, and the one critical section that keeps the numbering and
//! the queue in the same order.
//!
//! **Why it is a file of its own.** It was a section of [`super`], which passed the 600-line budget
//! `docs/dev.md:286` puts on a business source file, and the criterion that section states is the
//! number of reasons a file changes rather than its length. This module moves when the *stream*
//! moves: what an incarnation's first frame is numbered, what `0` means to every other reader of
//! the sequence, or which of the three producers may get between a number and its push. The parent
//! moves when the host's own table of sessions does — a different question entirely, because
//! nothing here reads a session and nothing here decides whether one is open.
//!
//! The two tests at the bottom came with the type rather than staying behind: they are the claims
//! two other modules are written against (`task_projection::vocabulary`'s `FrameOrder::off_stream`
//! and `notification_policy`'s `if fact.sequence != 0`), and the emitter is what has to keep
//! providing them.

use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::mpsc;

use super::super::events::{AgentEventEnvelope, AgentEventKind, AgentIdentity};

/// The sequence the first frame a runtime publishes carries.
///
/// Zero is not a sequence any frame may carry, and it is not a free choice: 0 is what this host
/// answers with when a session has published *nothing*. An empty [`super::super::snapshot::SessionLog`]
/// reports `sequence: 0`, the contract says the same in as many words ("or 0 when the session has
/// emitted nothing yet"), this host's own views sit at 0 until they have applied a frame, and
/// `task_projection`'s `FrameOrder::off_stream` uses 0 for a fact the host reports from its own view
/// rather than reads off a stream — which is what `notification_policy` branches on to tell the two
/// apart. A stream whose first frame was also 0 would make "nothing has been published" and "frame 0
/// was published" one value on the wire, and the window that mounted in between would drop the frame
/// **silently**: every delivery path compares with `>` against the caller's position (`channel.ts`'s
/// tail replay and live buffer, the reducer's own `judgeSequence`), and a hole is only recorded from
/// a position above zero — so the frame is filtered out at all three layers with no gap to show for
/// it. Numbering from one leaves 0 free to mean "no frame", which is what every one of those readers
/// already assumes it means.
///
/// The stream this numbers is one runtime incarnation's (the identity carries the epoch), so this is
/// the start of a sequence space, not of a global count: nothing persisted compares across it — the
/// pet's durable stream marks are deliberately dropped when the process changes.
const FIRST_SEQUENCE: u64 = 1;

/// Stamps and sends host envelopes.
///
/// The sequence counter is shared by the update dispatcher and every run task,
/// and it has to be: two counters would hand the UI two streams that each look
/// monotonic while together they are not.
///
/// **Numbering and delivery are one step, under one lock.** They were two — `fetch_add` and then a
/// send — and that is a real hole rather than a theoretical one: three producers emit on this path
/// (the update dispatcher, whichever task ends a run, and the permission table, which is reached
/// from the driver's own task), so a frame numbered `n` can be queued after a frame numbered `n + 1`.
/// The receiver takes the stream in queue order, and every consumer of the number treats a frame at
/// or below its position as a *replay or an out-of-order arrival* and drops it — the window's
/// reducer records a hole only for a frame *above* its position, so the late frame is dropped with
/// nothing said. A window that can tell it missed a frame is a different situation from one that
/// cannot; §6.2's handshake exists for the second to be impossible.
#[derive(Clone)]
pub(in crate::agent_runtime) struct Emitter {
    identity: AgentIdentity,
    /// The next sequence to assign.
    ///
    /// A mutex rather than an atomic because the number and the queue push have to be one critical
    /// section — see the type's own note. What it costs: one uncontended lock/unlock per published
    /// frame, on the producer's side (the task that forwards the engine's updates), held for a
    /// read-and-increment plus the envelope's own construction and an unbounded channel's push —
    /// all of it allocation-bounded, none of it awaiting. Contention needs two producers in the same
    /// instant, which is a run ending or a permission request landing mid-turn, not steady state:
    /// for the length of one turn the update dispatcher is the only emitter, so the lock is taken
    /// and released by one task.
    sequence: Arc<Mutex<u64>>,
    events: mpsc::UnboundedSender<AgentEventEnvelope>,
}

impl Emitter {
    /// The runtime's emitter, and the channel the frames it publishes arrive on.
    ///
    /// Made in one place so that where a stream starts is this type's business and nobody else's:
    /// [`FIRST_SEQUENCE`] is the one line that decides whether a frame can carry the value every
    /// other module reads as "no frame".
    pub(super) fn new(
        identity: AgentIdentity,
    ) -> (Self, mpsc::UnboundedReceiver<AgentEventEnvelope>) {
        let (events, incoming) = mpsc::unbounded_channel();
        (
            Self {
                identity,
                sequence: Arc::new(Mutex::new(FIRST_SEQUENCE)),
                events,
            },
            incoming,
        )
    }

    pub(in crate::agent_runtime) fn emit(
        &self,
        session_id: &str,
        run_id: Option<String>,
        kind: AgentEventKind,
        payload: Value,
    ) {
        // Held until the frame is in the queue, so the frame that took `n` is queued before any
        // other emitter can take `n + 1`: the queue order is the numbering order, and no consumer
        // has to detect a reordering the emitter could have prevented.
        let mut next = self.sequence.lock().unwrap();
        let sequence = *next;
        *next += 1;
        let envelope = AgentEventEnvelope {
            agent_id: self.identity.agent_id.clone(),
            profile_id: self.identity.profile_id.clone(),
            runtime_epoch: self.identity.runtime_epoch.clone(),
            vault_id: self.identity.vault_id.clone(),
            session_id: session_id.to_string(),
            run_id,
            sequence,
            kind,
            payload,
        };
        // The receiver is [`AgentRuntimeEvents`], held by the one task that drives the runtime.
        // A send that fails means that task is gone, which is the shutdown path, not an event to
        // report.
        let _ = self.events.send(envelope);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    fn identity() -> AgentIdentity {
        AgentIdentity {
            agent_id: "opencode".to_string(),
            profile_id: "default".to_string(),
            runtime_epoch: "epoch-1".to_string(),
            vault_id: "vault-1".to_string(),
        }
    }

    fn emit_one(emitter: &Emitter) {
        emitter.emit(
            "ses-1",
            Some("run-0".to_string()),
            AgentEventKind::TextDelta,
            serde_json::json!({ "text": "x" }),
        );
    }

    /// The two statements two other modules are written against, held to the emitter that has to
    /// provide them: `task_projection::vocabulary`'s `FrameOrder::off_stream` ("zero is the sequence
    /// no runtime ever assigns") and `notification_policy`'s `if fact.sequence != 0` (which tells a
    /// host-reported fact from a frame off the stream).
    ///
    /// Both were false: the counter started at 0, so a stream's first frame carried the one number
    /// every other reader uses for "no frame". What that cost is not a label but a frame — an empty
    /// record answers `sequence: 0`, and every delivery path filters with `>` against the caller's
    /// position, so a window that took its snapshot before the first frame had it dropped at the
    /// tail, at the live buffer and at the reducer, with no hole recorded because a hole needs a
    /// position above zero to be seen from. `agent_session_ipc_test`'s
    /// `no_frame_a_runtime_publishes_carries_the_sequence_that_means_no_frame` is the same claim
    /// over the real runtime; this is the same claim over the emitter alone.
    #[test]
    fn the_first_frame_a_stream_publishes_is_not_the_sequence_that_means_no_frame() {
        let (emitter, mut incoming) = Emitter::new(identity());
        emit_one(&emitter);
        let first = incoming.try_recv().expect("the frame is published");
        assert_eq!(
            first.sequence, FIRST_SEQUENCE,
            "a stream starts at {FIRST_SEQUENCE}, so that 0 keeps meaning \"nothing published\""
        );
        assert_ne!(
            first.sequence, 0,
            "a frame carrying 0 is a frame every reader of the sequence discards as not one"
        );
    }

    /// The numbering and the queue order are one order.
    ///
    /// Three producers emit on this path and they run on different tasks, so a counter that is
    /// incremented separately from the send hands the queue `n + 1` before `n` whenever two of them
    /// are in flight at once. Nothing downstream can repair that: a consumer reads a frame at or
    /// below its position as a replay and drops it, and the hole is not recorded — the window's
    /// reducer only reports a gap for a frame *above* its position, so the late frame's absence is
    /// indistinguishable from a frame that never existed. This is the test that fails when the two
    /// steps are separate again, and it fails on the ordering rather than on a timeout because the
    /// threads are joined before the queue is read.
    #[test]
    fn concurrent_emitters_queue_frames_in_the_order_they_numbered_them() {
        const THREADS: usize = 8;
        const EACH: usize = 20_000;
        let (emitter, mut incoming) = Emitter::new(identity());
        let start = Arc::new(Barrier::new(THREADS));
        std::thread::scope(|scope| {
            for _ in 0..THREADS {
                let emitter = emitter.clone();
                let start = Arc::clone(&start);
                scope.spawn(move || {
                    // Released together: every producer is inside `emit` at the same time, which is
                    // the condition the numbering has to survive.
                    start.wait();
                    for _ in 0..EACH {
                        emit_one(&emitter);
                    }
                });
            }
        });

        let mut published = Vec::new();
        while let Ok(envelope) = incoming.try_recv() {
            published.push(envelope.sequence);
        }
        let total = (THREADS * EACH) as u64;
        assert_eq!(
            published.len() as u64,
            total,
            "every frame reached the queue"
        );
        let expected: Vec<u64> = (FIRST_SEQUENCE..FIRST_SEQUENCE + total).collect();
        if let Some(index) = published
            .iter()
            .zip(&expected)
            .position(|(queued, number)| queued != number)
        {
            let from = index.saturating_sub(4);
            panic!(
                "the queue is not in the order the numbers were handed out: at position {index} it \
                 holds {:?} where it should hold {:?} — a consumer drops the late frame as a replay \
                 and records no hole for it",
                &published[from..(index + 4).min(published.len())],
                &expected[from..(index + 4).min(expected.len())],
            );
        }
    }
}
