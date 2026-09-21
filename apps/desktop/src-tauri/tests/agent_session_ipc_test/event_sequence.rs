//! The numbering the whole stream is read by: a runtime's first frame is 1, and every frame after
//! it is the next number.
//!
//! Two other modules state this as an assumption — the pet's `FrameOrder::off_stream` and the
//! notification ledger's `fact.sequence != 0` branch — so this file is where it is measured over the
//! real runtime instead of assumed.

use nekowite_lib::agent_runtime::events::AgentEventKind;
use nekowite_lib::commands::agent::agent_prompt;

use crate::support::{open, wait_for_event, wired};

#[tokio::test]
async fn no_frame_a_runtime_publishes_carries_the_sequence_that_means_no_frame() {
    // The invariant two other modules are written against, over the real runtime: the pet's
    // `FrameOrder::off_stream` says "zero is the sequence no runtime ever assigns", and the
    // notification ledger branches on `fact.sequence != 0` to tell a fact the host reports from its
    // own view from a frame off the stream. Both statements were false while the emitter's counter
    // started at 0, and what that cost was not a label but the first frame of every session — the
    // command list, the only source of the `/` menu — dropped by any window that had taken its
    // snapshot a moment earlier. The test above is where that was measured; this one is where the
    // property it depends on is stated.
    //
    // Two things, and the second is why the first cannot simply be asserted about one frame: the
    // stream starts at 1, and every frame after it is the next number, because the number and the
    // queue position are taken together. A frame delivered below the one before it is read by every
    // consumer as a replay and dropped with no hole recorded — the silent loss §6.2's handshake
    // exists to make impossible — so the numbering has to hold for the whole stream, which is what
    // the window from `wired()` captures: the sink is installed before the session opens and
    // appends in delivery order, so what it holds is a prefix of the stream and not a sample of it.
    let wired = wired("numbering", "good", None).await;
    let opened = open(&wired).await;
    agent_prompt(
        wired.app.handle().clone(),
        wired.ipc(),
        opened.session_id.clone(),
        "hello".to_string(),
        None,
    )
    .await
    .expect("prompt");
    // Read once the ending has been published, so the frames checked are a whole turn's rather than
    // however many happened to have arrived.
    wait_for_event(&wired, AgentEventKind::RunFinished).await;

    let received = wired.received.lock().unwrap().clone();
    let numbering: Vec<u64> = received.iter().map(|event| event.sequence).collect();
    assert!(!numbering.is_empty(), "the turn published frames");
    assert_eq!(
        numbering[0], 1,
        "a stream starts at 1, so that 0 keeps meaning \"nothing has been published\": {numbering:?}"
    );
    assert!(
        numbering.windows(2).all(|pair| pair[0] + 1 == pair[1]),
        "every frame is numbered and delivered in one order: {numbering:?}"
    );
}
