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

/// The system prompt to send, normalised so blanks become `None`.
pub(crate) fn system_prompt_of(cfg: &AIConfig) -> Option<String> {
    cfg.system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
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

/// Guard against SSRF / internal-endpoint abuse via a user-supplied `base_url`.
/// Only `http`/`https` are accepted; hosts that are literal private, loopback,
/// link-local, CGNAT or unspecified IPs (plus the literal `localhost` name) are
/// rejected unless the caller explicitly opts in via [`AIConfig::allow_private`]
/// (for legitimate local models such as Ollama / LM Studio). The default
/// provider endpoints (api.anthropic.com, api.openai.com, ...) are public and
/// never rejected.
pub fn validate_base_url(cfg: &AIConfig) -> Result<(), String> {
    if cfg.allow_private {
        return Ok(());
    }
    if let Some(base) = cfg.base_url.as_deref() {
        validate_public_url(base)?;
    }
    Ok(())
}

fn validate_public_url(base: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(base)
        .map_err(|_| format!("AI Base URL 无效：{base}（应为 http:// 或 https:// 格式）"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("AI Base URL 必须使用 http:// 或 https://：{base}"));
    }
    let host = url
        .host_str()
        .ok_or_else(|| format!("AI Base URL 缺少主机名：{base}"))?;
    if is_private_or_loopback_host(host) {
        return Err(format!(
            "AI Base URL 指向了本机/内网地址（{host}）。为安全起见已默认拒绝连接内网。\
             如果你确实要连接本地模型（如 Ollama / LM Studio），请在设置中开启“允许本地/内网地址”后再试。"
        ));
    }
    Ok(())
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
                || (o[0] == 192 && o[1] == 168)               // 192.168.0.0/16 private
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
#[derive(Default)]
pub struct SseBuffer {
    pending: Vec<u8>,
}

impl SseBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(nl) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line);
            lines.push(line.trim_end_matches(['\r', '\n']).to_string());
        }
        lines
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
    let hint = match status {
        400 => "请求格式不正确",
        401 => "API Key 无效，请检查设置",
        403 => "API Key 无权限，请检查设置",
        404 => "接口不存在，请检查 Base URL",
        429 => "请求过于频繁，请稍后重试",
        500 | 502 | 503 | 504 => "服务端暂时不可用，请稍后重试",
        _ => "网络请求失败",
    };
    format!("AI 请求失败：HTTP {status}，{hint}")
}

/// Parse one SSE line for a provider and append any delta to `acc`.
/// Returns the incremental text, or `None` for comments, blanks, `[DONE]`,
/// and non-data lines. The accumulated `acc` is used for the final `full`.
pub fn parse_sse_event(line: &str, provider: &str, acc: &mut String) -> Option<SseDelta> {
    let line = line.trim();
    if !line.starts_with("data:") {
        return None;
    }
    let raw = line.trim_start_matches("data:").trim();
    if raw == "[DONE]" {
        return None;
    }
    let v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return None,
    };
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
    if text.is_none() && reasoning.is_none() {
        return None;
    }
    Some(SseDelta { text, reasoning })
}

/// Text-only view of one SSE line, for callers (and tests) that just want the
/// document-visible delta. Reasoning progress is dropped.
pub fn parse_sse_line(line: &str, provider: &str, acc: &mut String) -> Option<String> {
    parse_sse_event(line, provider, acc).and_then(|d| d.text)
}

fn is_active(app: &tauri::AppHandle, id: &str) -> bool {
    let state = app.state::<AiState>();
    let guard = state.inflight.lock();
    match guard {
        Ok(inflight) => inflight.contains(id),
        Err(_) => false,
    }
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

/// Resolve the provider's `GET {endpoint}` for listing models, matching the
/// base/credential conventions of `resolve_endpoint` so the dropdown pulls from
/// the same origin a completion would use.
pub async fn list_models(config: &AIConfig) -> Result<Vec<String>, String> {
    // Reject a private/loopback Base URL unless the user opts in (see
    // `validate_base_url`); a model dropdown must never phone an internal host.
    validate_base_url(config)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(15))
        .build()
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

    let body = request
        .send()
        .await
        .map_err(|e| format!("请求模型列表失败：{e}"))?
        .error_for_status()
        .map_err(|e| format!("模型列表请求失败：{e}"))?
        .text()
        .await
        .map_err(|e| e.to_string())?;

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
) -> Result<(), String> {
    // `resolve_endpoint` builds the content itself: with images it emits the
    // provider's multimodal array (text + image blocks), without images it
    // keeps the plain string prompt — preserving the existing single-text
    // ghost-writer behaviour unchanged.
    let (url, body) = resolve_endpoint(config, prompt, images);

    // Per-phase timeouts instead of a total-request deadline: `Client::timeout`
    // caps the WHOLE request including the streaming body, so any completion
    // longer than the cap aborts mid-stream. `connect_timeout` bounds the
    // connection phase and `read_timeout` bounds each single read, so a stalled
    // provider still cannot hang the stream forever (cooperative cancel only
    // interrupts between chunks) while a long, actively-streaming completion
    // runs to its natural end. The timeout error surfaces through
    // `request.send()` / `bytes_stream()` and produces the same `ai-error` +
    // `Err` path as a transport failure.
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| {
            let _ = app.emit(
                "ai-error",
                serde_json::json!({ "id": id, "message": e.to_string() }),
            );
            e.to_string()
        })?;

    let mut request = client.post(&url).json(&body);
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
    let response = response.error_for_status().map_err(|e| {
        let message = http_error_message(e.status().map(|s| s.as_u16()).unwrap_or(0));
        let _ = app.emit(
            "ai-error",
            serde_json::json!({ "id": id, "message": message }),
        );
        message
    })?;

    let mut stream = response.bytes_stream();
    let mut full = String::new();
    let mut buffer = SseBuffer::new();
    let mut stream_ended = false;
    // Reasoning models can spend the ENTIRE token budget thinking and then
    // return no answer at all. Measured against tokenflux's `deepseek-flash`
    // with max_tokens=256: 256 reasoning tokens, zero content deltas and
    // `finish_reason: "length"`. Without this flag that produced a silent
    // no-op the user could not explain; with it we can say what happened.
    let mut reasoning_seen = false;
    loop {
        if !is_active(app, id) {
            break;
        }
        match stream.next().await {
            Some(Ok(chunk)) => {
                // Feed the raw bytes; the buffer decodes only complete lines,
                // so a multi-byte UTF-8 character split at a chunk boundary
                // stays intact (decoding per chunk would corrupt it to U+FFFD).
                for line in buffer.feed(&chunk) {
                    // A reasoning model streams its thinking BEFORE any answer
                    // text, so without this the UI showed nothing at all for
                    // that whole phase and looked hung. The reasoning is
                    // emitted as progress only — never appended to `full`, or
                    // the ghost writer would type the model's internal
                    // monologue into the document.
                    let Some(delta) = parse_sse_event(&line, &config.provider, &mut full) else {
                        continue;
                    };
                    if let Some(reasoning) = delta.reasoning {
                        reasoning_seen = true;
                        let _ = app.emit(
                            "ai-reasoning",
                            serde_json::json!({ "id": id, "text": reasoning }),
                        );
                    }
                    if let Some(text) = delta.text {
                        let _ = app.emit(
                            "ai-chunk",
                            AIChunk {
                                id: id.to_string(),
                                text,
                            },
                        );
                    }
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
    if stream_ended {
        for line in buffer.flush() {
            let Some(delta) = parse_sse_event(&line, &config.provider, &mut full) else {
                continue;
            };
            if let Some(text) = delta.text {
                let _ = app.emit(
                    "ai-chunk",
                    AIChunk {
                        id: id.to_string(),
                        text,
                    },
                );
            }
        }
    }
    // An answer-less completion that produced reasoning is not a normal result:
    // the budget was consumed by the model's thinking, so tell the user what to
    // change instead of finishing silently with nothing to show.
    if full.is_empty() && reasoning_seen {
        let message = "模型把本次最大输出 Tokens 全部用于推理，没有产出正文。                       请在设置里把“最大输出 Tokens”调大（推理模型建议 ≥ 1024）后重试。";
        let _ = app.emit(
            "ai-error",
            serde_json::json!({ "id": id, "message": message }),
        );
        return Err(message.into());
    }
    let _ = app.emit("ai-done", serde_json::json!({ "id": id, "full": full }));
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
            "127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254",
            "100.64.0.1", "0.0.0.0", "::1", "::", "fc00::1", "fe80::1",
            "::ffff:127.0.0.1", "::ffff:192.168.0.5", "localhost",
        ] {
            assert!(is_private_or_loopback_host(host), "should flag {host}");
        }
        for host in ["8.8.8.8", "203.0.113.9", "2606:4700:4700::1111", "api.openai.com"] {
            assert!(!is_private_or_loopback_host(host), "should allow {host}");
        }
    }

    #[test]
    fn accepts_public_http_and_https_bases() {
        for base in [
            "https://api.openai.com/v1",
            "https://generativelanguage.googleapis.com",
            "https://api.anthropic.com",
            "http://203.0.113.9:8000/v1",
            "https://llm.internal.example.com",
        ] {
            assert!(validate_public_url(base).is_ok(), "should accept {base}");
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
        assert!(!url.contains("SECRET-KEY"), "key must not appear in URL: {url}");
        assert!(!url.contains("key="), "url must not carry a key query param: {url}");
    }
}
