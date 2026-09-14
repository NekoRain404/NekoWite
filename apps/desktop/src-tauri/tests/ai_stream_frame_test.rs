//! What makes an SSE frame an error at all.
//!
//! `Value::get` answers `Some(&Value::Null)` for a key that is present with a
//! null value, so "the frame has an `error` field" is not the same statement as
//! "the frame reports an error". A frame whose only sin is carrying the field —
//! `{"error": null, "choices":[…]}` — used to be classified as a failure, given
//! the generic message, and returned as `ProviderError` for the whole chunk: a
//! healthy answer taken down by a field that says nothing.
//!
//! The rule these tests pin is *what the field says*, not *that it is there*: a
//! frame is an error when it carries a message that is not blank, when its
//! `error` object names a `type`, or when it is Anthropic's `type: "error"`.
//! Anything else keeps its deltas.

use nekowite_lib::providers::ai::client::{parse_sse_event, CompletionStream, StreamEvent};

fn error_of(line: &str, provider: &str) -> Option<String> {
    let mut acc = String::new();
    parse_sse_event(line, provider, &mut acc).and_then(|delta| delta.error)
}

/// A null `error` field is a field that says nothing: the frame is a normal
/// delta and its text belongs to the answer.
#[test]
fn a_null_error_field_is_not_an_error() {
    let mut acc = String::new();
    let line = r#"data: {"error":null,"choices":[{"delta":{"content":"hello"}}]}"#;

    let delta = parse_sse_event(line, "openai", &mut acc).expect("a healthy frame is a delta");

    assert_eq!(
        delta.error, None,
        "a null error field was read as a failure report"
    );
    assert_eq!(delta.text.as_deref(), Some("hello"));
    assert_eq!(acc, "hello", "the text must reach the answer accumulator");
}

/// The same statement spelled as an empty object (or an empty string): present,
/// but carrying nothing to report.
#[test]
fn an_empty_error_value_is_not_an_error() {
    for line in [
        r#"data: {"error":{},"choices":[{"delta":{"content":"hi"}}]}"#,
        r#"data: {"error":"","choices":[{"delta":{"content":"hi"}}]}"#,
        r#"data: {"error":"   ","choices":[{"delta":{"content":"hi"}}]}"#,
    ] {
        let mut acc = String::new();
        let delta = parse_sse_event(line, "openai", &mut acc)
            .unwrap_or_else(|| panic!("frame was dropped: {line}"));
        assert_eq!(
            delta.error, None,
            "an empty error value must not fail: {line}"
        );
        assert_eq!(delta.text.as_deref(), Some("hi"), "{line}");
    }
}

/// The consequence as the stream loop sees it: a whole chunk whose only
/// irregularity is the null field still delivers its text instead of aborting
/// the completion.
#[test]
fn a_chunk_with_a_null_error_field_still_delivers_its_text() {
    let mut stream = CompletionStream::new("openai");

    let events = stream
        .feed(b"data: {\"error\":null,\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n")
        .expect("the frame is under every ceiling");

    assert_eq!(
        events,
        vec![StreamEvent::Text("hi".into())],
        "the chunk must not be reported as a provider error"
    );
    assert_eq!(stream.answer(), "hi");
}

/// The rule must not be widened into silence: every spelling that DOES report a
/// failure stays a failure, including the message-less `error.type` an
/// OpenAI-compatible gateway sends and Anthropic's `type: "error"` frame.
#[test]
fn a_frame_that_says_something_is_still_an_error() {
    for (line, provider) in [
        (
            r#"data: {"error":{"message":"rate limit exceeded"}}"#,
            "openai",
        ),
        (r#"data: {"error":{"type":"server_error"}}"#, "openai"),
        (r#"data: {"error":"upstream disconnected"}"#, "deepseek"),
        (
            r#"data: {"type":"error","message":"overloaded_error"}"#,
            "anthropic",
        ),
        (
            r#"data: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}"#,
            "anthropic",
        ),
    ] {
        let message = error_of(line, provider)
            .unwrap_or_else(|| panic!("a failure report was swallowed: {line}"));
        assert!(
            !message.trim().is_empty(),
            "the user must be told something: {line}"
        );
    }
}

/// Anthropic's `type: "error"` is the signal itself, so an `error` value that
/// says nothing must not turn that frame back into a healthy one.
#[test]
fn an_anthropic_error_frame_with_an_empty_error_object_is_still_an_error() {
    let message = error_of(r#"data: {"type":"error","error":{}}"#, "anthropic")
        .expect("the frame type is the error signal");

    assert!(message.contains("错误"), "got: {message}");
}
