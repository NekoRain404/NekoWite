//! What ends a stream: the in-band error frame, and the `finish_reason` that tells a
//! complete answer from a truncated one. Both are readings the caller has to act on
//! instead of treating the answer as finished.

use nekowite_lib::providers::ai::client::{parse_sse_event, CompletionStream, StreamEvent};

/// An error frame inside a 200 OK stream must surface as an error.
///
/// Providers send these when the request is rejected mid-generation (rate limit
/// hit on the first token, content policy, upstream failure). The parser used to
/// return `None` for them, so the partial answer flowed on as if complete and
/// `ai-done` fired — the user got a truncated reply with no indication anything
/// went wrong, and could insert it into a note believing it was the whole answer.
#[test]
fn sse_reports_in_band_errors() {
    let mut acc = String::new();
    let openai = parse_sse_event(
        r#"data: {"error":{"message":"rate limit exceeded","type":"rate_limit_error"}}"#,
        "openai",
        &mut acc,
    )
    .unwrap();
    let message = openai.error.expect("an error frame must be reported");
    assert!(message.contains("rate limit exceeded"));
    assert!(
        message.contains("rate_limit_error"),
        "the kind is kept: {message}"
    );
    assert!(openai.text.is_none());

    let anthropic = parse_sse_event(
        r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        "anthropic",
        &mut acc,
    )
    .unwrap();
    assert!(anthropic.error.unwrap().contains("Overloaded"));

    // A normal delta is untouched by the error branch.
    let ok = parse_sse_event(
        r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#,
        "openai",
        &mut acc,
    )
    .unwrap();
    assert_eq!(ok.text.as_deref(), Some("hi"));
    assert!(ok.error.is_none());
}

/// `finish_reason` is what tells a complete answer from a truncated one.
#[test]
fn sse_reports_finish_reason() {
    let mut acc = String::new();
    let cut = parse_sse_event(
        r#"data: {"choices":[{"delta":{},"finish_reason":"length"}]}"#,
        "openai",
        &mut acc,
    )
    .unwrap();
    assert_eq!(cut.finish_reason.as_deref(), Some("length"));
    assert!(
        cut.text.is_none(),
        "a final frame carries no text of its own"
    );

    let filtered = parse_sse_event(
        r#"data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}"#,
        "openai",
        &mut acc,
    )
    .unwrap();
    assert_eq!(filtered.finish_reason.as_deref(), Some("content_filter"));

    // Anthropic spells it `stop_reason`.
    let anthropic = parse_sse_event(
        r#"data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}"#,
        "anthropic",
        &mut acc,
    )
    .unwrap();
    assert_eq!(anthropic.finish_reason.as_deref(), Some("max_tokens"));

    // A plain delta reports no finish reason, so the loop does not think the
    // answer ended on every chunk.
    let plain = parse_sse_event(
        r#"data: {"choices":[{"delta":{"content":"x"}}]}"#,
        "openai",
        &mut acc,
    )
    .unwrap();
    assert!(plain.finish_reason.is_none());
    assert!(!plain.done);
}

#[test]
fn an_in_band_error_frame_is_reported_as_an_event() {
    // A 200 response that carries an error event: the caller has to see it and
    // stop, or a truncated answer is accepted as a complete one.
    let mut stream = CompletionStream::new("openai");
    let events = stream
        .feed(b"data: {\"error\":{\"message\":\"rate limit exceeded\"}}\n")
        .expect("an in-band error is not a size violation");
    assert_eq!(
        events,
        vec![StreamEvent::ProviderError(
            "rate limit exceeded".to_string()
        )]
    );
}
