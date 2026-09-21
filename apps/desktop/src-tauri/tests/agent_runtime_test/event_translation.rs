//! The engine's frames as the host's events: a thought chunk of its own kind, an update with no kind
//! here dropped rather than fatal, three tool-call frames correlated into one row, and the usage
//! object published counter by counter.
//!
//! `events.rs` is the one place the translation happens, and every case here fails when it turns one
//! frame into the wrong host vocabulary — reasoning folded into answer text, a schema detail leaking
//! to a component, a counter dropped or invented. The run's state machine is `runs.rs`'s, and the
//! two were one heading in the file this was split out of.

use std::path::Path;

use nekowite_lib::agent_runtime::AgentEventKind;

use crate::support::{events_until, fixture, start, texts};

#[tokio::test]
async fn a_thought_chunk_reaches_the_host_as_its_own_kind() {
    // The fixture emits an `agent_thought_chunk` between the text chunks — P0 §2.3's measured
    // order. It arrives as `thought-delta`, the contract's own kind for it, and *not* as answer
    // text: §5.1 forbids inventing reasoning, and folding the engine's own disclosure into
    // `text-delta` would put "thinking" on the answer's side of the timeline, which is the one
    // thing the separation exists to prevent.
    let (runtime, mut events) = start(&fixture("good", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    runtime
        .prompt(&session.session_id, "hello", &[])
        .expect("prompt");
    let events = events_until(&mut events, |event| {
        event.kind == AgentEventKind::RunFinished
    })
    .await;

    let thoughts: Vec<&str> = events
        .iter()
        .filter(|event| event.kind == AgentEventKind::ThoughtDelta)
        .filter_map(|event| event.payload.get("text")?.as_str())
        .collect();
    assert_eq!(
        thoughts,
        vec!["thinking"],
        "the engine's reasoning channel arrives"
    );
    assert!(
        !texts(&events).iter().any(|text| text.contains("thinking")),
        "reasoning must not be rendered as answer text"
    );
    // And nothing arrived as a kind the contract cannot read: the full set of what this turn
    // published is these four, which is what a component switches on.
    assert!(events
        .iter()
        .all(|event| event.kind == AgentEventKind::TextDelta
            || event.kind == AgentEventKind::ThoughtDelta
            || event.kind == AgentEventKind::CommandsChanged
            || event.kind == AgentEventKind::RunFinished));
    runtime.shutdown();
}

#[tokio::test]
async fn an_update_with_no_kind_here_is_dropped_rather_than_failing_the_turn() {
    // The engine sends a `sessionUpdate` this version's schema does not name, in the middle of a
    // turn. Two rules have to hold at once, and §6.2 states both: the frame must not reach a
    // component as a mystery blob (`normalize_update`'s `_` arm is where that is decided), and it
    // must not take the turn down with it — the turn is the engine's, the frame is one this host
    // has no kind for, and a reader that fails a run over a frame it does not understand reports
    // the engine's work as this window's fault.
    //
    // What the frame *does* on the way in is the pinned schema's decision, not this fixture's:
    // `SessionUpdate` has no `Other` arm, so the SDK refuses to deserialize the notification at
    // all. Both routes end in the same place for the host — nothing published for it — and the
    // assertion that matters is the same either way: the turn ends exactly where the fixture
    // always ends it, and every kind that reached the window is one a component can render.
    let (runtime, mut events) = start(&fixture("unknown-update", None)).await;
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

    assert_eq!(
        texts(&events),
        vec!["first"],
        "the turn is the one the fixture plays"
    );
    let last = events.last().expect("a run-finished event");
    assert_eq!(last.run_id.as_deref(), Some(run_id.as_str()));
    assert_eq!(
        last.payload["stopReason"], "end-turn",
        "an update with no kind here is not a reason to fail the turn"
    );
    assert!(
        events
            .iter()
            .all(|event| event.kind == AgentEventKind::TextDelta
                || event.kind == AgentEventKind::ThoughtDelta
                || event.kind == AgentEventKind::CommandsChanged
                || event.kind == AgentEventKind::RunFinished),
        "only kinds a component can render reached the window: {:?}",
        events.iter().map(|event| event.kind).collect::<Vec<_>>()
    );
    runtime.shutdown();
}

#[tokio::test]
async fn a_tool_calls_three_frames_arrive_correlated_and_in_order() {
    // P0 §6.1's measured sequence, through the whole runtime: a `tool_call` (pending) and two
    // `tool_call_update`s (in_progress, completed) for one `toolCallId`. Three claims, and each
    // one is a requirement the scan states rather than a detail of the fixture:
    //
    //  - all three reach the host (neither wire type falls into a catch-all),
    //  - they are one host kind, `tool-update`, so a consumer updates a row instead of adding one,
    //  - the id that correlates them and the status order that says how the call progressed are
    //    both intact, which is what lets the panel draw one evolving row.
    let (runtime, mut events) = start(&fixture("tools", None)).await;
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

    let calls: Vec<&serde_json::Value> = events
        .iter()
        .filter(|event| event.kind == AgentEventKind::ToolUpdate)
        .map(|event| {
            event
                .payload
                .get("update")
                .expect("the schema's frame, wrapped")
        })
        .collect();
    assert_eq!(
        calls.len(),
        3,
        "one frame per measured update, none dropped"
    );

    let ids: Vec<&str> = calls
        .iter()
        .filter_map(|call| call.get("toolCallId")?.as_str())
        .collect();
    assert_eq!(
        ids,
        vec!["call_fake_1"; 3],
        "toolCallId is the key that ties the three frames to one call"
    );
    let statuses: Vec<Option<&str>> = calls
        .iter()
        .map(|call| call.get("status").and_then(|status| status.as_str()))
        .collect();
    // The engine's own statuses, in the order it sent them — `None` for the first one because
    // `pending` is the schema's default and serde skips a default when the frame is re-encoded
    // (`ToolCallStatus::is_default`, `skip_serializing_if`). That absence is not a hole: the
    // schema's own default is what it means, and the window reads it that way (`tauri-agent/
    // tools.ts`: `toolStatus(...) ?? prior?.status ?? 'pending'`). Pinned here because it is the
    // reason that fallback is load-bearing rather than decorative.
    assert_eq!(
        statuses,
        vec![None, Some("in_progress"), Some("completed")],
        "pending → in_progress → completed, with `pending` spelled as the schema's default"
    );
    assert_eq!(
        calls[0].get("locations"),
        None,
        "the first frame's empty location list is skipped the same way (`Vec::is_empty`)"
    );

    // Every one of the three belongs to the turn that started the call, which is what stamps the
    // row's run and what lets only that turn's frames settle it.
    assert!(events
        .iter()
        .filter(|event| event.kind == AgentEventKind::ToolUpdate)
        .all(|event| event.run_id.as_deref() == Some(run_id.as_str())));
    runtime.shutdown();
}

#[tokio::test]
async fn the_usage_the_engine_reported_is_published_field_by_field() {
    // P0 §6.3's second measured turn: `cachedReadTokens` where the first turn had
    // `thoughtTokens`, and a `totalTokens` (8895) that is not the sum of input + output. Neither
    // number is ours to compute or to default, so what the host publishes is the engine's object,
    // in the engine's own numbers.
    let (runtime, mut events) = start(&fixture("cached-usage", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    runtime
        .prompt(&session.session_id, "hello", &[])
        .expect("prompt");
    let events = events_until(&mut events, |event| {
        event.kind == AgentEventKind::RunFinished
    })
    .await;

    let usage = &events.last().expect("a run-finished event").payload["usage"];
    assert_eq!(usage["inputTokens"], 1721);
    assert_eq!(usage["outputTokens"], 6);
    assert_eq!(
        usage["totalTokens"], 8895,
        "the engine's own total, never a sum"
    );
    assert_eq!(usage["cachedReadTokens"], 7168);
    assert!(
        usage.get("thoughtTokens").is_none(),
        "the field the engine did not send must not appear with a made-up value: {usage}"
    );
    runtime.shutdown();
}

#[tokio::test]
async fn a_usage_missing_a_core_field_still_reports_the_counters_it_sent() {
    // The pinned schema's own `Usage` is what P0 §6.3 warns about: `totalTokens`, `inputTokens`
    // and `outputTokens` are non-optional `u64`s there, and `PromptResponse.usage` is read with
    // `DefaultOnError`, so an engine that sends a thinner object has the whole usage dropped
    // during deserialization. The fixture's object omits `totalTokens` and keeps the rest, and
    // what this pins is both halves of the rule that governs it:
    //
    //  - the counters the engine *did* send are published as the engine's own numbers, which is
    //    the half that used to be thrown away — `usage: null` said "not provided" about usage
    //    that was provided in part;
    //  - the field it did not send stays absent — never `0`, and never a sum standing in for a
    //    total the engine never reported (1721 + 6 is not a number this host may publish here);
    //  - and the turn still ends normally either way: a decorative count never decides that a
    //    finished turn failed.
    let (runtime, mut events) = start(&fixture("thin-usage", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    runtime
        .prompt(&session.session_id, "hello", &[])
        .expect("prompt");
    let events = events_until(&mut events, |event| {
        event.kind == AgentEventKind::RunFinished
    })
    .await;

    let last = events.last().expect("a run-finished event");
    assert_eq!(
        last.payload["stopReason"], "end-turn",
        "the turn still ended normally"
    );
    let usage = &last.payload["usage"];
    assert_eq!(
        usage["inputTokens"], 1721,
        "a counter the engine sent must reach the window, not be dropped with the object"
    );
    assert_eq!(usage["outputTokens"], 6);
    assert_eq!(
        usage["cachedReadTokens"], 7168,
        "an optional counter travels the same way: reading only the schema's three required \
         fields is not enough to keep what the engine reported"
    );
    assert!(
        usage.get("totalTokens").is_none(),
        "the field the engine did not send must not appear with a made-up value: {usage}"
    );
    assert!(
        usage.get("thoughtTokens").is_none(),
        "nor may a counter this behaviour never sends be invented: {usage}"
    );
    runtime.shutdown();
}
