//! A session's life from the window's side: it is opened, a turn is run on it, and it is stopped.
//!
//! This is the path T4 could not deliver at all — `agent_open_session` builds an engine session and
//! `agent_prompt` starts a turn — and the teardown that has to leave nothing addressable behind.

use nekowite_lib::agent_runtime::events::{AgentEventKind, AgentFailureCode};
use nekowite_lib::agent_runtime::snapshot::SessionState;
use nekowite_lib::commands::agent::{agent_prompt, agent_session_snapshot, agent_stop};

use crate::support::{open, wait_for_state, wired};

#[tokio::test]
async fn a_window_opens_a_session_and_reads_the_turn_it_runs() {
    // The path T4 could not deliver: `agent_open_session` builds an engine session, the snapshot
    // describes it before anything has been asked, `agent_prompt` starts a turn, and the turn's
    // ending arrives as a frame rather than as the prompt's answer.
    let wired = wired("turn", "good", None).await;
    let opened = open(&wired).await;
    assert_eq!(opened.session_id, "ses_fake_1", "the engine's own id");
    assert_eq!(
        opened.model_option_id.as_deref(),
        Some("model"),
        "the adapter's answer, not the renderer's guess"
    );
    assert!(
        opened.config_options.is_array(),
        "the engine's own option list, as it came: {:?}",
        opened.config_options
    );

    let before = agent_session_snapshot(wired.ipc(), opened.session_id.clone())
        .await
        .expect("snapshot");
    assert_eq!(
        before.state,
        SessionState::Ready,
        "nothing has been asked of it yet"
    );
    assert_eq!(before.run_id, None);
    assert_eq!(before.identity.session_id, "ses_fake_1");
    assert_eq!(before.identity.vault_id, "vault-1");
    assert!(
        !before.identity.runtime_epoch.is_empty(),
        "the epoch is minted, not guessed"
    );

    let run_id = agent_prompt(
        wired.app.handle().clone(),
        wired.ipc(),
        opened.session_id.clone(),
        "hello".to_string(),
        None,
    )
    .await
    .expect("a prompt starts a turn");
    assert_eq!(run_id, "run-0", "the host's own name for the work");

    let after = wait_for_state(wired.ipc(), &opened.session_id, SessionState::Completed).await;
    assert_eq!(
        after.run_id.as_deref(),
        Some("run-0"),
        "the turn it is looking at"
    );
    assert!(
        after.sequence > before.sequence,
        "the stream moved: {} -> {}",
        before.sequence,
        after.sequence
    );
    // The tail a caller's snapshot is continued from: everything this session published, in the
    // runtime's own order, under the sequences it published them with.
    let kinds: Vec<AgentEventKind> = after.events.iter().map(|event| event.kind).collect();
    assert!(kinds.contains(&AgentEventKind::TextDelta), "{kinds:?}");
    assert_eq!(
        kinds.last(),
        Some(&AgentEventKind::RunFinished),
        "the ending is the last thing this session published: {kinds:?}"
    );
    assert!(
        after
            .events
            .windows(2)
            .all(|pair| pair[0].sequence < pair[1].sequence),
        "the replay is ordered by the host's own sequence"
    );

    // And the same frames reached the window's channel: the half the snapshot cannot serve, for a
    // window that was already listening.
    let received = wired.received.lock().unwrap().clone();
    assert!(
        received
            .iter()
            .any(|event| event.kind == AgentEventKind::RunFinished),
        "the ending must be published, not only replayed"
    );
    assert!(received
        .iter()
        .all(|event| event.session_id == opened.session_id));
    assert!(received
        .iter()
        .any(|event| event.sequence == after.sequence));
}

#[tokio::test]
async fn stopping_empties_the_state_and_ends_the_session() {
    // `agent_stop` takes the session out before the engine goes, so no command can address a
    // runtime whose process is being torn down — and a call afterwards is refused with a sentence
    // naming the condition, not with a failure from inside the transport.
    let wired = wired("stop", "good", None).await;
    let opened = open(&wired).await;
    assert!(wired.ipc().session().is_ok(), "a session is running");

    agent_stop(wired.app.handle().clone(), wired.runtime(), wired.ipc())
        .await
        .expect("stopping a running session is not an error");

    assert!(wired.ipc().session().is_err(), "and now nothing is running");
    assert!(
        wired.runtime().instance.lock().unwrap().is_none(),
        "the instance is gone with it: the registration is free for the next start"
    );
    let refusal = agent_session_snapshot(wired.ipc(), opened.session_id)
        .await
        .expect_err("there is no session to snapshot");
    // `runtime-unavailable` is the code the contract's own adapter answers the same fact with when
    // the window refuses before reaching the backend (`tauri-agent.ts`'s `runtime === null` arms),
    // so a caller sees one word for "nothing is running" whichever side said it.
    assert_eq!(refusal.code, AgentFailureCode::RuntimeUnavailable);
    assert!(
        refusal.message.contains("no agent session is running"),
        "{refusal:?}"
    );
}
