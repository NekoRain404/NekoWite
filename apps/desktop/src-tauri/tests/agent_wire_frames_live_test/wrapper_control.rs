//! The wrapper's control: both directions recorded, the handshake unchanged.
//!
//! `session/new` reaches no provider and needs no credential, which is what makes this case the
//! control that lets the paying cases' transcripts be evidence about the engine rather than about
//! the wrapper. Run it first for that reason.

use std::fs;
use std::time::Duration;

use nekowite_lib::agent_runtime::{client_capabilities, FsRequest, PermissionRequest};

use crate::frames::collect;
use crate::harness::{artifact, one_turn_at_a_time, scratch, servant, start, unused, CALL_BOUND};

/// The wrapper records both directions without changing the handshake — and costs no prompt.
///
/// Run this first: it is the control that makes the paying test's transcript evidence about the
/// engine rather than about the wrapper. `session/new` needs no credential (P0 §2.2) and nothing
/// here reaches a provider.
#[tokio::test]
async fn the_wrapper_records_both_directions_without_changing_the_handshake() {
    let _one_at_a_time = one_turn_at_a_time().lock().await;
    let Some(artifact) = artifact() else { return };
    let root = scratch("wrapper-control");
    let workspace = root.join("workspace");
    fs::create_dir_all(&workspace).expect("workspace");

    let mut live = start(&artifact, "", &root).await;
    let _servant = servant(
        std::mem::replace(&mut live.permissions, unused::<PermissionRequest>()),
        std::mem::replace(&mut live.fs, unused::<FsRequest>()),
    );
    let initialized = live
        .connection
        .initialize(CALL_BOUND)
        .await
        .expect("the engine initializes through the wrapper");
    eprintln!("handshake: {initialized:?}");
    eprintln!(
        "the host advertises: {}",
        serde_json::to_value(client_capabilities()).expect("capabilities serialize")
    );

    let opened = live
        .connection
        .new_session(&workspace, CALL_BOUND)
        .await
        .expect("session/new through the wrapper");
    eprintln!("session/new: {}", opened.session_id);

    // The engine announces its command list right after `session/new` (P0 §2.2). Reading until
    // the clock runs out is what proves the transcript's pipes are live rather than merely made.
    let (frames, counts) = collect(&mut live.updates, Duration::from_secs(10)).await;
    eprintln!(
        "--- after session/new: {} frame(s) {counts:?}",
        frames.len()
    );

    let to_engine = fs::read_to_string(live.wire.join("to-engine.jsonl")).expect("outbound");
    let from_engine = fs::read_to_string(live.wire.join("from-engine.jsonl")).expect("inbound");
    for (direction, body) in [("us -> engine", &to_engine), ("engine -> us", &from_engine)] {
        eprintln!("--- {direction}: {} line(s)", body.lines().count());
    }

    assert!(
        to_engine.contains("\"method\":\"initialize\"")
            && to_engine.contains("\"method\":\"session/new\""),
        "the outbound transcript does not hold the calls this test made, so it is not recording: \
         {} line(s)",
        to_engine.lines().count()
    );
    assert!(
        from_engine.contains("\"session/new\"") || from_engine.contains("\"sessionUpdate\""),
        "the inbound transcript holds nothing the engine said, so the second tee is not wired: {} \
         line(s)",
        from_engine.lines().count()
    );
    // What the handshake buys is the session and its options; a wrapper that had changed the
    // framing would show up as an answer with neither.
    assert!(
        opened
            .config_options
            .as_ref()
            .is_some_and(|options| !options.is_empty()),
        "the engine answered `session/new` through the wrapper with no configuration options, so \
         the wrapper is not transparent to the conversation"
    );

    live.connection.shutdown();
}
