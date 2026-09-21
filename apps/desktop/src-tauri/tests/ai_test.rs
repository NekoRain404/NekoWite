//! The AI provider layer, one behaviour domain per file.
//!
//! The cases outgrew a page, so they are divided by what they actually read rather than by
//! arithmetic: `endpoint_mapping` for the address a request goes to, `request_body` for what it
//! carries, `streaming_response` and `stream_status` for the SSE framing and what ends a stream,
//! `failures` for the refusal vocabulary, `models` for the model list and its ceiling,
//! `url_policy` for the HTTPS/`allow_private` rules and the key that never rides in a URL,
//! `request_ceilings` for the input ceilings, and `support` for the fixtures they share. They are
//! one target and one command - `cargo test --test ai_test` - because a case in a file nobody runs
//! is not evidence.

// `#[path]` rather than a bare `mod`, for the reason `agent_update_test.rs` and
// `desktop_pet_ipc_test.rs` give: a bare `mod name;` inside a file directly under `tests/` is
// resolved against the `tests/` directory, not this file's own directory, so it would look for
// `tests/name.rs` and fail to compile (E0583). The directory holds behaviour for one target, not
// targets of its own.
#[path = "ai_test/endpoint_mapping.rs"]
mod endpoint_mapping;
#[path = "ai_test/failures.rs"]
mod failures;
#[path = "ai_test/models.rs"]
mod models;
#[path = "ai_test/request_body.rs"]
mod request_body;
#[path = "ai_test/request_ceilings.rs"]
mod request_ceilings;
#[path = "ai_test/stream_status.rs"]
mod stream_status;
#[path = "ai_test/streaming_response.rs"]
mod streaming_response;
#[path = "ai_test/support.rs"]
mod support;
#[path = "ai_test/url_policy.rs"]
mod url_policy;
