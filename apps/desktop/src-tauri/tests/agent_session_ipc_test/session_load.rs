//! Reopening a session the engine already holds: `agent_load_session` → the host's own snapshot log
//! → the frames a panel that mounts *afterwards* is given.
//!
//! Two orderings of the same chain, because they fail differently: the replay that arrives before
//! the load's response, and the whole replay arriving in one read with the response behind it.

use std::fs;
use std::time::Duration;

use nekowite_lib::agent_runtime::events::AgentEventKind;
use nekowite_lib::commands::agent::agent_session_snapshot;
use nekowite_lib::commands::agent_sessions::agent_load_session;

use crate::support::{rooted, temp_dir, wired_at};

/// The chain no other test in this tree reaches: `agent_load_session` → the host's own snapshot
/// log → the frames a panel that mounts *afterwards* is given.
///
/// Every link exists somewhere else and nowhere together. The frontend tests drive the memory
/// double, which replays through its own book-keeping rather than through this host's; the browser
/// e2e mounts the panel by hand; `agent_session_replay_live_test.rs` stops at the runtime's event
/// stream and never touches the snapshot store; and the fixture engine had no `session/load` arm at
/// all, so no test could have asked this question here. That is how a shipped feature — 「重开会话,
/// 看见那段对话」 — could be false while everything was green.
///
/// What this covers: the load is served through the real command, the engine's replayed frames reach
/// the log the snapshot is read from, and the snapshot carries both halves of the conversation.
/// What it does *not* cover, and cannot: the panel. Nothing here mounts a component or reads a
/// transcript out of pixels, and the engine is the fixture rather than the pinned binary — the
/// measured ordering is the fixture's, copied from the live measurement. The acceptance test for
/// those two links is the real window against the real engine.
#[tokio::test]
async fn a_reopened_session_hands_its_conversation_to_the_snapshot_a_panel_mounts_with() {
    let scratch = temp_dir("reopen");
    let capture = scratch.join("fixture.capture");
    let wired = wired_at("reopen-engine", "replay", None, Some(&capture)).await;

    let loaded = agent_load_session(
        wired.vaults(),
        wired.ipc(),
        "vault-1".to_string(),
        rooted(&wired.vault_root),
        "ses_fake_1".to_string(),
    )
    .await
    .expect("the fixture engine serves the load it replayed");
    assert_eq!(loaded.session_id, "ses_fake_1");

    // What the engine itself says it sent, read out of its own record rather than inferred from
    // the host's silence — the difference between "the host dropped it" and "nothing was sent".
    let sent = fs::read_to_string(&capture).expect("the fixture's record of the load");
    assert!(
        sent.contains("load-replay-sent=user+thought+answer"),
        "the fixture must have sent the replay this test is about: {sent}"
    );
    assert!(
        sent.contains("load-response=after-replay"),
        "and the measured ordering is the one under test: the replay first, the response last: \
         {sent}"
    );

    // The window's own handshake, one frame of it: the snapshot the panel takes before it
    // subscribes. This is the value the whole feature turns on.
    let snapshot = agent_session_snapshot(wired.ipc(), loaded.session_id.clone())
        .await
        .expect("a loaded session has a snapshot");
    let kinds: Vec<AgentEventKind> = snapshot.events.iter().map(|event| event.kind).collect();
    let text: String = snapshot
        .events
        .iter()
        .filter_map(|event| event.payload["text"].as_str())
        .collect();
    eprintln!(
        "--- after the load: state={:?} run={:?} sequence={} kinds={kinds:?} text={text:?}",
        snapshot.state, snapshot.run_id, snapshot.sequence
    );

    assert!(
        snapshot
            .events
            .iter()
            .any(|event| event.kind == AgentEventKind::TextDelta),
        "the restored answer is not in the snapshot a mounting panel is given, so the load's \
         replay never reached the log: {kinds:?}"
    );
    assert!(
        snapshot
            .events
            .iter()
            .any(|event| event.kind == AgentEventKind::UserDelta),
        "the restored *user* turn is not in the snapshot either: {kinds:?}"
    );
    assert!(
        text.contains("pong"),
        "the restored answer's text: {text:?}"
    );
    assert!(
        text.contains("ping"),
        "the restored prompt's text: {text:?}"
    );
    assert!(
        snapshot
            .events
            .iter()
            .filter(|event| event.kind == AgentEventKind::UserDelta
                || event.kind == AgentEventKind::TextDelta)
            .all(|event| event
                .run_id
                .as_deref()
                .is_some_and(|run| run.starts_with("load-"))),
        "a replayed frame the window can draw carries the load's own run: {:?}",
        snapshot
            .events
            .iter()
            .map(|event| (event.kind, event.run_id.clone()))
            .collect::<Vec<_>>()
    );

    // The same frames on the window's channel: the half for a window that was already listening.
    let received = wired.received.lock().unwrap().clone();
    assert!(
        received
            .iter()
            .any(|event| event.kind == AgentEventKind::UserDelta),
        "the replayed frames must be published, not only logged: {:?}",
        received
            .iter()
            .map(|event| event.kind)
            .collect::<Vec<AgentEventKind>>()
    );
}

/// The same chain, under the harsher ordering a real engine can produce: the whole replay and the
/// load's own response arriving in **one read**.
///
/// This is the one the fixture's byte-at-a-time `replay` cannot reach. The host's dispatcher runs
/// on its own task and drains the engine's notifications one at a time, while the task that awaits
/// the response resumes the instant the response is parsed — so the frames that are still in the
/// queue when the response lands are the question. One write puts every frame there at once.
///
/// Asserted as a count rather than as a shape: the conversation must be *complete* in the snapshot a
/// panel mounts with, and a count is what says so — a snapshot holding 3 of 200 frames draws a
/// conversation that is wrong in a way no kind-list would show.
#[tokio::test]
async fn a_replay_that_arrived_with_the_load_response_is_still_in_the_snapshot() {
    let scratch = temp_dir("burst");
    let capture = scratch.join("fixture.capture");
    let wired = wired_at("burst-engine", "replay-burst", None, Some(&capture)).await;

    let loaded = agent_load_session(
        wired.vaults(),
        wired.ipc(),
        "vault-1".to_string(),
        rooted(&wired.vault_root),
        "ses_fake_1".to_string(),
    )
    .await
    .expect("the fixture engine serves the load it replayed");

    let sent = fs::read_to_string(&capture).expect("the fixture's record of the load");
    // 200, and the number is read back out of the fixture's own record rather than assumed: the
    // test has to know how many it is owed, and a constant here would be a second answer to a
    // question the fixture already answered.
    assert!(
        sent.contains("load-response=in-the-same-write"),
        "the burst ordering is the one under test: {sent}"
    );

    let snapshot = agent_session_snapshot(wired.ipc(), loaded.session_id.clone())
        .await
        .expect("a loaded session has a snapshot");
    let replayed = snapshot
        .events
        .iter()
        .filter(|event| event.kind == AgentEventKind::TextDelta)
        .count();
    let published = wired
        .received
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event.kind == AgentEventKind::TextDelta)
        .count();
    eprintln!(
        "--- burst: {} of 200 replayed frames reached the snapshot, {published} were published \
         (state={:?} run={:?})",
        replayed, snapshot.state, snapshot.run_id
    );

    // Time does not repair this, which is what makes the assertion above the right one rather than
    // a race the test happens to lose: a frame dropped by the run guard is gone from both places,
    // and the measured failure was exactly that — the snapshot and the window's channel agreeing
    // on a conversation with 72 frames missing from the middle of it.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let published_later = wired
        .received
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event.kind == AgentEventKind::TextDelta)
        .count();
    assert_eq!(
        published_later, 200,
        "the frames the load's own response raced must still be published, not merely absent \
         from the snapshot: {published_later} reached the window's channel"
    );
    assert_eq!(
        replayed, 200,
        "every frame the engine replayed before its own response belongs to the restored \
         conversation, and the snapshot a panel mounts with is the only place it can come \
         from: {replayed} of 200 arrived, and the rest were discarded by this host"
    );
}
