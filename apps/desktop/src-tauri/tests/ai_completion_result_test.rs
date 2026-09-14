//! When a finished completion is a result the user can use, and when the only
//! honest answer is an explanation.
//!
//! Three of these cases were already handled (a truncated answer with text in
//! it, a content filter, an answer-less completion that reasoned) and one was
//! not: `finish_reason: "length"` with nothing to show. The empty answer was
//! carved out of the truncation branch, so a completion the provider cut off
//! before it produced a single character reached the `ai-done` success path
//! with `full: ""` — a silent no-op, where the comment on that branch says
//! saying so "matters more than the answer itself".
//!
//! Each case is built the way the stream loop builds it: by folding the frames
//! a provider actually sends, so what is decided here is decided on the same
//! state the loop holds when it asks.

use nekowite_lib::providers::ai::client::{completion_refusal, CompletionStream};

fn stream_from(frames: &[&str]) -> CompletionStream {
    let mut stream = CompletionStream::new("openai");
    for frame in frames {
        let mut bytes = frame.as_bytes().to_vec();
        bytes.push(b'\n');
        stream.feed(&bytes).expect("the frame is under the ceiling");
    }
    stream
}

/// The provider ran out of output budget before writing a single character.
fn truncated_to_nothing() -> CompletionStream {
    stream_from(&[r#"data: {"choices":[{"delta":{},"finish_reason":"length"}]}"#])
}

/// A completion truncated to nothing is a truncation like any other.
#[test]
fn a_completion_truncated_to_nothing_is_reported_as_a_failure() {
    let stream = truncated_to_nothing();

    assert_eq!(stream.answer(), "", "the case under test has no answer");
    let message = completion_refusal(&stream)
        .expect("an answer the provider cut off must be reported, not reported as done");

    assert!(
        message.contains("最大输出 Tokens"),
        "the explanation must name the setting to change: {message}"
    );
}

/// The cases the code already had, pinned so the new one cannot be added by
/// loosening them.
#[test]
fn the_reported_cases_that_already_existed_still_report() {
    let truncated_with_text = stream_from(&[
        r#"data: {"choices":[{"delta":{"content":"half an "},"finish_reason":"length"}]}"#,
    ]);
    let message = completion_refusal(&truncated_with_text)
        .expect("a truncated answer with text is still a fragment");
    assert!(message.contains("最大输出 Tokens"), "{message}");

    let filtered = stream_from(&[
        r#"data: {"choices":[{"delta":{"content":"suppressed"},"finish_reason":"content_filter"}]}"#,
    ]);
    let message =
        completion_refusal(&filtered).expect("a filtered answer is not a normal completion");
    assert!(message.contains("content_filter"), "{message}");

    // A reasoning model that spent the whole budget thinking gets the more
    // specific explanation, whichever reason the provider stopped with.
    for reason in ["length", "stop"] {
        let reasoned = stream_from(&[
            r#"data: {"choices":[{"delta":{"reasoning_content":"thinking…"}}]}"#,
            &format!(r#"data: {{"choices":[{{"delta":{{}},"finish_reason":"{reason}"}}]}}"#),
        ]);
        let message = completion_refusal(&reasoned)
            .unwrap_or_else(|| panic!("an answer-less reasoning turn must be explained: {reason}"));
        assert!(
            message.contains("推理"),
            "the reasoning case has its own message: {message}"
        );
    }
}

/// A completion that ended normally is not a failure: a normal answer with text
/// stays a success, and the empty answer of an ordinary turn is reported as it
/// always was.
#[test]
fn an_ordinary_completion_is_not_a_failure() {
    let answered = stream_from(&[
        r#"data: {"choices":[{"delta":{"content":"the answer"},"finish_reason":"stop"}]}"#,
    ]);
    assert_eq!(completion_refusal(&answered), None);

    let answered_without_a_reason =
        stream_from(&[r#"data: {"choices":[{"delta":{"content":"the answer"}}]}"#]);
    assert_eq!(completion_refusal(&answered_without_a_reason), None);

    let empty_turn = stream_from(&[r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#]);
    assert_eq!(
        completion_refusal(&empty_turn),
        None,
        "an empty answer with no truncation and no reasoning is a no-op, not an error"
    );
}
