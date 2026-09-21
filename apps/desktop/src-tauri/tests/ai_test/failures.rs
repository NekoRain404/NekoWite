//! The refusal vocabulary: a non-2xx status and the provider's own explanation, mapped
//! to a message the user can act on.

use nekowite_lib::providers::ai::client::{
    error_detail_from_body, http_error_message, http_error_message_with_detail,
};

// `stream_complete` calls `Response::error_for_status()` after `send()` so a
// 4xx/5xx is surfaced as an `ai-error` event + `Err` instead of being read as an
// empty SSE stream. The status->message mapping is extracted into
// `http_error_message` so it can be tested without a live endpoint; each of
// these non-2xx codes would short-circuit `bytes_stream()` the same way a real
// provider error page would.

#[test]
fn http_error_401_hints_bad_key() {
    let msg = http_error_message(401);
    assert!(msg.starts_with("AI 请求失败："), "got: {msg}");
    assert!(msg.contains("API Key 无效"), "got: {msg}");
}

#[test]
fn http_error_429_hints_retry() {
    let msg = http_error_message(429);
    assert!(msg.contains("请稍后重试"), "got: {msg}");
}

#[test]
fn http_error_5xx_hints_unavailable() {
    for status in [500, 502, 503, 504] {
        let msg = http_error_message(status);
        assert!(
            msg.contains("服务端暂时不可用"),
            "status {status} got: {msg}"
        );
    }
}

#[test]
fn http_error_unknown_status_stays_total() {
    // A hypothetical non-2xx code we did not explicitly map must still yield a
    // usable message (and never panic), so error_for_status never falls apart on
    // an unexpected provider page.
    let msg = http_error_message(599);
    // The unmapped fallback says "request failed" rather than "network failed":
    // an unexpected status is still a RESPONSE, and calling it a network problem
    // sent users to check a connection that was working fine.
    assert!(
        msg.starts_with("AI 请求失败：HTTP 599，请求失败"),
        "got: {msg}"
    );
}

/// The provider's own explanation is what tells the user what to fix.
#[test]
fn http_error_includes_the_provider_detail() {
    // Measured against a real gateway: an unknown model name is HTTP 403 with
    // a body naming the models that WOULD work. Reporting only the status told
    // the user their API key was invalid, so they re-entered a key that was
    // fine while the useful sentence sat unread in a response body.
    let body = r#"{"error":{"message":"The current group does not support the requested model. Available models: deepseek-flash"}}"#;
    let detail = error_detail_from_body(body).expect("a JSON error body yields its message");
    let message = http_error_message_with_detail(403, Some(&detail));
    assert!(message.contains("403"));
    assert!(message.contains("Available models: deepseek-flash"));
    assert!(
        message.contains("模型名"),
        "the hint names the model as a suspect: {message}"
    );

    // A non-JSON body is shown verbatim rather than dropped.
    assert_eq!(
        error_detail_from_body("  upstream exploded  ").unwrap(),
        "upstream exploded"
    );

    // An empty body adds nothing, and 402 is a billing problem rather than a
    // network one.
    assert!(error_detail_from_body("   ").is_none());
    let bare = http_error_message_with_detail(402, None);
    assert!(bare.contains("余额"), "402 reads as billing: {bare}");

    // A wall of text is capped so it cannot fill the toast.
    let capped = http_error_message_with_detail(500, Some(&"x".repeat(5000)));
    assert!(capped.chars().count() < 700);
}
