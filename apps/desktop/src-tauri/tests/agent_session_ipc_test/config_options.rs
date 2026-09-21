//! The engine's own configuration options: the list a caller is answered with, and the frame a
//! window is notified with when one of them moves.
//!
//! A config change has two producers and these cases assert both, because a change belongs to the
//! session and not to a turn — including the one that arrives mid-turn.

use nekowite_lib::agent_runtime::events::AgentEventKind;
use nekowite_lib::agent_runtime::snapshot::SessionState;
use nekowite_lib::commands::agent::{agent_prompt, agent_set_config_option};

use crate::support::{open, wait_for_event, wait_for_state, wired};

#[tokio::test]
async fn the_engines_own_options_reach_both_the_caller_and_the_window() {
    // A config change has two producers and this asserts both, because they answer different
    // halves of the same requirement: the *command's* answer is the engine's refreshed list, so a
    // caller never has to guess the new state or wait for an event to learn it (the reason Zed's
    // `set_config_option` answers the list), while the *notification* is the only route a change
    // the host did not ask for can travel on.
    //
    // A turn runs first, and deliberately: it leaves the session holding a run that has already
    // ended, which is the state a run-gated forwarder would swallow a session-scoped frame in —
    // and switching a model between turns is exactly when a user does it.
    let wired = wired("config", "config-update", None).await;
    let opened = open(&wired).await;
    agent_prompt(
        wired.app.handle().clone(),
        wired.ipc(),
        opened.session_id.clone(),
        "hello".to_string(),
        None,
    )
    .await
    .expect("a turn");
    wait_for_state(wired.ipc(), &opened.session_id, SessionState::Completed).await;

    let options = agent_set_config_option(
        wired.ipc(),
        opened.session_id.clone(),
        "model".to_string(),
        "fake/model-b".to_string(),
    )
    .await
    .expect("the engine moves one of its own options");

    // The engine's own list, in the shape `agent_open_session` answers the first one in: the
    // runtime stores it when it answers, so this is that value and not a second read of it.
    assert_eq!(options[0]["id"], "model");
    assert_eq!(options[0]["currentValue"], "fake/model-b");

    let event = wait_for_event(&wired, AgentEventKind::ConfigChanged).await;
    assert_eq!(
        event.session_id, opened.session_id,
        "the session the engine named"
    );
    assert_eq!(
        event.run_id, None,
        "a config change belongs to the session, not to a turn: the one above has already ended"
    );
    // The contract's payload — the shape `readConfigChanged` reads and no other.
    assert_eq!(event.payload["options"][0]["id"], "model");
    assert_eq!(event.payload["options"][0]["value"]["kind"], "select");
    assert_eq!(
        event.payload["options"][0]["value"]["current"],
        "fake/model-b"
    );
    assert_eq!(
        event.payload["options"][0]["value"]["choices"][1]["value"], "fake/model-b",
        "the choices come with the option, which is what a selector draws"
    );
}

#[tokio::test]
async fn a_config_change_during_a_turn_belongs_to_the_session_not_the_turn() {
    // §6.2's envelope defines `runId` as the generation an event belongs to, and a config change
    // belongs to none — including when it arrives while a turn is in flight, which is the case a
    // forwarder with only a run-scoped path gets wrong. The stamp matters twice: it would say the
    // fact belongs to a turn it outlives, and an unreadable run-scoped payload fails that turn on
    // the way to the window (`tauri-agent/frames.ts` reports one as `run-failed`).
    let wired = wired("mid-run", "config-mid-run", None).await;
    let opened = open(&wired).await;

    let run_id = agent_prompt(
        wired.app.handle().clone(),
        wired.ipc(),
        opened.session_id.clone(),
        "hello".to_string(),
        None,
    )
    .await
    .expect("a turn");

    let event = wait_for_event(&wired, AgentEventKind::ConfigChanged).await;
    assert_eq!(
        event.run_id, None,
        "a session fact carries no run, even mid-turn"
    );
    assert_eq!(
        event.payload["options"][0]["value"]["current"],
        "fake/model-b"
    );

    // The turn it arrived during is untouched: it reaches its own ending, and nothing here was
    // reported as a failure of it.
    let after = wait_for_state(wired.ipc(), &opened.session_id, SessionState::Completed).await;
    assert_eq!(after.run_id.as_deref(), Some(run_id.as_str()));
    let received = wired.received.lock().unwrap().clone();
    assert!(
        received
            .iter()
            .all(|frame| frame.kind != AgentEventKind::RunFailed),
        "a session-scoped frame must not be able to fail the turn it arrived in"
    );
}
