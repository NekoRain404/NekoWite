use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

#[derive(Deserialize, Clone)]
pub struct AIConfig {
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct AIChunk {
    pub id: String,
    pub text: String,
}

/// Set of in-flight completion ids. `ai_cancel` removes an id, the stream
/// loop in `ai_complete` checks membership before each chunk and breaks when
/// the id is gone.
#[derive(Default)]
pub struct AiState(pub Mutex<HashSet<String>>);

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
fn split_data_url(data_url: &str) -> (String, String) {
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

pub fn resolve_endpoint(
    cfg: &AIConfig,
    prompt: &str,
    images: &[serde_json::Value],
) -> (String, serde_json::Value) {
    let model = cfg.model.clone();
    let has_images = !images.is_empty();
    match cfg.provider.as_str() {
        "anthropic" => {
            let base = cfg
                .base_url
                .clone()
                .unwrap_or_else(|| "https://api.anthropic.com".into());
            let content = if has_images {
                let mut blocks = vec![serde_json::json!({ "type": "text", "text": prompt })];
                for img in images {
                    let (mime, data) = split_data_url(img.as_str().unwrap_or(""));
                    blocks.push(serde_json::json!({
                        "type": "image",
                        "source": { "type": "base64", "media_type": mime, "data": data }
                    }));
                }
                serde_json::Value::Array(blocks)
            } else {
                serde_json::json!(prompt)
            };
            (
                format!("{}/v1/messages", base.trim_end_matches('/')),
                serde_json::json!({
                    "model": model, "max_tokens": 256, "stream": true,
                    "messages": [ { "role": "user", "content": content } ]
                }),
            )
        }
        "gemini" => {
            let base = cfg
                .base_url
                .clone()
                .unwrap_or_else(|| "https://generativelanguage.googleapis.com".into());
            let mut url = format!(
                "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
                base.trim_end_matches('/'),
                model
            );
            // Gemini authenticates via the `key` query parameter (or the
            // `x-goog-api-key` header), NOT `Authorization: Bearer`. Embed the
            // key in the query so the request is actually authorized.
            if let Some(key) = &cfg.api_key {
                url.push_str(&format!("&key={key}"));
            }
            let parts = if has_images {
                let mut parts = vec![serde_json::json!({ "text": prompt })];
                for img in images {
                    let (mime, data) = split_data_url(img.as_str().unwrap_or(""));
                    parts.push(serde_json::json!({
                        "inline_data": { "mime_type": mime, "data": data }
                    }));
                }
                parts
            } else {
                vec![serde_json::json!({ "text": prompt })]
            };
            (
                url,
                serde_json::json!({
                    "contents": [ { "role": "user", "parts": parts } ]
                }),
            )
        }
        _ => {
            // openai / grok / local / custom
            let base = cfg
                .base_url
                .clone()
                .unwrap_or_else(|| "https://api.openai.com/v1".into());
            let content = if has_images {
                let mut parts = vec![serde_json::json!({ "type": "text", "text": prompt })];
                for img in images {
                    parts.push(serde_json::json!({
                        "type": "image_url",
                        "image_url": { "url": img }
                    }));
                }
                serde_json::Value::Array(parts)
            } else {
                serde_json::json!(prompt)
            };
            (
                format!("{}/chat/completions", base.trim_end_matches('/')),
                serde_json::json!({
                    "model": model, "max_tokens": 256, "stream": true,
                    "messages": [ { "role": "user", "content": content } ]
                }),
            )
        }
    }
}

/// Parse one SSE line for a provider and append any delta to `acc`.
/// Returns the incremental text, or `None` for comments, blanks, `[DONE]`,
/// and non-data lines. The accumulated `acc` is used for the final `full`.
pub fn parse_sse_line(line: &str, provider: &str, acc: &mut String) -> Option<String> {
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
        // Anthropic streams the FIRST text block inside `content_block_start`
        // (`content_block.text`) and only subsequent deltas via
        // `content_block_delta` (`delta.text`). Read both so the initial text
        // is not dropped.
        "anthropic" => v["delta"]["text"]
            .as_str()
            .map(str::to_string)
            .or_else(|| v["content_block"]["text"].as_str().map(str::to_string)),
        "gemini" => v["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .map(str::to_string),
        _ => v["choices"][0]["delta"]["content"]
            .as_str()
            .map(str::to_string)
            .or_else(|| v["choices"][0]["text"].as_str().map(str::to_string)),
    };
    if let Some(t) = &text {
        acc.push_str(t);
    }
    text
}

fn is_active(app: &tauri::AppHandle, id: &str) -> bool {
    let state = app.state::<AiState>();
    let guard = state.0.lock();
    match guard {
        Ok(inflight) => inflight.contains(id),
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn ai_cancel(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AiState>();
    let mut inflight = state.0.lock().map_err(|e| e.to_string())?;
    inflight.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn ai_complete(
    app: tauri::AppHandle,
    config: AIConfig,
    prompt: String,
    images: Vec<serde_json::Value>,
) -> Result<(), String> {
    let id = next_ai_id();
    {
        let state = app.state::<AiState>();
        let mut inflight = state.0.lock().map_err(|e| e.to_string())?;
        inflight.insert(id.clone());
    }
    let result = stream_complete(&app, &config, &prompt, &images, &id).await;
    if let Some(state) = app.try_state::<AiState>() {
        if let Ok(mut inflight) = state.0.lock() {
            inflight.remove(&id);
        }
    }
    result
}

async fn stream_complete(
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
            // Gemini keys ride in the URL `?key=` (set in resolve_endpoint);
            // no Authorization header — Gemini rejects Bearer auth.
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

    let mut stream = response.bytes_stream();
    let mut full = String::new();
    let mut buffer = SseBuffer::new();
    let mut stream_ended = false;
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
                    if let Some(delta) = parse_sse_line(&line, &config.provider, &mut full) {
                        let _ = app.emit(
                            "ai-chunk",
                            AIChunk {
                                id: id.to_string(),
                                text: delta,
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
            if let Some(delta) = parse_sse_line(&line, &config.provider, &mut full) {
                let _ = app.emit(
                    "ai-chunk",
                    AIChunk {
                        id: id.to_string(),
                        text: delta,
                    },
                );
            }
        }
    }
    let _ = app.emit("ai-done", serde_json::json!({ "id": id, "full": full }));
    Ok(())
}
