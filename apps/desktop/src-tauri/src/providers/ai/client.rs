//! Shared AI client layer: the completion path and the state one completion
//! runs in - the models fetch, the streaming loop, the concurrency slot and the
//! cancel plumbing.
//!
//! Everything this layer *decides* lives in a sibling module, and the decisions
//! are re-exported here for one stage (roadmap 10.1 rule 5) so the sole consumer
//! (`commands/ai.rs`) and the integration tests keep their imports unchanged:
//!
//! * [`super::endpoint`] - which host a completion goes to, and with which body;
//! * [`super::events`] - the completion's id and the events it emits;
//! * [`super::limits`] - the byte, time and concurrency ceilings, and the guard
//!   that enforces the concurrency one;
//! * [`super::refusal`] - when a finished completion is a failure, and why;
//! * [`super::request`] - the request configuration, body/URL construction and
//!   the input ceiling check;
//! * [`super::response`] - the non-streaming read, the error-body wording and
//!   the token accounting;
//! * [`super::sse`] - frame reassembly, folding and the answer ceiling;
//! * [`super::url_policy`] - the HTTPS rule, the SSRF guard and the pin.
//!
//! The transport both entry points below dial through is `super::transport`,
//! which stays private to this layer: nothing outside it builds a client.
//!
//! Provider-specific request construction and SSE text extraction live in
//! [`super::gemini`] and [`super::openai_compatible`], which [`super::endpoint`]
//! and [`super::sse::parse_sse_event`] dispatch to by provider name.
//!
//! Dependencies: this module depends on every sibling and none of them depends
//! back, so the graph stays acyclic - `client` is the only module that knows all
//! the others, and the provider modules reach their helpers through
//! `request`/`response`/`url_policy` instead of through this file.

use futures_util::StreamExt;
use tauri::Emitter;

pub use super::events::{ai_id_for, emit_ai_error, next_ai_id, AIChunk};
use super::events::{deliver_events, is_active};

// --- Compatibility re-exports -------------------------------------------------
//
// A re-export, not a wrapper: each item has exactly one definition (in the
// module named above) and this block is what lets the split land without
// touching `commands/ai.rs` in the same commit. The internal code below uses
// these same names, so the list doubles as the module's import list.
pub use super::endpoint::resolve_endpoint;
pub use super::limits::{
    acquire_slot, MAX_ANSWER_BYTES, MAX_ERROR_BODY_BYTES, MAX_IMAGES_PER_REQUEST,
    MAX_IMAGE_DATA_URL_BYTES, MAX_MODELS_RESPONSE_BYTES, MAX_PROMPT_BYTES, MAX_REQUEST_BODY_BYTES,
    MAX_SSE_LINE_BYTES,
};
use super::limits::{
    COMPLETION_CONNECT_TIMEOUT, COMPLETION_READ_TIMEOUT, MODELS_CONNECT_TIMEOUT,
    MODELS_READ_TIMEOUT,
};
pub use super::refusal::completion_refusal;
use super::request::with_completion_auth;
pub use super::request::{
    default_base_url, encode_request_body, hydrate_stored_key, normalize_reasoning_effort,
    resolve_base_url, validate_request_inputs, AIConfig,
};
pub use super::response::{
    ai_done_payload, error_detail_from_body, http_error_message, http_error_message_with_detail,
    parse_model_ids, TokenUsage,
};
use super::response::{fetch_model_ids, read_body_bounded};
pub use super::sse::{
    accumulate_usage, parse_sse_event, parse_sse_line, CompletionStream, SseBuffer, SseDelta,
    StreamEvent,
};
use super::transport::ai_http_client;
pub use super::url_policy::{validate_base_url, VettedHost};

/// Resolve the provider's `GET {endpoint}` for listing models through one
/// pinned, redirect-refusing client.
///
/// The transport is built HERE and handed to [`fetch_model_ids`] rather than
/// constructed inside the response module: the SSRF decision (`validate_base_url`),
/// the pin it returns and the per-phase timeouts from `limits` are parameters of
/// the call, which is the dependency direction the roadmap asks for when a
/// module is split.
pub async fn list_models(config: &AIConfig) -> Result<Vec<String>, String> {
    // Reject a private/loopback Base URL unless the user opts in (see
    // `validate_base_url`); a model dropdown must never phone an internal host.
    // The address this path dials is the models-URL override when one is set,
    // so THAT is what the policy is handed - an override is a second address,
    // never a second set of rules, and the pin it returns must belong to the
    // host that will actually be dialled.
    let pin = validate_base_url(&config.for_models_fetch())?;
    let client = ai_http_client(MODELS_CONNECT_TIMEOUT, MODELS_READ_TIMEOUT, pin.as_ref())
        .map_err(|e| e.to_string())?;
    fetch_model_ids(&client, config).await
}

pub async fn stream_complete(
    app: &tauri::AppHandle,
    config: &AIConfig,
    prompt: &str,
    images: &[serde_json::Value],
    id: &str,
    cancel: &tokio_util::sync::CancellationToken,
    pin: Option<&VettedHost>,
) -> Result<(), String> {
    // `resolve_endpoint` builds the content itself: with images it emits the
    // provider's multimodal array (text + image blocks), without images it
    // keeps the plain string prompt — preserving the existing single-text
    // ghost-writer behaviour unchanged. It refuses when the provider has no
    // address at all, which is the one case that must not reach the network.
    let (url, body) = resolve_endpoint(config, prompt, images).inspect_err(|e| {
        emit_ai_error(app, id, e);
    })?;

    // Serialise (and bound) the request before anything is opened. `json()`
    // would serialise the same value internally; doing it here means the bytes
    // that go on the wire are the bytes that were measured, and an oversized
    // body costs no connection, no concurrency permit and no provider call.
    let payload = encode_request_body(&body).inspect_err(|e| {
        emit_ai_error(app, id, e);
    })?;

    // Per-phase timeouts from `limits`, never a total-request deadline: the
    // rationale (and the values) live with the constants, so the cap can only
    // be changed in one place. Their error surfaces through `request.send()` /
    // `bytes_stream()` and produces the same `ai-error` + `Err` path as a
    // transport failure.
    let client =
        ai_http_client(COMPLETION_CONNECT_TIMEOUT, COMPLETION_READ_TIMEOUT, pin).map_err(|e| {
            emit_ai_error(app, id, &e.to_string());
            e.to_string()
        })?;

    // The pre-serialised payload is sent verbatim, so the body on the wire is
    // byte-for-byte the body `encode_request_body` measured and approved.
    let request = with_completion_auth(
        client
            .post(&url)
            .header("content-type", "application/json")
            .body(payload),
        config,
    );

    let response = request.send().await.map_err(|e| {
        let _ = app.emit(
            "ai-error",
            serde_json::json!({ "id": id, "message": e.to_string() }),
        );
        e.to_string()
    })?;
    // A 4xx/5xx must not be read as a normal SSE stream (that would surface the
    // provider's JSON error page as chunks and end in an empty `ai-done` with no
    // hint to the user). Surfacing it here mirrors the `send` failure path above:
    // emit `ai-error` then return `Err`, so the frontend's `onError`/toast fires.
    // 2xx passes through to `bytes_stream()` unchanged.
    let status = response.status();
    if !status.is_success() {
        // Read the provider's own explanation BEFORE reporting: the status code
        // alone misdirects (an unknown model name arrives as 403, which reads as
        // "your key is invalid"), while the body names the actual problem and,
        // for a model error, the models that would work. The read is bounded
        // (an error page is peer-controlled bytes like any other response); a
        // body past that ceiling yields no detail rather than a failed report.
        let detail = read_body_bounded(response, MAX_ERROR_BODY_BYTES)
            .await
            .ok()
            .and_then(|body| error_detail_from_body(&body));
        let message = http_error_message_with_detail(status.as_u16(), detail.as_deref());
        let _ = app.emit(
            "ai-error",
            serde_json::json!({ "id": id, "message": message }),
        );
        return Err(message);
    }

    let mut stream = response.bytes_stream();
    // The completion's streaming state: the reassembly buffer, the answer being
    // accumulated, the provider's token accounting and why it stopped. It is a
    // separate type because it is where the response-side size ceilings live,
    // and it has no socket and no Tauri handle — so the policy it enforces is
    // testable (see the `CompletionStream` tests).
    let mut completion = CompletionStream::new(&config.provider);
    let mut stream_ended = false;
    loop {
        if !is_active(app, id) {
            break;
        }
        // Race the socket against the cancel token. Checking a flag between
        // chunks is not enough: the provider can be silent for a long time
        // (reasoning models especially), and during that gap a cancelled request
        // kept its connection, its concurrency permit and its billing alive
        // until the next chunk arrived or the 120 s read timeout expired.
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                break;
            }
            chunk = stream.next() => chunk,
        };
        match next {
            Some(Ok(chunk)) => {
                // Feed the raw bytes; the buffer decodes only complete lines,
                // so a multi-byte UTF-8 character split at a chunk boundary
                // stays intact (decoding per chunk would corrupt it to U+FFFD).
                // The fold's `Err` is a size ceiling: the frame boundary (or
                // the answer) is no longer something we can trust, so the
                // response is abandoned rather than read any further.
                let events = match completion.feed(&chunk) {
                    Ok(events) => events,
                    Err(message) => {
                        emit_ai_error(app, id, &message);
                        return Err(message);
                    }
                };
                if deliver_events(app, id, events)? {
                    stream_ended = true;
                    break;
                }
            }
            Some(Err(e)) => {
                let _ = app.emit(
                    "ai-error",
                    serde_json::json!({ "id": id, "message": e.to_string() }),
                );
                return Err(e.to_string());
            }
            None => {
                stream_ended = true;
                break;
            }
        }
    }
    // The stream ran to its end (as opposed to being cancelled): emit a final
    // partial line if the server stopped mid-line, so its text is not dropped.
    // A cancelled stream must NOT flush: the user asked for the request to stop,
    // and emitting the tail of an abandoned response is how a late chunk got
    // adopted by the next request.
    if stream_ended {
        match completion.finish() {
            Ok(events) => {
                deliver_events(app, id, events)?;
            }
            Err(message) => {
                emit_ai_error(app, id, &message);
                return Err(message);
            }
        }
    }
    // A cancellation is not a failure and not a completion: say nothing, emit
    // nothing. The caller has already been told (and the frontend discards any
    // late `ai-done` for a stream it cancelled — this is the belt to that
    // braces, and it stops a cancelled request from counting as a success).
    if !is_active(app, id) {
        return Ok(());
    }
    let answer = completion.answer();
    if let Some(message) = completion_refusal(&completion) {
        emit_ai_error(app, id, message);
        return Err(message.into());
    }
    let _ = app.emit("ai-done", ai_done_payload(id, answer, completion.usage()));
    Ok(())
}
