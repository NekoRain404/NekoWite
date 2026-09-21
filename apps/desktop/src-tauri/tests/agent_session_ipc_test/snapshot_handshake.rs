//! §6.2's handshake: every frame a window's channel receives after its snapshot is either in that
//! snapshot or newer than it.
//!
//! The property is the one the adapter depends on — a window subscribes *from* the snapshot it took
//! — and it is asserted against the real runtime rather than a double, because what it can catch is
//! a frame the host published but had not yet recorded.

use nekowite_lib::agent_runtime::snapshot::SessionState;
use nekowite_lib::commands::agent::{agent_prompt, agent_session_snapshot};

use crate::support::{open, wait_for_state, wired};

#[tokio::test]
async fn every_frame_a_window_receives_after_its_snapshot_is_in_the_snapshot_or_newer_than_it() {
    // §6.2's handshake, asserted as the property the adapter depends on: the window subscribes
    // *from* the snapshot it took, and the two places it can be delivered from are that snapshot's
    // tail (`channel.ts` replays the frames above the position the caller holds) and the live
    // stream (frames above the host's own sequence, buffered while the handshake was in flight).
    // A frame that arrives after the snapshot and is in neither place is a hole no subscriber
    // could detect — the failure the snapshot exists to prevent.
    //
    // **Which frames are asserted over, and why they are the property.** The count is taken
    // immediately *before* the snapshot is asked for, so the set is every frame the window's
    // channel received from that moment on: the frames that arrived while the snapshot was being
    // taken, and every frame after it. A frame received strictly before it is not evidence about
    // this handshake — it is evidence about the replay window's bound, and there the contract's
    // answer is a *refusal*, not a silent loss: a caller whose position is older than the tail is
    // told `buffer-conflict` and takes a fresh snapshot (`channel.ts`'s `tailStart` check, covered
    // by `tauri-agent.test.ts`). Asserting over those too made this test depend on the window
    // being larger than the session's whole stream — a property of `REPLAY_WINDOW`, not of the
    // handshake it is named for.
    //
    // What it did go red on, and why it no longer does: frames received *after* the snapshot and in
    // neither place, which is the property the assertion is about. The one it caught was a frame
    // the host had published but not yet recorded — "nothing published yet" and "frame 0 was
    // published" were the same number in `SessionSnapshot::sequence`, because the emitter's counter
    // started at 0, and the window this set covers is exactly the one that lost it (measured: 6
    // failures in 150 runs of this binary). Numbering now starts at one
    // (`agent_runtime::session::emitter`'s `FIRST_SEQUENCE`), so an empty record says 0 and means
    // it, and `no_frame_a_runtime_publishes_carries_the_sequence_that_means_no_frame` is where
    // that is asserted rather than assumed.
    let wired = wired("handshake", "good", None).await;
    let opened = open(&wired).await;
    let delivered = wired.received.lock().unwrap().len();
    let before = agent_session_snapshot(wired.ipc(), opened.session_id.clone())
        .await
        .expect("snapshot");
    // "In the snapshot" is both of the lists a caller is handed, not the tail alone: a permission
    // request travels in the snapshot's own `permissions` list (that is where `channel.ts` reads
    // prompts from), and a caller holding it has it. This session is never asked to allow anything
    // — the harness passes no reverse request — so the second list is a statement of the property
    // rather than a path this run exercises.
    let replayed: Vec<u64> = before
        .events
        .iter()
        .chain(&before.permissions)
        .map(|event| event.sequence)
        .collect();

    agent_prompt(
        wired.app.handle().clone(),
        wired.ipc(),
        opened.session_id.clone(),
        "hello".to_string(),
        None,
    )
    .await
    .expect("prompt");
    wait_for_state(wired.ipc(), &opened.session_id, SessionState::Completed).await;

    let received = wired.received.lock().unwrap().clone();
    let after = received.get(delivered..).expect("the sink only ever grows");
    assert!(!after.is_empty(), "the turn published frames");
    for event in after {
        assert!(
            replayed.contains(&event.sequence) || event.sequence > before.sequence,
            "sequence {} ({:?}) is neither in the snapshot nor newer than it ({}): a window that \
             took the snapshot would lose it. The snapshot's tail held {} frame(s), first {:?}",
            event.sequence,
            event.kind,
            before.sequence,
            replayed.len(),
            replayed.first()
        );
    }
}
