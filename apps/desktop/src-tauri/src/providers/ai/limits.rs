//! The ceilings one AI request is held to - bytes, time and in-flight count -
//! together with the guards that enforce them.
//!
//! Dependencies: this module is a leaf. It imports nothing from its siblings
//! (`client`, `request`, `response`, `sse`, `url_policy`); the only outside
//! reference is the crate-wide [`AiState`] that the concurrency ceiling counts
//! against. Direction of dependency: everything else may depend on this file.

use std::sync::atomic::Ordering;
use std::time::Duration;

use crate::state::{AiState, MAX_PENDING};

// --- Request and response size ceilings -------------------------------------
//
// Every byte an AI request sends or receives crosses this layer, and every one
// of those bytes is chosen by the renderer or by the provider - neither of
// which the backend controls. The ceilings below are the enforcement points the
// roadmap requires at the Rust IPC/HTTP boundary: front-end validation is a
// courtesy to the user, not a guarantee, because anything can invoke the
// command. Each one is deliberately far above what a legitimate request needs
// (the reasoning is on each constant) so the limit can only be hit by a bug,
// a loop, or a hostile peer - and when it is hit the caller gets a named error
// instead of an unbounded allocation.

/// Largest prompt (UTF-8 bytes) one request may carry.
///
/// The renderer builds the prompt from the note context it was allowed to
/// attach, so the largest one it can build is bounded by `CONTEXT_CHARS_MAX`
/// plus the transcript plus the fixed wrappers. **Re-derived against the
/// ceiling as it stands now, because the sentence that used to be here was
/// true and stopped being true when that ceiling moved** — it claimed an order
/// of magnitude of headroom against a 32 000-character ceiling, which was
/// so at the time and is not now:
///
/// | term | characters | bytes |
/// |---|---|---|
/// | note context at `CONTEXT_CHARS_MAX` | 200 000 | 600 000 |
/// | transcript, capped by `buildChatPrompt` | 6 000 | 18 000 |
/// | headers, labels, the truncation notice | — | ~4 000 |
/// | | | **~622 000 = 607 KiB** |
///
/// So 1 MiB is **1.7x** the largest request the app itself can build, not ten
/// times it. It is still the right bound: it is above everything the renderer
/// can produce (so a legitimate request is never refused — the user sees
/// "提示词过长" only if something else is pushing this), and it still stops a
/// looping renderer or a plugin from putting an unbounded string through IPC.
///
/// What it is *not* is a token budget. The provider's own context window is
/// enforced by the provider, and a 200 000-character Chinese note is on the
/// order of that whole window — see `DEFAULT_CONTEXT_CHARS` in the renderer's
/// settings store for what the app picks so that does not happen by default.
///
/// If the ceiling moves again, this table moves with it; the arithmetic is
/// three lines and the failure mode of skipping it is that the next reader
/// trusts a number nobody recomputed.
pub const MAX_PROMPT_BYTES: usize = 1024 * 1024;

/// Largest number of images one request may carry.
///
/// The product limit is `MAX_IMAGES_PER_MESSAGE` = 4 per chat message, and the
/// composer cannot build a request without it; 16 leaves 4x headroom for a
/// future/plugin path while staying far below every provider's own image
/// ceiling (Anthropic: 100 per request, OpenAI: 500), so this bound can never
/// be the thing that makes a provider reject a request we would have sent.
pub const MAX_IMAGES_PER_REQUEST: usize = 16;

/// Largest single image, measured on the serialised value that will be sent (a
/// `data:` URL). 10 MiB of image bytes - the renderer's own
/// `MAX_ATTACHMENT_BYTES` - base64-encodes to 13 981 016 characters; 14 MiB
/// accepts everything the renderer allowed, including the `data:` prefix, and
/// refuses a value that cannot be an image the user attached.
pub const MAX_IMAGE_DATA_URL_BYTES: usize = 14 * 1024 * 1024;

/// Largest serialised request body.
///
/// The biggest body the app can build is one message's image budget (20 MiB
/// raw, `MAX_ATTACHMENTS_PER_MESSAGE_BYTES`) base64-encoded to ~27 MiB plus the
/// prompt, so 32 MiB never binds on a legitimate request - but it does bound
/// what a single IPC call can make the backend allocate, serialise and
/// transmit. Past this the provider answers 413 anyway (see the hint in
/// `http_error_message_with_detail`), so nothing is lost by refusing earlier.
pub const MAX_REQUEST_BODY_BYTES: usize = 32 * 1024 * 1024;

/// Largest single SSE frame, and therefore the largest reassembly buffer: the
/// buffer drains every complete line as it arrives, so it never holds more than
/// ONE unterminated line (see [`SseBuffer`]).
///
/// The largest legitimate frame is a provider that delivers an answer in one
/// event instead of deltas. The app's own output ceiling is 8192 tokens (the
/// settings input's maximum), i.e. ~32 KB of text plus its JSON envelope, so
/// 1 MiB is ~30x headroom - and it still caps one connection's reassembly at
/// 1 MiB instead of "whatever the peer sends".
pub const MAX_SSE_LINE_BYTES: usize = 1024 * 1024;

/// Largest answer one completion may accumulate.
///
/// Same order as a frame: 1 MiB of text is roughly 250 000 tokens, far past any
/// `max_tokens` the settings UI can produce (8192), so this only ever fires for
/// a provider that ignores its own output cap - and it fires as a clear error
/// rather than silently truncating the text the user is watching stream in.
pub const MAX_ANSWER_BYTES: usize = 1024 * 1024;

/// Largest `/models` body read.
///
/// The biggest real listings are marketplaces that return hundreds of models
/// with full metadata, on the order of a few hundred KB; 4 MiB is an order of
/// magnitude above them. The point is that the read stops somewhere: the list
/// is display data, and a broken or hostile endpoint must not be able to make
/// the backend buffer gigabytes for a dropdown.
pub const MAX_MODELS_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// Largest provider error body read. Only 300 characters of it ever reach the
/// user (see [`http_error_message_with_detail`]), so 64 KiB is already 200x the
/// displayed amount: this bounds the read, it does not fit the message.
pub const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;

// --- Time ceilings ----------------------------------------------------------
//
// Per-phase timeouts instead of a total-request deadline: `Client::timeout`
// caps the WHOLE request including the streaming body, so any completion
// longer than the cap aborts mid-stream. `connect_timeout` bounds the
// connection phase and `read_timeout` bounds each single read, so a stalled
// provider still cannot hang the stream forever (cooperative cancel only
// interrupts between chunks) while a long, actively-streaming completion runs
// to its natural end. The timeout error surfaces through `request.send()` /
// `bytes_stream()` and produces the same `ai-error` + `Err` path as a transport
// failure.
//
// The model dropdown gets the shorter pair: it is a bounded JSON read the user
// is waiting on, not a generation that legitimately streams for minutes.

/// Connection-phase ceiling for a `GET /models` request.
pub const MODELS_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Per-read ceiling for a `GET /models` request.
pub const MODELS_READ_TIMEOUT: Duration = Duration::from_secs(15);

/// Connection-phase ceiling for a streaming completion.
pub const COMPLETION_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Per-read ceiling for a streaming completion. A silent provider is cut off
/// here; an actively streaming one is not, because this bounds each read rather
/// than the whole response.
pub const COMPLETION_READ_TIMEOUT: Duration = Duration::from_secs(120);

// --- Concurrency ceiling ----------------------------------------------------
//
// The in-flight count is a ceiling like the byte ones above: it is enforced by
// a semaphore plus a pending counter rather than by a length check, and the
// guard below is what makes that enforcement leak-free.

/// RAII guard that decrements the pending counter on drop, so a task aborted
/// while waiting for a permit never leaks its queue slot.
struct PendingGuard<'a>(&'a AiState);

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.0.pending.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Acquire a concurrency slot, holding the returned permit for the duration of
/// one streaming request. Bounded by [`CONCURRENCY_LIMIT`] in-flight permits and
/// [`MAX_PENDING`] queued waiters; a saturated pool returns a clear "busy" error
/// instead of spawning unbounded connections.
pub async fn acquire_slot(state: &AiState) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
    let guard = PendingGuard(state);
    let prev = state.pending.fetch_add(1, Ordering::SeqCst);
    if prev >= MAX_PENDING {
        return Err("AI 请求过多（并发已满），请稍后重试".into());
    }
    // `acquire_owned` takes an `Arc`, so the queue is the semaphore itself and
    // the permit is owned (not tied to `state`), letting it be held across the
    // whole stream without borrowing the Tauri state.
    let permit = state
        .semaphore
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "AI 服务不可用".to_string())?;
    drop(guard);
    Ok(permit)
}
