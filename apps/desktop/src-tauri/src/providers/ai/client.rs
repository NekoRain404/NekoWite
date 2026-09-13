//! Shared AI client layer.
//!
//! This module owns the parts of the AI request path that are provider-agnostic:
//! the streaming HTTP loop, SSE reassembly, concurrency limiter, SSRF guard,
//! cancel/emit plumbing and the shared DTOs. Provider-specific request
//! construction and SSE text extraction live in [`super::gemini`] and
//! [`super::openai_compatible`], which `resolve_endpoint`/`parse_sse_line`
//! dispatch to by provider name.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{Emitter, Manager};

use crate::state::{AiState, MAX_PENDING};
use crate::storage::key_store::{load_ai_key_internal, AI_KEY_MASKED};

use super::gemini;
use super::openai_compatible;

#[derive(Deserialize, Clone, Default)]
pub struct AIConfig {
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    /// Sampling temperature (0.0–2.0). `None` omits the field, letting the
    /// provider use its own default.
    pub temperature: Option<f32>,
    /// Completion token cap. `None` falls back to the legacy hardcoded 256.
    pub max_tokens: Option<u32>,
    /// Optional system prompt. `None`/empty adds no system message.
    pub system_prompt: Option<String>,
    /// The user's thinking-depth choice: one of the lowercase rungs
    /// `none|minimal|low|medium|high|xhigh`, case- and padding-insensitive.
    /// Normalised by [`normalize_reasoning_effort`] before a provider ever sees
    /// it. A value outside that ladder is dropped rather than forwarded: the
    /// server answers an invalid rung with HTTP 400 (measured against
    /// tokenflux's `deepseek-flash`: "ultra", "bogus-level" and even the
    /// uppercase "HIGH" were all rejected), so an unrecognised value must
    /// degrade to "send nothing" instead of failing the whole request.
    pub reasoning_effort: Option<String>,
    /// Opt-in to allow private/loopback Base URLs (e.g. Ollama / LM Studio).
    /// Default `false`: a Base URL whose host is a literal private, loopback,
    /// link-local, CGNAT or unspecified IP (or `localhost`) is rejected. The
    /// frontend must send this to reach a local model endpoint.
    #[serde(default)]
    pub allow_private: bool,
}

// --- Request and response size ceilings -------------------------------------
//
// Every byte an AI request sends or receives crosses this module, and every one
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
/// attach: `CONTEXT_CHARS_MAX` is 32 000 characters (at most ~96 KB as UTF-8
/// CJK), plus the fixed instruction wrappers. 1 MiB is an order of magnitude
/// above that, so no request the app itself can build is ever refused, while a
/// looping renderer or plugin cannot push an unbounded string through IPC.
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

/// Check one completion's raw inputs against [`MAX_PROMPT_BYTES`],
/// [`MAX_IMAGES_PER_REQUEST`] and [`MAX_IMAGE_DATA_URL_BYTES`].
///
/// Called at the IPC boundary (`ai_complete`) before anything is claimed or
/// sent, so an impossible request costs nothing and the user gets a specific
/// error instead of a provider-side rejection (or a 413) much later. The
/// provider-agnostic request builder is covered separately by
/// [`encode_request_body`], which bounds the assembled body whatever it holds.
pub fn validate_request_inputs(prompt: &str, images: &[serde_json::Value]) -> Result<(), String> {
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(format!(
            "提示词过长（{} 字节，上限 {} 字节）。请缩小选区或减少附加上下文后重试。",
            prompt.len(),
            MAX_PROMPT_BYTES
        ));
    }
    if images.len() > MAX_IMAGES_PER_REQUEST {
        return Err(format!(
            "一次请求最多发送 {} 张图片（本次 {} 张）。",
            MAX_IMAGES_PER_REQUEST,
            images.len()
        ));
    }
    for (index, image) in images.iter().enumerate() {
        let size = serialized_len(image);
        if size > MAX_IMAGE_DATA_URL_BYTES {
            return Err(format!(
                "第 {} 张图片过大（{} 字节，上限 {} 字节）。请压缩后再发送。",
                index + 1,
                size,
                MAX_IMAGE_DATA_URL_BYTES
            ));
        }
    }
    Ok(())
}

/// The size of a value as it will go on the wire. An image arrives as a `data:`
/// URL string; anything else is measured after serialising, so the number is
/// the JSON the request will actually carry rather than an approximation.
fn serialized_len(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::String(s) => s.len(),
        other => other.to_string().len(),
    }
}

/// Serialise a request body under [`MAX_REQUEST_BODY_BYTES`].
///
/// Serialising here, rather than letting `RequestBuilder::json` do it, is what
/// makes the ceiling enforceable: the bytes that will go on the wire are
/// measured before a connection is opened, and the very same bytes are then
/// handed to the request — nothing is serialised twice, and nothing can be
/// added between the measurement and the send.
pub fn encode_request_body(body: &serde_json::Value) -> Result<Vec<u8>, String> {
    let payload = serde_json::to_vec(body).map_err(|e| format!("AI 请求体序列化失败：{e}"))?;
    if payload.len() > MAX_REQUEST_BODY_BYTES {
        return Err(format!(
            "AI 请求体过大（{} 字节，上限 {} 字节）。请减少图片或缩短上下文后重试。",
            payload.len(),
            MAX_REQUEST_BODY_BYTES
        ));
    }
    Ok(payload)
}

/// The system prompt to send, normalised so blanks become `None`.
pub(crate) fn system_prompt_of(cfg: &AIConfig) -> Option<String> {
    cfg.system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Read a token count the provider actually sent: only a non-negative integer
/// counts. A string, a float, a negative number or an object is not a
/// measurement, so it is ignored instead of coerced (see [`TokenUsage`]).
pub(crate) fn token_count(raw: Option<&serde_json::Value>) -> Option<u64> {
    raw.and_then(serde_json::Value::as_u64)
}

/// The thinking-depth ladder every provider understands, lowest first. The
/// server accepts this exact lowercase set and 400s on anything else, so
/// normalisation may only ever return one of these six words or `None`.
const REASONING_EFFORT_LADDER: [&str; 6] = ["none", "minimal", "low", "medium", "high", "xhigh"];

/// Normalise the user's thinking-depth choice to its wire spelling: trimmed,
/// lowercased, then matched against [`REASONING_EFFORT_LADDER`]. A blank or
/// unknown value — or no choice at all — returns `None`, meaning "do not send
/// the field", never a guessed rung: an invalid value is a hard 400 from the
/// server, so dropping it is the only safe degradation.
pub fn normalize_reasoning_effort(raw: Option<&str>) -> Option<&'static str> {
    let value = raw?.trim().to_lowercase();
    REASONING_EFFORT_LADDER
        .into_iter()
        .find(|level| *level == value.as_str())
}

#[derive(Serialize, Clone)]
pub struct AIChunk {
    pub id: String,
    pub text: String,
}

/// Token accounting for one completion, as the provider itself reported it.
///
/// Every count is optional on purpose: the dialects differ (Anthropic never
/// sends a total; OpenAI-compatible endpoints only put `usage` on the last
/// chunk of a stream, and only when asked to; Gemini sends all three), and a
/// number nobody measured must stay absent rather than be estimated from the
/// text. A provider that omits usage entirely yields no `TokenUsage` at all
/// (see [`ai_done_payload`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct TokenUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
}

impl TokenUsage {
    /// Fold a later frame's counts into this one. Providers split their
    /// accounting across frames — Anthropic sends a partial `output_tokens` on
    /// `message_start` and the final value on `message_delta`, Gemini repeats
    /// `usageMetadata` on several chunks — so the newest value wins per field
    /// and a frame that omits a field never erases one already seen.
    pub fn merge(&mut self, other: TokenUsage) {
        if other.prompt_tokens.is_some() {
            self.prompt_tokens = other.prompt_tokens;
        }
        if other.completion_tokens.is_some() {
            self.completion_tokens = other.completion_tokens;
        }
        if other.total_tokens.is_some() {
            self.total_tokens = other.total_tokens;
        }
    }

    /// True when the provider reported at least one count.
    pub fn has_any(&self) -> bool {
        self.prompt_tokens.is_some()
            || self.completion_tokens.is_some()
            || self.total_tokens.is_some()
    }
}

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

pub fn emit_ai_error(app: &tauri::AppHandle, id: &str, message: &str) {
    let _ = app.emit(
        "ai-error",
        serde_json::json!({ "id": id, "message": message }),
    );
}

/// Fold one parsed frame's usage into a stream's running total.
pub fn accumulate_usage(total: &mut Option<TokenUsage>, delta: &SseDelta) {
    if let Some(found) = delta.usage {
        total.get_or_insert_with(TokenUsage::default).merge(found);
    }
}

/// Payload of the terminal `ai-done` event: the answer plus the provider's
/// token accounting [when it reported any](TokenUsage).
///
/// `usage` is `null` - never a zeroed or estimated object - when nothing was
/// reported, so a caller can tell "this cost nothing to measure" from "this
/// cost zero tokens". An empty usage object is normalised to `null` here so the
/// frontend has one spelling of "not reported".
pub fn ai_done_payload(id: &str, full: &str, usage: Option<TokenUsage>) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "full": full,
        "usage": usage.filter(TokenUsage::has_any),
    })
}

/// Guard against SSRF / internal-endpoint abuse via a user-supplied `base_url`,
/// and against handing the API key to a plaintext public endpoint.
///
/// Two rules, and the second one is NOT waived by the opt-in:
///
///   * **A public Base URL must be HTTPS.** HTTP is only for local development
///     addresses — `localhost`, a loopback IP, or (under the opt-in) a private
///     LAN host — so the key can never cross the public internet in the clear.
///   * **Without [`AIConfig::allow_private`]**, a host that is (or resolves to)
///     a literal private, loopback, link-local, CGNAT or unspecified address is
///     rejected, and the addresses that were vetted are returned so the client
///     can be pinned to exactly those.
///
/// [`AIConfig::allow_private`] waives the SSRF guard for a local model server
/// (Ollama / LM Studio). It does not waive the URL parse, the scheme rule or the
/// host requirement: the flag is about REACHING a private address, not about
/// dropping transport security on the public internet.
pub fn validate_base_url(cfg: &AIConfig) -> Result<Option<VettedHost>, String> {
    let Some(base) = cfg.base_url.as_deref() else {
        return Ok(None);
    };
    if cfg.allow_private {
        let url = parse_base_url(base)?;
        reject_plaintext_public_url(&url, base)?;
        return Ok(None);
    }
    validate_public_url(base).map(Some)
}

/// The addresses that were vetted for a user-supplied Base URL.
///
/// The HTTP client is pinned to exactly these, so the address reqwest dials is
/// the address this check approved. Without the pin the name is resolved
/// twice — once here, once inside reqwest — and a TTL-0 record can answer
/// `127.0.0.1` to the second lookup after answering a public address to the
/// first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VettedHost {
    /// The bare hostname (no IPv6 brackets) the addresses belong to.
    pub host: String,
    /// Empty for a literal-IP Base URL: there is no name to pin.
    pub addrs: Vec<SocketAddr>,
}

fn validate_public_url(base: &str) -> Result<VettedHost, String> {
    validate_public_url_with(base, resolve_host_addrs)
}

/// Resolve `host` to the socket addresses a connection could go to.
///
/// A resolution failure is surfaced, never swallowed: an unresolvable name
/// cannot be shown to be public, and treating that as "public" let the request
/// through completely unchecked.
fn resolve_host_addrs(host: &str) -> Result<Vec<SocketAddr>, String> {
    (host, 0u16)
        .to_socket_addrs()
        .map(|addrs| addrs.collect())
        .map_err(|_| {
            format!(
                "AI Base URL 的主机名无法解析：{host}。请检查网络连接、DNS 设置，或改用其他地址。"
            )
        })
}

fn private_url_error(host: &str) -> String {
    format!(
        "AI Base URL 指向了本机/内网地址（{host}）。为安全起见已默认拒绝连接内网。\
         如果你确实要连接本地模型（如 Ollama / LM Studio），请在设置中开启“允许本地/内网地址”后再试。"
    )
}

/// Parse a Base URL and require the shape every caller depends on: a scheme the
/// client can actually speak and a host to send to.
fn parse_base_url(base: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(base)
        .map_err(|_| format!("AI Base URL 无效：{base}（应为 http:// 或 https:// 格式）"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("AI Base URL 必须使用 http:// 或 https://：{base}"));
    }
    if url.host_str().unwrap_or("").is_empty() {
        return Err(format!("AI Base URL 缺少主机名：{base}"));
    }
    Ok(url)
}

/// Refuse a plaintext URL whose host is not local.
///
/// This is the rule that keeps the API key off the wire in the clear. The key
/// rides in `Authorization` / `x-api-key` / `x-goog-api-key`, and reqwest sends
/// those over `http://` without complaint, visible to every hop between here and
/// the provider. A local address is exempt because a local model server has no
/// certificate to offer and `http://localhost:11434` is the documented Ollama /
/// LM Studio setup — the credential never leaves the machine (or, for a host
/// the user explicitly opted into, the local network).
fn reject_plaintext_public_url(url: &reqwest::Url, base: &str) -> Result<(), String> {
    if url.scheme() != "http" {
        return Ok(());
    }
    let host = url.host_str().unwrap_or("");
    if is_private_or_loopback_host(host) {
        return Ok(());
    }
    Err(format!(
        "AI Base URL 使用了明文 HTTP，而主机（{host}）不是本机地址：{base}。\
         为避免 API Key 以明文发送到公网，公共地址必须使用 https://；\
         只有本机/内网开发地址（如 http://localhost:11434）可以使用 HTTP。"
    ))
}

fn validate_public_url_with(
    base: &str,
    resolve: impl Fn(&str) -> Result<Vec<SocketAddr>, String>,
) -> Result<VettedHost, String> {
    let url = parse_base_url(base)?;
    // The scheme rule is decided BEFORE resolution: it is the one rule that
    // cannot be waived, and a plaintext public URL must be refused on its own
    // terms rather than after a DNS lookup that a name-based bypass could steer.
    reject_plaintext_public_url(&url, base)?;
    let host = url.host_str().unwrap_or("");
    if is_private_or_loopback_host(host) {
        return Err(private_url_error(host));
    }
    // `host_str()` keeps the brackets around an IPv6 literal; they are neither
    // part of the address nor of the name reqwest resolves.
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    // A literal IP was fully decided by the check above: there is no name to
    // pin, and "resolving" it would just hand back the same address.
    if bare.parse::<IpAddr>().is_ok() {
        return Ok(VettedHost {
            host: bare.to_string(),
            addrs: Vec::new(),
        });
    }
    // A hostname must not be allowed to bypass the check by resolving to a
    // loopback or RFC1918 address — and a name that does not resolve at all
    // must be refused rather than waved through.
    let addrs = resolve(bare)?;
    if addrs.is_empty() {
        return Err(format!(
            "AI Base URL 的主机名没有解析到任何地址：{bare}。请检查 DNS 设置或改用其他地址。"
        ));
    }
    if addrs.iter().any(|a| is_private_or_loopback_ip(a.ip())) {
        return Err(private_url_error(host));
    }
    Ok(VettedHost {
        host: bare.to_string(),
        addrs,
    })
}

fn is_private_or_loopback_host(host: &str) -> bool {
    // `Url::host_str()` serialises IPv6 with surrounding brackets (`[::1]`),
    // which would not parse as an `IpAddr`; strip them so it does.
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let lower = host.to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => is_private_or_loopback_ip(ip),
        Err(_) => false,
    }
}

fn is_private_or_loopback_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 0                                        // 0.0.0.0/8 "this network"
                || o[0] == 127                                // 127.0.0.0/8 loopback
                || o[0] == 10                                 // 10.0.0.0/8 private
                || (o[0] == 100 && (16..=127).contains(&o[1])) // 100.64.0.0/10 CGNAT
                || (o[0] == 169 && o[1] == 254)               // 169.254.0.0/16 link-local
                || (o[0] == 172 && (16..=31).contains(&o[1])) // 172.16.0.0/12 private
                || (o[0] == 192 && o[1] == 168) // 192.168.0.0/16 private
        }
        std::net::IpAddr::V6(v6) => {
            let seg = v6.segments();
            v6.is_loopback()                                // ::1/128
                || v6.is_unspecified()                      // ::
                || (seg[0] & 0xfe00) == 0xfc00              // fc00::/7 unique-local
                || (seg[0] & 0xffc0) == 0xfe80              // fe80::/10 link-local
                || is_ipv4_mapped_private(v6)
        }
    }
}

/// `::ffff:a.b.c.d` — an IPv4 address embedded in IPv6. Decode the trailing 32
/// bits and re-run the IPv4 guard so a v4 range check cannot be bypassed by
/// writing the address as IPv4-mapped IPv6.
fn is_ipv4_mapped_private(v6: std::net::Ipv6Addr) -> bool {
    let seg = v6.segments();
    if !(seg[0] == 0
        && seg[1] == 0
        && seg[2] == 0
        && seg[3] == 0
        && seg[4] == 0
        && seg[5] == 0xffff)
    {
        return false;
    }
    let v4 = std::net::Ipv4Addr::new(
        (seg[6] >> 8) as u8,
        (seg[6] & 0xff) as u8,
        (seg[7] >> 8) as u8,
        (seg[7] & 0xff) as u8,
    );
    is_private_or_loopback_ip(std::net::IpAddr::V4(v4))
}

static AI_ID_SEQ: AtomicU64 = AtomicU64::new(0);

/// Format a completion id as `ai-{unix_micros}-{seq}`. The monotonic `seq`
/// disambiguates calls that land in the same microsecond, so concurrent
/// `ai_complete` invocations never share an id (which would let one finish
/// cancel the other in the shared in-flight set).
pub fn ai_id_for(micros: u64, seq: u64) -> String {
    format!("ai-{micros}-{seq}")
}

/// Generate a unique id for a completion: unix-micros timestamp plus a
/// process-local monotonic sequence counter.
pub fn next_ai_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let micros = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64;
    let seq = AI_ID_SEQ.fetch_add(1, Ordering::Relaxed);
    ai_id_for(micros, seq)
}

/// Rolling line buffer that reassembles SSE lines split across arbitrary-size
/// network chunks. `feed` appends a raw BYTES chunk and returns the complete
/// lines (without their trailing newline), keeping any trailing partial bytes
/// buffered until their newline arrives.
///
/// Buffering raw bytes instead of decoded text matters for CJK (and any
/// multi-byte UTF-8): a network chunk boundary can split a character, and
/// decoding each chunk on its own would turn the orphaned bytes into U+FFFD.
/// Here the bytes are only decoded once the line is complete — a `\n` byte can
/// never occur inside a multi-byte UTF-8 sequence, so splitting on `b'\n'`
/// cannot itself corrupt one. Without the byte buffering, a `data:{...}` event
/// split across two chunks would also fail JSON parse in both halves and be
/// silently dropped.
///
/// The buffer is bounded by [`MAX_SSE_LINE_BYTES`]. Because every complete line
/// is drained the moment its newline arrives, the only thing that ever stays
/// buffered is ONE unterminated line — so that single ceiling is also the
/// ceiling on the buffer. A peer that streams bytes without ever sending a
/// newline is refused rather than buffered.
#[derive(Debug, Default)]
pub struct SseBuffer {
    pending: Vec<u8>,
}

impl SseBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append a chunk and return the lines it completed.
    ///
    /// `Err` means the reassembly buffer's invariant is broken (a frame past
    /// [`MAX_SSE_LINE_BYTES`]): the caller must abandon the response, because
    /// the frame boundary it is waiting for can no longer be trusted to be a
    /// frame — a peer that never sends a newline has no lines left to give.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        let mut lines = Vec::new();
        let mut rest = chunk;
        // Walk the chunk instead of appending it whole: a single chunk may hold
        // thousands of complete frames, and buffering all of them before
        // checking the size would defeat the ceiling it is meant to enforce.
        while let Some(nl) = rest.iter().position(|&b| b == b'\n') {
            let (line, tail) = rest.split_at(nl + 1);
            self.buffer(line)?;
            lines.push(self.take_line());
            rest = tail;
        }
        // Whatever is left has no newline yet: it is the start (or middle) of
        // the next line and stays buffered.
        self.buffer(rest)?;
        Ok(lines)
    }

    /// Append bytes to the pending line, refusing to grow past the ceiling.
    fn buffer(&mut self, bytes: &[u8]) -> Result<(), String> {
        if self.pending.len() + bytes.len() > MAX_SSE_LINE_BYTES {
            return Err(format!(
                "AI 响应帧过大（超过 {} 字节），已中止本次生成。",
                MAX_SSE_LINE_BYTES
            ));
        }
        self.pending.extend_from_slice(bytes);
        Ok(())
    }

    /// Decode and drain the pending line. Only called right after a segment
    /// ending in `\n` was appended, so the pending bytes are exactly one
    /// complete line and its last byte is that newline.
    fn take_line(&mut self) -> String {
        let nl = self.pending.len() - 1;
        let line: Vec<u8> = self.pending.drain(..=nl).collect();
        String::from_utf8_lossy(&line)
            .trim_end_matches(['\r', '\n'])
            .to_string()
    }

    /// Drain any bytes still buffered once the stream has ended, as one final
    /// line. Providers terminate the last event with a newline, so this is a
    /// no-op in practice; it only matters when a server ends the response
    /// mid-line, where dropping the tail could lose a final (otherwise
    /// complete) event.
    pub fn flush(&mut self) -> Vec<String> {
        if self.pending.is_empty() {
            return Vec::new();
        }
        let rest = std::mem::take(&mut self.pending);
        let line = String::from_utf8_lossy(&rest)
            .trim_end_matches(['\r', '\n'])
            .to_string();
        if line.is_empty() {
            Vec::new()
        } else {
            vec![line]
        }
    }
}

/// Default API base for a provider that speaks the OpenAI wire format, used
/// when the caller supplies no explicit Base URL.
///
/// Without this the `_` arm of `endpoint_default` sent every such provider to
/// api.openai.com: a Grok or DeepSeek request would reach OpenAI's host and be
/// rejected there (with the user's key handed to the wrong origin). `local` is
/// intentionally absent — a local model server always needs an explicit URL,
/// and guessing one would be worse than surfacing the missing setting.
pub fn default_base_url(provider: &str) -> &'static str {
    match provider {
        "grok" => "https://api.x.ai/v1",
        "deepseek" => "https://api.deepseek.com/v1",
        _ => "https://api.openai.com/v1",
    }
}

/// One parsed SSE event: the visible answer text and, separately, any
/// reasoning progress. They stay distinct because they go to different places —
/// `text` is appended to the document, `reasoning` only drives a "thinking"
/// indicator (see `extract_openai_reasoning`).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SseDelta {
    pub text: Option<String>,
    pub reasoning: Option<String>,
    /// The provider said why it stopped: `length` (token budget exhausted),
    /// `content_filter`, `stop`, … `None` when the frame did not report it.
    pub finish_reason: Option<String>,
    /// The server ended the event stream (`data: [DONE]`).
    pub done: bool,
    /// The server reported a failure INSIDE the stream (HTTP was 200).
    pub error: Option<String>,
    /// Token counts the frame carried, when it carried any. `None` on every
    /// frame of a provider (or endpoint) that reports no usage.
    pub usage: Option<TokenUsage>,
}

pub fn build_prompt(cursor_prefix: &str) -> String {
    format!(
        "Continue writing the following text. Only output the continuation, no preamble.\n\n{}\n",
        cursor_prefix.trim_end()
    )
}

/// Split a data URL (`data:<mime>[;base64],<data>`) into its media type and
/// payload. Anthropic/Gemini require the mime and base64 separately, while the
/// OpenAI-compatible path sends the whole data URL verbatim as `image_url.url`.
/// A malformed value falls back to `image/png` so the request body stays valid.
pub(crate) fn split_data_url(data_url: &str) -> (String, String) {
    let s = data_url.strip_prefix("data:").unwrap_or(data_url);
    let (meta, data) = match s.split_once(',') {
        Some((m, d)) => (m, d),
        None => ("", s),
    };
    let mime = meta.split(';').next().unwrap_or("").trim();
    let mime = if mime.is_empty() {
        "image/png".to_string()
    } else {
        mime.to_string()
    };
    (mime, data.to_string())
}

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

/// Extract stable, sorted model IDs from a provider's `/models` response.
///
/// Robust across providers: OpenAI-compatible and Anthropic place their
/// entries in a `data` array with an `id` field; Gemini uses a `models` array
/// holding a fully-qualified `name` (e.g. `models/gemini-2.5-pro`) that we
/// reduce to its final segment. An empty or unparseable body yields an empty
/// list so the caller can degrade gracefully.
pub fn parse_model_ids(body: &str, _provider: &str) -> Vec<String> {
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = v
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| v.get("models").and_then(|m| m.as_array()));
    let Some(arr) = arr else {
        return Vec::new();
    };
    let mut ids: Vec<String> = Vec::new();
    for item in arr {
        let id = item
            .get("id")
            .and_then(|x| x.as_str())
            .map(str::to_string)
            .or_else(|| {
                item.get("name")
                    .and_then(|x| x.as_str())
                    .map(|n| n.rsplit('/').next().unwrap_or(n).to_string())
            });
        if let Some(id) = id {
            if !id.trim().is_empty() {
                ids.push(id);
            }
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

/// Build a readable, provider-agnostic failure message for a non-2xx HTTP
/// status returned by an AI provider.
///
/// `Response::error_for_status` only flags 4xx/5xx (client/server errors), so
/// in practice `status` is one of those ranges; the mapping stays total so an
/// unknown code still yields a generic line, making the function safe to call
/// directly and unit-testable without a live endpoint. Extracting it keeps
/// `list_models` and `stream_complete` from each re-deriving a one-off message,
/// and surfaces a friendly hint (e.g. a bad API key hides a 401 as "无效") instead
/// of a bare reqwest status string.
pub fn http_error_message(status: u16) -> String {
    http_error_message_with_detail(status, None)
}

/// The status hint, with the provider's own explanation appended when there is
/// one.
///
/// The status alone routinely points at the wrong thing. Measured against a
/// real gateway: an unknown MODEL NAME is answered with HTTP 403 and a body
/// saying `The current group does not support the requested model …; available
/// models: deepseek-flash` — so the user was told "your API key is invalid" and
/// spent their time re-entering a key that worked perfectly, while the message
/// that named the usable model sat in a response body nobody read. An image
/// sent to a text-only model is a 400 ("unsupported image"), which read as
/// "malformed request". A 402 is a billing problem, not a network one.
///
/// The detail is taken from the provider's JSON (`error.message`) when it
/// parses, otherwise the raw text is used verbatim; it is capped so a provider
/// cannot fill the toast with a wall of text.
pub fn http_error_message_with_detail(status: u16, detail: Option<&str>) -> String {
    let hint = match status {
        400 => "请求格式不正确（模型可能不支持本次内容，例如图片）",
        401 => "API Key 无效，请检查设置",
        402 => "账户余额不足，请检查服务商账单",
        403 => "没有权限：可能是 API Key 或模型名不被该服务商支持",
        404 => "接口或模型不存在，请检查 Base URL 与模型名",
        413 => "请求体过大（图片或附件太多）",
        422 => "服务商无法处理本次请求",
        429 => "请求过于频繁，请稍后重试",
        500 | 502 | 503 | 504 => "服务端暂时不可用，请稍后重试",
        _ => "请求失败",
    };
    match detail.map(str::trim).filter(|d| !d.is_empty()) {
        Some(detail) => {
            let mut shown = detail.to_string();
            if shown.chars().count() > 300 {
                shown = shown.chars().take(300).collect::<String>() + "…";
            }
            format!("AI 请求失败：HTTP {status}，{hint}。服务商说明：{shown}")
        }
        None => format!("AI 请求失败：HTTP {status}，{hint}"),
    }
}

/// A human-readable message from a non-2xx response body, for the two JSON
/// shapes the supported providers use. Falls back to the trimmed body text.
pub fn error_detail_from_body(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(message) = v
            .get("error")
            .and_then(|e| e.get("message"))
            .or_else(|| v.get("error").and_then(|e| e.as_str().map(|_| e)))
            .or_else(|| v.get("message"))
            .and_then(|m| m.as_str())
        {
            return Some(message.to_string());
        }
    }
    Some(trimmed.to_string())
}

/// Parse one SSE line for a provider and append any delta to `acc`.
/// Returns the incremental text, or `None` for comments, blanks, `[DONE]`,
/// and non-data lines. The accumulated `acc` is used for the final `full`.
///
/// `acc` grows by whatever the line carries and is NOT bounded here: the
/// ceiling on a live answer ([`MAX_ANSWER_BYTES`]) belongs to the stream that
/// owns the accumulation, and that is [`CompletionStream`]. Anything streaming
/// a provider response must go through it rather than calling this directly in
/// a loop.
pub fn parse_sse_event(line: &str, provider: &str, acc: &mut String) -> Option<SseDelta> {
    let line = line.trim();
    if !line.starts_with("data:") {
        return None;
    }
    let raw = line.trim_start_matches("data:").trim();
    if raw == "[DONE]" {
        // The end of an OpenAI-compatible event stream. A server is allowed to
        // keep the connection open afterwards (and some do), so the caller has to
        // treat this as "the stream is finished" rather than waiting for EOF:
        // the answer is already complete, but without this signal it would sit
        // invisible until the connection closed or the read timeout fired — and
        // a timeout would then be reported as a failure of a request that had
        // actually succeeded.
        return Some(SseDelta {
            done: true,
            ..SseDelta::default()
        });
    }
    let v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return None,
    };
    // In-band errors arrive on a 200 response as a normal event:
    // `{"error":{"message":"rate limit exceeded"}}` for the OpenAI-compatible
    // family, `{"type":"error","error":{...}}` for Anthropic. Ignoring them made
    // a truncated answer look like a complete one, so they are surfaced as an
    // error event instead of being dropped.
    if let Some(message) = extract_stream_error(&v) {
        return Some(SseDelta {
            error: Some(message),
            ..SseDelta::default()
        });
    }
    let text = match provider {
        "anthropic" => openai_compatible::extract_anthropic_text(&v),
        "gemini" => gemini::extract_text(&v),
        _ => openai_compatible::extract_openai_text(&v),
    };
    if let Some(t) = &text {
        acc.push_str(t);
    }
    // Only the OpenAI-compatible family reports separate reasoning today; the
    // other providers return their thinking inline or not at all.
    let reasoning = match provider {
        "anthropic" | "gemini" => None,
        _ => openai_compatible::extract_openai_reasoning(&v),
    };
    // Why the provider stopped, when it says so: `length` means the answer was
    // cut off by the token budget, `content_filter` means it was suppressed.
    // Both used to be indistinguishable from a normal completion.
    let finish_reason = [
        // OpenAI-compatible: `choices[0].finish_reason`
        v.get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("finish_reason")),
        // Anthropic, top level (`message_delta` carries it inside `delta`)
        v.get("stop_reason"),
        v.get("delta").and_then(|d| d.get("stop_reason")),
        // Gemini, `candidates[0].finishReason`
        v.get("candidates")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("finishReason")),
    ]
    .into_iter()
    .flatten()
    .find_map(|f| f.as_str())
    .map(str::to_string);
    // Token accounting, where each dialect puts it. A usage-only frame is a
    // real frame: OpenAI-compatible endpoints answer an
    // `stream_options.include_usage` request with a last chunk that has an empty
    // `choices` array and nothing but `usage`, and Gemini attaches
    // `usageMetadata` to chunks that carry no text at all.
    let usage = match provider {
        "anthropic" => openai_compatible::extract_anthropic_usage(&v),
        "gemini" => gemini::extract_usage(&v),
        _ => openai_compatible::extract_openai_usage(&v),
    };
    if text.is_none() && reasoning.is_none() && finish_reason.is_none() && usage.is_none() {
        return None;
    }
    Some(SseDelta {
        text,
        reasoning,
        finish_reason,
        usage,
        ..SseDelta::default()
    })
}

/// Pull a human-readable message out of an in-band SSE error frame, for either
/// dialect. Returns `None` when the frame is not an error at all.
fn extract_stream_error(v: &serde_json::Value) -> Option<String> {
    let is_anthropic_error = v.get("type").and_then(|t| t.as_str()) == Some("error");
    let err = v.get("error");
    if err.is_none() && !is_anthropic_error {
        return None;
    }
    let message = err
        .and_then(|e| {
            e.get("message")
                .and_then(|m| m.as_str())
                .or_else(|| e.as_str())
                .map(str::to_string)
        })
        .or_else(|| {
            v.get("message")
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "服务端在流中返回了错误".to_string());
    let kind = err
        .and_then(|e| e.get("type").and_then(|t| t.as_str()))
        .unwrap_or("");
    Some(if kind.is_empty() {
        message
    } else {
        format!("{message}（{kind}）")
    })
}

/// Text-only view of one SSE line, for callers (and tests) that just want the
/// document-visible delta. Reasoning progress is dropped.
pub fn parse_sse_line(line: &str, provider: &str, acc: &mut String) -> Option<String> {
    parse_sse_event(line, provider, acc).and_then(|d| d.text)
}

/// What one folded chunk produced, in the order it must be delivered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEvent {
    /// Answer text to append to the document.
    Text(String),
    /// Reasoning progress; drives the "thinking" indicator only, never the text.
    Reasoning(String),
    /// The provider ended the stream (`data: [DONE]`).
    Done,
    /// The provider reported a failure INSIDE an HTTP 200 response.
    ProviderError(String),
}

/// The streaming state of ONE completion: the SSE reassembly buffer, the answer
/// being accumulated, the provider's token accounting and the reason it
/// stopped.
///
/// This is the streaming loop minus the socket and minus the Tauri events, so
/// the response-side size policy ([`MAX_SSE_LINE_BYTES`] on reassembly,
/// [`MAX_ANSWER_BYTES`] on the accumulated answer) is enforced in one place and
/// can be driven in tests without a running app. The caller owns the transport
/// and the emits: feed it bytes, deliver the events it returns, stop on `Done`.
#[derive(Debug)]
pub struct CompletionStream {
    provider: String,
    buffer: SseBuffer,
    full: String,
    usage: Option<TokenUsage>,
    reasoning_seen: bool,
    finish_reason: Option<String>,
}

impl CompletionStream {
    pub fn new(provider: &str) -> Self {
        Self {
            provider: provider.to_string(),
            buffer: SseBuffer::new(),
            full: String::new(),
            usage: None,
            reasoning_seen: false,
            finish_reason: None,
        }
    }

    /// Fold one network chunk.
    ///
    /// `Err` is a coded ceiling (an oversized frame, an over-long answer): the
    /// caller must stop, report it and abandon the connection. A PROVIDER error
    /// inside a 200 response is deliberately NOT an `Err` — it comes back as a
    /// [`StreamEvent::ProviderError`] so any deltas the same chunk produced
    /// first are still delivered, which is what the loop did before the fold
    /// moved here.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<StreamEvent>, String> {
        let lines = self.buffer.feed(chunk)?;
        self.fold(lines)
    }

    /// Fold the bytes still buffered after the stream ended (a server that
    /// stopped mid-line). A cancelled stream must NOT be flushed: the tail of
    /// an abandoned response is how a late chunk got adopted by the next
    /// request.
    pub fn finish(&mut self) -> Result<Vec<StreamEvent>, String> {
        let lines = self.buffer.flush();
        self.fold(lines)
    }

    fn fold(&mut self, lines: Vec<String>) -> Result<Vec<StreamEvent>, String> {
        let mut events = Vec::new();
        for line in lines {
            let Some(delta) = parse_sse_event(&line, &self.provider, &mut self.full) else {
                continue;
            };
            accumulate_usage(&mut self.usage, &delta);
            if let Some(message) = delta.error {
                events.push(StreamEvent::ProviderError(message));
                return Ok(events);
            }
            if delta.done {
                events.push(StreamEvent::Done);
                return Ok(events);
            }
            if let Some(reason) = delta.finish_reason {
                self.finish_reason = Some(reason);
            }
            if let Some(reasoning) = delta.reasoning {
                self.reasoning_seen = true;
                events.push(StreamEvent::Reasoning(reasoning));
            }
            if let Some(text) = delta.text {
                events.push(StreamEvent::Text(text));
            }
            // The answer ceiling is checked beside the accumulation it bounds,
            // and it has to be checked here rather than at the end: without it
            // `full` grows for as long as the provider keeps sending. The
            // overshoot is one frame, since that is the granularity of a check
            // that also has to keep streaming in real time.
            if self.full.len() > MAX_ANSWER_BYTES {
                return Err(format!(
                    "AI 回答过长（超过 {} 字节），已中止本次生成。",
                    MAX_ANSWER_BYTES
                ));
            }
        }
        Ok(events)
    }

    /// The answer accumulated so far.
    pub fn answer(&self) -> &str {
        &self.full
    }

    /// Token counts the provider reported, when it reported any.
    pub fn usage(&self) -> Option<TokenUsage> {
        self.usage
    }

    /// Why the provider said it stopped (`length`, `content_filter`, `stop`, …).
    pub fn finish_reason(&self) -> Option<&str> {
        self.finish_reason.as_deref()
    }

    /// True when the provider streamed reasoning progress. An answer-less
    /// completion that reasoned spent its budget thinking, which is not an
    /// ordinary empty reply.
    pub fn saw_reasoning(&self) -> bool {
        self.reasoning_seen
    }
}

fn is_active(app: &tauri::AppHandle, id: &str) -> bool {
    let state = app.state::<AiState>();
    let guard = state.inflight.lock();
    match guard {
        Ok(inflight) => inflight.contains(id),
        Err(_) => false,
    }
}

/// Deliver one folded chunk's events in order, returning `true` once the
/// provider has ended the stream (`data: [DONE]`).
///
/// The reasoning text is emitted as PROGRESS only and never appended to the
/// answer: a reasoning model streams its thinking before any answer text, and
/// the ghost writer types whatever the answer streams straight into the
/// document — the model's internal monologue is not part of the note. An
/// in-band provider error is emitted AND returned as `Err`, because a 200
/// response that carries an error frame is a truncated answer, not a complete
/// one.
fn deliver_events(
    app: &tauri::AppHandle,
    id: &str,
    events: Vec<StreamEvent>,
) -> Result<bool, String> {
    let mut done = false;
    for event in events {
        match event {
            StreamEvent::Text(text) => {
                let _ = app.emit(
                    "ai-chunk",
                    AIChunk {
                        id: id.to_string(),
                        text,
                    },
                );
            }
            StreamEvent::Reasoning(text) => {
                let _ = app.emit(
                    "ai-reasoning",
                    serde_json::json!({ "id": id, "text": text }),
                );
            }
            StreamEvent::Done => done = true,
            StreamEvent::ProviderError(message) => {
                emit_ai_error(app, id, &message);
                return Err(message);
            }
        }
    }
    Ok(done)
}

/// Resolve the API key for an AI request. The key is never disclosed to the
/// window (see `keys::load_ai_key`, which returns only a masked indicator), so
/// the backend injects the *stored* key for the provider here when the caller
/// did not supply a real one. A real key supplied by the app's own settings
/// page (a freshly typed, not-yet-saved key) is kept as-is; only a missing or
/// masked value is backfilled from the vault.
pub fn hydrate_stored_key(app: &tauri::AppHandle, config: &mut AIConfig) -> Result<(), String> {
    if let Some(k) = config.api_key.as_deref() {
        if k != AI_KEY_MASKED {
            return Ok(());
        }
    }
    if let Some(stored) = load_ai_key_internal(app, &config.provider)? {
        config.api_key = Some(stored);
    }
    Ok(())
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

/// Read a response body under a hard ceiling.
///
/// `Response::text()` reads whatever the peer sends, so a hostile or broken
/// endpoint can make the backend allocate for as long as it keeps sending —
/// unbounded, on the same thread budget as everything else the app is doing.
/// Here the read stops at `limit` and says so.
///
/// The two checks defend different peers: `content_length` refuses an honest
/// oversized body before a single byte is buffered, and the running total
/// catches the chunked response that declares no length at all (which is what a
/// server streaming an endless body uses, deliberately or not).
async fn read_body_bounded(response: reqwest::Response, limit: usize) -> Result<String, String> {
    let declared = response.content_length();
    if declared.is_some_and(|len| len > limit as u64) {
        return Err(oversized_response_error(limit));
    }
    let mut stream = response.bytes_stream();
    let mut body: Vec<u8> = Vec::with_capacity(declared.unwrap_or(0).min(limit as u64) as usize);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if body.len() + chunk.len() > limit {
            return Err(oversized_response_error(limit));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

fn oversized_response_error(limit: usize) -> String {
    format!("AI 服务商响应过大（超过 {limit} 字节），已中止读取。")
}

/// Resolve the provider's `GET {endpoint}` for listing models, matching the
/// base/credential conventions of `resolve_endpoint` so the dropdown pulls from
/// the same origin a completion would use.
pub async fn list_models(config: &AIConfig) -> Result<Vec<String>, String> {
    // Reject a private/loopback Base URL unless the user opts in (see
    // `validate_base_url`); a model dropdown must never phone an internal host.
    let pin = validate_base_url(config)?;
    let client = ai_http_client(
        Duration::from_secs(15),
        Duration::from_secs(15),
        pin.as_ref(),
    )
    .map_err(|e| e.to_string())?;

    let (url, headers): (String, Vec<(String, String)>) = match config.provider.as_str() {
        "anthropic" => {
            let base = config
                .base_url
                .clone()
                .unwrap_or_else(|| "https://api.anthropic.com".into());
            let url = format!("{}/v1/models", base.trim_end_matches('/'));
            let mut headers = vec![("anthropic-version".to_string(), "2023-06-01".to_string())];
            if let Some(key) = &config.api_key {
                headers.push(("x-api-key".to_string(), key.clone()));
            }
            (url, headers)
        }
        "gemini" => {
            let base = config
                .base_url
                .clone()
                .unwrap_or_else(|| "https://generativelanguage.googleapis.com".into());
            // Keep the key out of the URL; it rides in the `x-goog-api-key`
            // header instead so it is never logged by a proxy/server.
            let url = format!("{}/v1beta/models", base.trim_end_matches('/'));
            let headers = if let Some(key) = &config.api_key {
                vec![("x-goog-api-key".to_string(), key.clone())]
            } else {
                Vec::new()
            };
            (url, headers)
        }
        _ => {
            let base = config
                .base_url
                .clone()
                .unwrap_or_else(|| default_base_url(&config.provider).to_string());
            let url = format!("{}/models", base.trim_end_matches('/'));
            let headers = if let Some(key) = &config.api_key {
                vec![("Authorization".to_string(), format!("Bearer {key}"))]
            } else {
                Vec::new()
            };
            (url, headers)
        }
    };

    let mut request = client.get(&url);
    for (k, v) in &headers {
        request = request.header(k, v);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("请求模型列表失败：{e}"))?;
    let status = response.status();
    if !status.is_success() {
        // Same reasoning as the completion path: the body says WHY (wrong key,
        // wrong base URL, unknown model), and that is what the user needs. The
        // read is bounded even here - an error page is peer-controlled bytes
        // too - and a body past that ceiling simply yields no detail, because
        // the status hint is the part that has to survive.
        let detail = read_body_bounded(response, MAX_ERROR_BODY_BYTES)
            .await
            .ok()
            .and_then(|body| error_detail_from_body(&body));
        return Err(http_error_message_with_detail(
            status.as_u16(),
            detail.as_deref(),
        ));
    }
    let body = read_body_bounded(response, MAX_MODELS_RESPONSE_BYTES).await?;

    // A blank body is a legitimate "no models" signal; anything non-empty must
    // still parse as JSON, otherwise a 500 error page would silently surface as
    // an empty dropdown instead of a real error.
    if body.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<serde_json::Value>(&body)
        .map_err(|e| format!("模型列表响应解析失败：{e}"))?;
    Ok(parse_model_ids(&body, &config.provider))
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

    // Per-phase timeouts instead of a total-request deadline: `Client::timeout`
    // caps the WHOLE request including the streaming body, so any completion
    // longer than the cap aborts mid-stream. `connect_timeout` bounds the
    // connection phase and `read_timeout` bounds each single read, so a stalled
    // provider still cannot hang the stream forever (cooperative cancel only
    // interrupts between chunks) while a long, actively-streaming completion
    // runs to its natural end. The timeout error surfaces through
    // `request.send()` / `bytes_stream()` and produces the same `ai-error` +
    // `Err` path as a transport failure.
    let client =
        ai_http_client(Duration::from_secs(15), Duration::from_secs(120), pin).map_err(|e| {
            emit_ai_error(app, id, &e.to_string());
            e.to_string()
        })?;

    // The pre-serialised payload is sent verbatim, so the body on the wire is
    // byte-for-byte the body `encode_request_body` measured and approved.
    let mut request = client
        .post(&url)
        .header("content-type", "application/json")
        .body(payload);
    match config.provider.as_str() {
        "anthropic" => {
            if let Some(key) = &config.api_key {
                request = request.header("x-api-key", key);
            }
            request = request.header("anthropic-version", "2023-06-01");
        }
        "gemini" => {
            // Gemini keys ride in the `x-goog-api-key` header, NOT in the URL
            // (removed from `resolve_endpoint`) and NOT `Authorization: Bearer`
            // (Gemini rejects Bearer auth). Keeping it in a header stops the
            // secret from being logged by proxies/servers.
            if let Some(key) = &config.api_key {
                request = request.header("x-goog-api-key", key);
            }
        }
        _ => {
            if let Some(key) = &config.api_key {
                request = request.header("Authorization", format!("Bearer {key}"));
            }
        }
    }

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

    #[test]
    fn rejects_loopback_and_private_bases() {
        for base in [
            "http://localhost:11434",
            "http://localhost:11434/v1",
            "http://127.0.0.1:11434",
            "http://10.0.0.5",
            "http://172.16.0.1",
            "http://172.31.255.255",
            "http://192.168.1.1",
            "http://169.254.169.254",
            "http://100.64.0.1",
            "http://0.0.0.0:8080",
            "http://[::1]:8080",
            "http://[fc00::1]",
            "http://[fe80::1]",
            "http://[::ffff:127.0.0.1]",
        ] {
            assert!(validate_public_url(base).is_err(), "should reject {base}");
        }
    }

    #[test]
    fn helper_flags_private_loopback_and_mapped_ips() {
        for host in [
            "127.0.0.1",
            "10.0.0.5",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "::",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.0.5",
            "localhost",
        ] {
            assert!(is_private_or_loopback_host(host), "should flag {host}");
        }
        for host in [
            "8.8.8.8",
            "203.0.113.9",
            "2606:4700:4700::1111",
            "api.openai.com",
        ] {
            assert!(!is_private_or_loopback_host(host), "should allow {host}");
        }
    }

    /// A vetted address for the injected resolvers below. Port is irrelevant
    /// to the policy under test.
    fn sa(ip: &str) -> SocketAddr {
        SocketAddr::new(ip.parse().unwrap(), 443)
    }

    #[test]
    fn accepts_public_https_bases() {
        // The resolver is injected so this test asserts the scheme/host policy
        // and never touches the network or depends on real DNS.
        let public = |_host: &str| Ok(vec![sa("203.0.113.9")]);
        for base in [
            "https://api.openai.com/v1",
            "https://generativelanguage.googleapis.com",
            "https://api.anthropic.com",
            "https://llm.internal.example.com",
        ] {
            assert!(
                validate_public_url_with(base, public).is_ok(),
                "should accept {base}"
            );
        }
    }

    /// The roadmap's rule, at the unit level: a public Base URL must be HTTPS.
    ///
    /// This USED to be accepted ("http://203.0.113.9:8000/v1" sat in the
    /// accepted list above) — the request went out with the API key in an
    /// `Authorization` header over plaintext, readable by every hop. The check
    /// here must decide before resolution, so a name never causes a lookup it
    /// was going to fail anyway.
    #[test]
    fn rejects_plaintext_http_to_a_public_host() {
        let resolve =
            |_host: &str| panic!("a plaintext public URL must be refused before any lookup");
        for base in [
            "http://203.0.113.9:8000/v1",
            "http://llm.example.com/v1",
            "http://8.8.8.8/v1",
        ] {
            let err = validate_public_url_with(base, resolve)
                .expect_err("plain HTTP to a public host must be refused");
            assert!(err.contains("https://"), "{base}: {err}");
            assert!(err.contains("明文"), "{base}: {err}");
        }
    }

    #[test]
    fn a_local_http_base_is_kept_for_the_opt_in_path() {
        // `localhost` and loopback are the one HTTP exemption, so the plaintext
        // rule must not be what refuses them (the private-host rule is, on the
        // default path — that is what `allow_private` exists to lift).
        for base in ["http://localhost:11434", "http://127.0.0.1:11434"] {
            let cfg = AIConfig {
                base_url: Some(base.into()),
                allow_private: true,
                ..Default::default()
            };
            assert!(validate_base_url(&cfg).is_ok(), "{base} must stay usable");
        }
    }

    #[test]
    fn rejects_non_http_schemes_and_missing_host() {
        assert!(validate_public_url("ftp://example.com").is_err());
        assert!(validate_public_url("file:///etc/passwd").is_err());
        assert!(validate_public_url("http://").is_err());
        assert!(validate_public_url("not a url").is_err());
    }

    #[test]
    fn hostname_resolving_to_loopback_is_rejected() {
        let resolve = |host: &str| {
            if host == "evil.example.com" {
                Ok(vec![sa("127.0.0.1")])
            } else {
                Ok(vec![sa("203.0.113.9")])
            }
        };
        assert!(
            validate_public_url_with("https://evil.example.com/v1", resolve).is_err(),
            "DNS to loopback must be rejected"
        );
        assert!(
            validate_public_url_with("https://ok.example.com/v1", resolve).is_ok(),
            "public resolution must still pass"
        );
    }

    #[test]
    fn mixed_public_and_private_resolved_ips_are_rejected() {
        let resolve = |_host: &str| Ok(vec![sa("203.0.113.9"), sa("10.0.0.1")]);
        assert!(validate_public_url_with("https://dual.example.com", resolve).is_err());
    }

    #[test]
    fn unresolved_hostname_is_rejected() {
        // A name that does not resolve cannot be shown to be public. Treating
        // this as "public" let the request through with no check at all.
        let resolve = |_host: &str| Err("resolution failed".to_string());
        assert!(validate_public_url_with("https://no-such.example.invalid", resolve).is_err());
    }

    #[test]
    fn a_hostname_resolving_to_nothing_is_rejected() {
        let resolve = |_host: &str| Ok(Vec::new());
        assert!(validate_public_url_with("https://empty.example.com", resolve).is_err());
    }

    #[test]
    fn a_vetted_hostname_hands_back_the_addresses_to_pin() {
        // The pin is what closes the DNS-rebinding window: the client may only
        // connect to the addresses this check saw.
        let resolve = |_host: &str| Ok(vec![sa("203.0.113.9"), sa("203.0.113.10")]);
        let vetted =
            validate_public_url_with("https://ok.example.com/v1", resolve).expect("public host");
        assert_eq!(vetted.host, "ok.example.com");
        assert_eq!(vetted.addrs.len(), 2);
    }

    #[test]
    fn a_literal_ip_base_has_nothing_to_pin_and_is_not_resolved() {
        let resolve = |_host: &str| panic!("a literal IP must never be resolved");
        let vetted = validate_public_url_with("https://203.0.113.9:8000/v1", resolve)
            .expect("public literal ip");
        assert!(vetted.addrs.is_empty());
    }

    #[test]
    fn an_ipv6_literal_is_stripped_of_its_brackets_for_the_vetted_host() {
        let vetted = validate_public_url("https://[2606:4700:4700::1111]/v1").expect("public ipv6");
        assert_eq!(vetted.host, "2606:4700:4700::1111");
        assert!(vetted.addrs.is_empty());
    }

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

    #[test]
    fn allow_private_opts_out() {
        let cfg = AIConfig {
            provider: "openai".into(),
            model: "gpt-4o".into(),
            base_url: Some("http://localhost:11434/v1".into()),
            api_key: None,
            temperature: None,
            max_tokens: None,
            system_prompt: None,
            reasoning_effort: None,
            allow_private: true,
        };
        assert!(validate_base_url(&cfg).is_ok());
    }

    #[test]
    fn default_bases_are_not_rejected() {
        let cfg = AIConfig {
            provider: "openai".into(),
            model: "gpt-4o".into(),
            base_url: None,
            api_key: None,
            temperature: None,
            max_tokens: None,
            system_prompt: None,
            reasoning_effort: None,
            allow_private: false,
        };
        assert!(validate_base_url(&cfg).is_ok());
    }

    #[test]
    fn openai_usage_is_read_from_the_final_chunk() {
        let mut acc = String::new();
        let line = r#"data: {"id":"1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}"#;
        let delta = parse_sse_event(line, "openai", &mut acc).expect("usage frame");
        assert_eq!(delta.text, None, "a usage frame carries no answer text");
        assert_eq!(
            delta.usage,
            Some(TokenUsage {
                prompt_tokens: Some(12),
                completion_tokens: Some(3),
                total_tokens: Some(15),
            })
        );
    }

    #[test]
    fn anthropic_usage_is_merged_across_message_start_and_delta() {
        let mut acc = String::new();
        let mut usage: Option<TokenUsage> = None;
        for line in [
            r#"data: {"type":"message_start","message":{"usage":{"input_tokens":40,"output_tokens":1}}}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":17}}"#,
        ] {
            let delta = parse_sse_event(line, "anthropic", &mut acc).expect("anthropic frame");
            accumulate_usage(&mut usage, &delta);
        }
        assert_eq!(
            usage,
            Some(TokenUsage {
                prompt_tokens: Some(40),
                completion_tokens: Some(17),
                total_tokens: None,
            }),
            "the final output_tokens must replace the partial one message_start sent"
        );
    }

    #[test]
    fn a_stream_that_reports_no_usage_ends_with_null_and_invents_nothing() {
        let mut acc = String::new();
        let mut usage: Option<TokenUsage> = None;
        for line in [
            r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#,
            "data: [DONE]",
        ] {
            if let Some(delta) = parse_sse_event(line, "openai", &mut acc) {
                accumulate_usage(&mut usage, &delta);
            }
        }
        assert_eq!(usage, None);
        let payload = ai_done_payload("ai-1", "hi", usage);
        assert_eq!(payload["id"], "ai-1");
        assert_eq!(payload["full"], "hi");
        assert_eq!(payload["usage"], serde_json::Value::Null);
        // An all-empty usage object is the same "not reported", not a 0-token
        // completion.
        let empty = ai_done_payload("ai-1", "hi", Some(TokenUsage::default()));
        assert_eq!(empty["usage"], serde_json::Value::Null);
    }

    #[test]
    fn malformed_usage_fields_are_ignored_not_converted_to_numbers() {
        // A count that is not a non-negative integer was not measured: it must
        // stay absent instead of being cast into a number nobody sent.
        let mut acc = String::new();
        for (line, provider) in [
            (
                r#"data: {"choices":[{"delta":{"content":"hi"}}],"usage":"lots"}"#,
                "openai",
            ),
            (
                r#"data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":"12","completion_tokens":-3,"total_tokens":1.5}}"#,
                "openai",
            ),
            (
                r#"data: {"choices":[{"delta":{"content":"hi"}}],"usage":{}}"#,
                "openai",
            ),
            (
                r#"data: {"type":"message_delta","delta":{"text":"hi"},"usage":{"output_tokens":{}}}"#,
                "anthropic",
            ),
            (
                r#"data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"usageMetadata":{"promptTokenCount":"9"}}"#,
                "gemini",
            ),
        ] {
            let delta = parse_sse_event(line, provider, &mut acc)
                .unwrap_or_else(|| panic!("frame was dropped: {line}"));
            assert_eq!(delta.usage, None, "must not convert {line}");
        }
    }

    #[test]
    fn ai_done_payload_carries_the_reported_usage() {
        let usage = TokenUsage {
            prompt_tokens: Some(40),
            completion_tokens: Some(17),
            total_tokens: None,
        };
        let payload = ai_done_payload("ai-1", "answer", Some(usage));
        assert_eq!(payload["usage"]["prompt_tokens"], 40);
        assert_eq!(payload["usage"]["completion_tokens"], 17);
        // Anthropic reports no total, so there is no total key at all - the
        // frontend must not be handed a sum the provider never sent.
        assert!(payload["usage"].get("total_tokens").is_none());
    }

    #[test]
    fn a_usage_only_final_chunk_is_not_dropped() {
        // OpenAI-compatible endpoints answer a `stream_options.include_usage`
        // request with a LAST chunk that has an empty `choices` array and only
        // `usage`. A frame with no text, no reasoning and no finish_reason used
        // to be dropped by the parser, so the counts never reached the stream
        // loop (nor the `ai-done` payload) at all.
        let mut acc = String::new();
        let line = r#"data: {"id":"1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}"#;
        assert!(
            parse_sse_event(line, "openai", &mut acc).is_some(),
            "a usage-only frame must not be dropped"
        );
    }

    #[test]
    fn gemini_url_has_no_key_embedded() {
        let cfg = AIConfig {
            provider: "gemini".into(),
            model: "gemini-2.5-pro".into(),
            base_url: None,
            api_key: Some("SECRET-KEY".into()),
            temperature: None,
            max_tokens: None,
            system_prompt: None,
            reasoning_effort: None,
            allow_private: false,
        };
        let (url, _body) = resolve_endpoint(&cfg, "hi", &[]);
        assert!(
            !url.contains("SECRET-KEY"),
            "key must not appear in URL: {url}"
        );
        assert!(
            !url.contains("key="),
            "url must not carry a key query param: {url}"
        );
    }
}
