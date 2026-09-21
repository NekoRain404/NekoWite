//! The handshake and the frames around it: what `initialize` negotiates, and what the line reader
//! does with a write holding two frames, a character cut in half, a line that is not JSON, an id
//! nobody asked for, and a frame that never ends.
//!
//! The other way a stream ends — the engine dying — is `engine_exit.rs`'s, because the answer there
//! is a failure built from the engine's own last words rather than a frame the reader handles. Both
//! halves were one heading in the file this was split out of.

use std::path::Path;

use nekowite_lib::agent_runtime::AgentEventKind;

use crate::support::{fixture, next_event, start, PATIENCE};

// ---------------------------------------------------------------------------
// The handshake and the frames around it
// ---------------------------------------------------------------------------

#[tokio::test]
async fn initialize_negotiates_the_measured_protocol_version() {
    let (runtime, _events) = start(&fixture("good", None)).await;

    let response = runtime.initialize().await.expect("initialize");

    assert_eq!(response.protocol_version.as_u16(), 1);
    let info = response
        .agent_info
        .expect("the fixture reports an agentInfo, as P0 measured");
    assert_eq!(info.name, "FakeAgent");
    runtime.shutdown();
}

#[tokio::test]
async fn two_frames_in_one_write_are_both_handled() {
    // The fixture answers `session/new` and emits the command list in a single
    // write — the sequence P0 §2.2 measured. A reader that treats one read as
    // one message loses the second frame; the SDK's line framing must split
    // them, and both must be acted on.
    let (runtime, mut events) = start(&fixture("two-in-one", None)).await;
    runtime.initialize().await.expect("initialize");

    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");
    let event = next_event(&mut events).await;

    assert_eq!(event.kind, AgentEventKind::CommandsChanged);
    assert_eq!(event.session_id, session.session_id);
    runtime.shutdown();
}

#[tokio::test]
async fn utf8_split_across_reads_is_reassembled() {
    // The fixture writes half of a three-byte character, waits, then writes the
    // rest. Nothing may be decoded before the frame is whole.
    let (runtime, _events) = start(&fixture("split-utf8", None)).await;

    let response = runtime.initialize().await.expect("initialize");

    // The fixture's name IS the character whose bytes it cuts in half, so a
    // reader that decoded each read on its own would produce a replacement
    // character — or nothing — instead of this.
    assert_eq!(
        response.agent_info.expect("agentInfo").name,
        "\u{4e2d}",
        "the split frame must be joined before it is decoded"
    );
    runtime.shutdown();
}

#[tokio::test]
async fn a_line_that_is_not_json_does_not_end_the_session() {
    // stdout is protocol, so a non-JSON line there is a real violation; what it
    // must not be is fatal to the connection, which is still perfectly able to
    // answer the request that follows.
    let (runtime, _events) = start(&fixture("malformed", None)).await;

    let response = runtime.initialize().await.expect("initialize");

    assert_eq!(response.protocol_version.as_u16(), 1);
    runtime.shutdown();
}

#[tokio::test]
async fn a_response_for_an_unknown_id_is_discarded() {
    // A frame whose id matches no outstanding request (the SDK numbers its
    // requests with UUID strings) must not be delivered anywhere, and must not
    // end the connection: the request that follows is still answered.
    let (runtime, _events) = start(&fixture("unknown-id", None)).await;

    let response = runtime.initialize().await.expect("initialize");

    assert_eq!(response.protocol_version.as_u16(), 1);
    runtime.shutdown();
}

#[tokio::test]
async fn an_endless_frame_aborts_the_run_and_reports_the_bound() {
    // Nine megabytes with no newline. §6.2: exceeding the limit must abort the
    // run and report it, never buffer without limit and never drop the frame
    // quietly. The bound is ours, because `agent-client-protocol`'s `Lines` has
    // no maximum anywhere and its splitter grows until it finds a newline.
    let (runtime, _events) = start(&fixture("oversized", None)).await;

    let outcome = tokio::time::timeout(PATIENCE, runtime.initialize()).await;

    let error = outcome
        .expect("the bound must abort the run, not leave it hanging")
        .expect_err("an oversized frame must not be accepted as a message");
    // And it must say which limit it hit: "the connection closed" would send a
    // reader looking for a crash that never happened.
    let message = error.failure_message();
    assert!(
        message.contains("larger than"),
        "the failure must name the bound, got: {message}"
    );
    runtime.shutdown();
}
