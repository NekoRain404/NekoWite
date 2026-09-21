//! The headline this target exists for: a real permission frame, through our runtime, answered by
//! our code, with the engine's own option id in the answer — an id only our table could have picked
//! out of the three.
//!
//! One test and one file, because the test's own comment explains why the capture file rather than a
//! successful call is the evidence. What the renderer was shown before that answer is `prompt.rs`.

use serde_json::json;

use nekowite_lib::commands::agent::apply_permission_answer;

use crate::support::{answered_once, ask, refused_and_silent};

// --- The proof that our handler answered ---

#[tokio::test]
async fn our_handler_answers_the_engines_permission_request() {
    // The one test this task exists for: a real permission frame, through our runtime, answered by
    // our code, with the engine's own option id in the answer — an id only our table could have
    // picked out of the three.
    let asked = ask("answers", true).await;

    // The negative control, before any answer exists: the engine is blocking on this request and
    // nothing has answered it. If the SDK were replying on our behalf — the failure that made three
    // earlier tests pass for the wrong reason — this is the assertion that would fail.
    refused_and_silent(&asked.capture).await;

    apply_permission_answer(&asked.table, asked.answer("always")).expect("the engines own option");
    answered_once(
        &asked.capture,
        json!({ "outcome": "selected", "optionId": "always" }),
    )
    .await;
    assert!(asked.table.pending().is_empty(), "the prompt is over");
    asked.runtime.shutdown();
}
