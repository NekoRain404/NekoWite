//! The run state machine: a session's command list before any run, one generation at a time, the
//! ending it is allowed, and the cancellation race.
//!
//! What the engine's frames *become* is `event_translation.rs`'s; this file is about the state the
//! host is in while they arrive. Both halves were one heading ("Sessions and runs") in the file this
//! was split out of, and the seam is that these cases fail when a transition is wrong — a second
//! prompt queued, a cancelled run revived, an ending published twice — rather than when a frame is
//! mistranslated.

use std::path::Path;
use std::time::Duration;

use nekowite_lib::agent_runtime;
use nekowite_lib::agent_runtime::{AgentEventEnvelope, AgentEventKind, AgentRuntimeEvents};

use crate::support::{events_until, fixture, next_event, start, texts};

/// Collects everything that arrives within `within`, then stops.
async fn events_for(events: &mut AgentRuntimeEvents, within: Duration) -> Vec<AgentEventEnvelope> {
    let mut collected = Vec::new();
    let deadline = tokio::time::Instant::now() + within;
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, events.next_event()).await {
        collected.push(event);
    }
    collected
}

// ---------------------------------------------------------------------------
// Sessions and runs
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_session_reports_the_command_list_before_any_run() {
    let (runtime, mut events) = start(&fixture("good", None)).await;
    runtime.initialize().await.expect("initialize");

    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    // P0 §2.2: the command list follows as a notification, not in the response,
    // and it arrives with no run open.
    let event = next_event(&mut events).await;
    assert_eq!(event.kind, AgentEventKind::CommandsChanged);
    assert_eq!(event.session_id, session.session_id);
    assert!(event.run_id.is_none(), "a session event carries no run id");
    runtime.shutdown();
}

#[tokio::test]
async fn a_prompt_streams_text_and_ends_with_the_measured_stop_reason() {
    let (runtime, mut events) = start(&fixture("good", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    let run_id = runtime
        .prompt(&session.session_id, "hello", &[])
        .expect("prompt");
    let events = events_until(&mut events, |event| {
        event.kind == AgentEventKind::RunFinished
    })
    .await;

    assert_eq!(texts(&events), vec!["first"]);
    let last = events.last().expect("a run-finished event");
    assert_eq!(last.run_id.as_deref(), Some(run_id.as_str()));
    // The engine answers `end_turn` (the fixture sends the protocol's snake_case); what the host
    // publishes is the contract's spelling, so no reader on this side has to know both.
    assert_eq!(last.payload["stopReason"], "end-turn");
    assert!(
        last.payload.get("usage").is_some(),
        "the usage arrives with the result (P0 §2.3)"
    );
    runtime.shutdown();
}

#[tokio::test]
async fn a_turn_that_ends_for_a_reason_this_version_does_not_know_is_not_a_failure() {
    // The Rust half of the contract's tolerance for an unfamiliar ending, at the door a live
    // engine actually comes through. The fixture answers `budget_exceeded`, which the pinned
    // schema's `StopReason` does not enumerate: read through that enum alone the whole response is
    // refused, and the `Err` arm above publishes `run-failed`/`invalid-response` — a finished turn
    // shown to the user as a failure, the one outcome the ruling for this area forbids. What must
    // arrive instead is the ending the engine sent, under the contract's one spelling, carrying a
    // word the window reads as `unrecognised` rather than as a reason either side invented.
    let (runtime, mut events) = start(&fixture("unknown-stop-reason", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    let run_id = runtime
        .prompt(&session.session_id, "hello", &[])
        .expect("prompt");
    let events = events_until(&mut events, |event| {
        event.kind == AgentEventKind::RunFinished || event.kind == AgentEventKind::RunFailed
    })
    .await;

    let last = events.last().expect("one ending");
    assert_eq!(
        last.kind,
        AgentEventKind::RunFinished,
        "an unfamiliar reason must not be reported as a failed turn: {:?}",
        last.payload
    );
    assert_eq!(last.run_id.as_deref(), Some(run_id.as_str()));
    // The engine's own word, respelled `_` → `-` exactly as the five enumerated names are
    // (`wire_stop_reason`), so one spelling crosses the wire whatever the engine sent.
    assert_eq!(last.payload["stopReason"], "budget-exceeded");
    // And the counters it arrived with are not dropped with the word: P0 §2.3's own numbers.
    assert_eq!(last.payload["usage"]["inputTokens"], 11);
    assert!(
        events
            .iter()
            .all(|event| event.kind != AgentEventKind::RunFailed),
        "nothing about this turn may be published as a failure"
    );
    runtime.shutdown();
}

#[tokio::test]
async fn a_second_prompt_while_running_is_refused() {
    let (runtime, _events) = start(&fixture("stream", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");
    let run_id = runtime
        .prompt(&session.session_id, "first", &[])
        .expect("prompt");
    assert!(run_id.starts_with("run-"));

    let refused = runtime.prompt(&session.session_id, "second", &[]);

    assert!(
        matches!(
            refused,
            Err(agent_runtime::SessionError::RunInProgress { .. })
        ),
        "a second generation on one session must be refused, not queued: {refused:?}"
    );
    runtime.cancel(&session.session_id).await.expect("cancel");
    runtime.shutdown();
}

#[tokio::test]
async fn a_cancelled_run_drops_its_late_text_and_finishes_once() {
    let (runtime, mut events) = start(&fixture("stream", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    let run_id = runtime
        .prompt(&session.session_id, "hello", &[])
        .expect("prompt");
    // The fixture sends "first", then waits for the cancel before sending
    // "late" — the text that must not revive a stopped run (§6.2).
    let first = events_until(&mut events, |event| event.kind == AgentEventKind::TextDelta).await;
    assert_eq!(texts(&first), vec!["first"]);

    runtime.cancel(&session.session_id).await.expect("cancel");
    let after = events_for(&mut events, Duration::from_millis(1200)).await;

    assert_eq!(
        texts(&after),
        Vec::<String>::new(),
        "text for a cancelled run must not be forwarded"
    );
    let endings = after
        .iter()
        .filter(|event| event.kind == AgentEventKind::RunFinished)
        .count();
    assert_eq!(endings, 1, "a run ends exactly once");
    // Read off the ending rather than off the first frame: the thought chunk the engine sends
    // between the answer's chunks is a host event of its own now, and it is delivered before the
    // cancel (it is not text, so the assertion above is about the answer alone).
    let ending = after
        .iter()
        .find(|event| event.kind == AgentEventKind::RunFinished)
        .expect("the cancelled run still ends");
    assert_eq!(ending.run_id.as_deref(), Some(run_id.as_str()));
    assert_eq!(ending.payload["stopReason"], "cancelled");
    runtime.shutdown();
}

#[tokio::test]
async fn cancelling_an_idle_session_is_not_an_error() {
    // Stop can be pressed in the same instant the answer lands; reporting that
    // race as a fault would be reporting the user's own click as a bug.
    let (runtime, _events) = start(&fixture("good", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    runtime.cancel(&session.session_id).await.expect("cancel");
    runtime.shutdown();
}
