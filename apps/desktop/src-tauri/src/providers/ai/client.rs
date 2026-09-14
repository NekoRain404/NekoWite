//! Shared AI client layer: the completion path and the state one completion
//! runs in - the HTTP client lifecycle, the streaming loop, the concurrency
//! slot and the cancel plumbing.
//!
//! Everything this layer *decides* lives in a sibling module, and the decisions
//! are re-exported here for one stage (roadmap 10.1 rule 5) so the sole consumer
//! (`commands/ai.rs`) and the integration tests keep their imports unchanged:
//!
//! * [`super::events`] - the completion's id and the events it emits;
//! * [`super::limits`] - the byte, time and concurrency ceilings, and the guard
//!   that enforces the concurrency one;
//! * [`super::request`] - the request configuration, body/URL construction and
//!   the input ceiling check;
//! * [`super::response`] - the non-streaming read, the error-body wording and
//!   the token accounting;
//! * [`super::sse`] - frame reassembly, folding and the answer ceiling;
//! * [`super::url_policy`] - the HTTPS rule, the SSRF guard and the pin.
//!
//! Provider-specific request construction and SSE text extraction live in
//! [`super::gemini`] and [`super::openai_compatible`], which [`resolve_endpoint`]
//! and [`super::sse::parse_sse_event`] dispatch to by provider name.
//!
//! Dependencies: this module depends on every sibling and none of them depends
//! back, so the graph stays acyclic - `client` is the only module that knows all
//! the others, and the provider modules reach their helpers through
//! `request`/`response`/`url_policy` instead of through this file.

use std::time::Duration;

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
pub use super::limits::{
    acquire_slot, MAX_ANSWER_BYTES, MAX_ERROR_BODY_BYTES, MAX_IMAGES_PER_REQUEST,
    MAX_IMAGE_DATA_URL_BYTES, MAX_MODELS_RESPONSE_BYTES, MAX_PROMPT_BYTES, MAX_REQUEST_BODY_BYTES,
    MAX_SSE_LINE_BYTES,
};
use super::limits::{
    COMPLETION_CONNECT_TIMEOUT, COMPLETION_READ_TIMEOUT, MODELS_CONNECT_TIMEOUT,
    MODELS_READ_TIMEOUT,
};
use super::request::with_completion_auth;
pub use super::request::{
    build_prompt, default_base_url, encode_request_body, hydrate_stored_key,
    normalize_reasoning_effort, validate_request_inputs, AIConfig,
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
pub use super::url_policy::{validate_base_url, VettedHost};
use super::{gemini, openai_compatible};

/// Resolve a completion's request endpoint + body for the configured provider.
/// Provider-specific construction is delegated to [`super::gemini`] and
/// [`super::openai_compatible`].
pub fn resolve_endpoint(
    cfg: &AIConfig,
    prompt: &str,
    images: &[serde_json::Value],
) -> (String, serde_json::Value) {
    match cfg.provider.as_str() {
        "anthropic" => openai_compatible::endpoint_anthropic(cfg, prompt, images),
        "gemini" => gemini::endpoint(cfg, prompt, images),
        _ => openai_compatible::endpoint_default(cfg, prompt, images),
    }
}

/// Build the HTTP client used for every AI request.
///
/// Two things here are security-relevant, not style:
///
///   * **Redirects are refused.** Following one means the request can land on
///     an origin the SSRF check never saw — a `302` to `http://127.0.0.1:11434/`
///     or to an attacker's host. `reqwest` strips `Authorization` on a
///     cross-origin redirect but does NOT touch the custom headers the non-OpenAI
///     providers authenticate with (`x-api-key`, `x-goog-api-key`), so a followed
///     redirect would hand over the user's key. The AI providers do not need
///     redirects; a redirect here is an error, not a hop to follow.
///   * **The vetted addresses are pinned** via `resolve_to_addrs`, so the name
///     cannot resolve to a different address between the check and the connect.
fn ai_http_client(
    connect_timeout: Duration,
    read_timeout: Duration,
    pin: Option<&VettedHost>,
) -> Result<reqwest::Client, reqwest::Error> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .read_timeout(read_timeout)
        .redirect(reqwest::redirect::Policy::none());
    if let Some(pin) = pin {
        if !pin.addrs.is_empty() {
            builder = builder.resolve_to_addrs(&pin.host, &pin.addrs);
        }
    }
    builder.build()
}

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
    // ghost-writer behaviour unchanged.
    let (url, body) = resolve_endpoint(config, prompt, images);

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
    let finish_reason = completion.finish_reason();
    // `length` means the provider ran out of output budget mid-answer. Saying so
    // matters more than the answer itself: the text the user sees is a fragment,
    // and silently accepting it as the whole reply is how a truncated document
    // ends up inserted into a note.
    if finish_reason == Some("length") && !answer.is_empty() {
        let message = "回答因达到最大输出 Tokens 被截断（finish_reason: length）。\n                  内容并不完整，请在设置里调大“最大输出 Tokens”后重试。";
        let _ = app.emit(
            "ai-error",
            serde_json::json!({ "id": id, "message": message }),
        );
        return Err(message.into());
    }
    if finish_reason == Some("content_filter") {
        let message = "服务端的内容过滤中断了这次回答（finish_reason: content_filter）。";
        let _ = app.emit(
            "ai-error",
            serde_json::json!({ "id": id, "message": message }),
        );
        return Err(message.into());
    }
    // An answer-less completion that produced reasoning is not a normal result:
    // the budget was consumed by the model's thinking, so tell the user what to
    // change instead of finishing silently with nothing to show.
    if answer.is_empty() && completion.saw_reasoning() {
        let message = "模型把本次最大输出 Tokens 全部用于推理，没有产出正文。                       请在设置里把“最大输出 Tokens”调大（推理模型建议 ≥ 1024）后重试。";
        let _ = app.emit(
            "ai-error",
            serde_json::json!({ "id": id, "message": message }),
        );
        return Err(message.into());
    }
    let _ = app.emit("ai-done", ai_done_payload(id, answer, completion.usage()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A followed redirect can leave the vetted origin, and the custom auth
    /// headers the non-OpenAI providers use (`x-api-key`, `x-goog-api-key`) are
    /// NOT stripped by reqwest the way `Authorization` is — so the key would go
    /// to whatever host the redirect names. This drives a real 302 to prove the
    /// client surfaces it instead of following.
    #[tokio::test]
    async fn the_ai_client_does_not_follow_a_redirect() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a loopback port");
        let addr = listener.local_addr().expect("local addr");
        let target_hit = Arc::new(AtomicBool::new(false));
        let hit_by_server = target_hit.clone();
        let server = tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let hit = hit_by_server.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    let _ = sock.read(&mut buf).await;
                    let req = String::from_utf8_lossy(&buf).to_string();
                    let response = if req.starts_with("GET /target") {
                        hit.store(true, Ordering::SeqCst);
                        "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nhit!!!"
                            .to_string()
                    } else {
                        format!(
                            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{}/target\r\n\
                             Content-Length: 0\r\nConnection: close\r\n\r\n",
                            addr.port()
                        )
                    };
                    let _ = sock.write_all(response.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });

        let client = ai_http_client(Duration::from_secs(5), Duration::from_secs(5), None)
            .expect("client builds");
        let response = client
            .get(format!("http://127.0.0.1:{}/start", addr.port()))
            .send()
            .await
            .expect("the 302 itself is a valid response");

        assert_eq!(
            response.status().as_u16(),
            302,
            "the redirect must be surfaced as the response, not followed"
        );
        assert!(
            !target_hit.load(Ordering::SeqCst),
            "the redirect target must never be requested"
        );
        server.abort();
    }
}
