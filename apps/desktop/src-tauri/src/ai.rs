use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Mutex;
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

pub fn u32_ts() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn build_prompt(cursor_prefix: &str) -> String {
    format!(
        "Continue writing the following text. Only output the continuation, no preamble.\n\n{}\n",
        cursor_prefix.trim_end()
    )
}

pub fn resolve_endpoint(cfg: &AIConfig) -> (String, serde_json::Value) {
    let model = cfg.model.clone();
    match cfg.provider.as_str() {
        "anthropic" => {
            let base = cfg
                .base_url
                .clone()
                .unwrap_or_else(|| "https://api.anthropic.com".into());
            (
                format!("{}/v1/messages", base.trim_end_matches('/')),
                serde_json::json!({
                    "model": model, "max_tokens": 256, "stream": true,
                    "messages": [ { "role": "user", "content": "" } ]
                }),
            )
        }
        "gemini" => {
            let base = cfg
                .base_url
                .clone()
                .unwrap_or_else(|| "https://generativelanguage.googleapis.com".into());
            (
                format!(
                    "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
                    base.trim_end_matches('/'),
                    model
                ),
                serde_json::json!({
                    "contents": [ { "role": "user", "parts": [ { "text": "" } ] } ]
                }),
            )
        }
        _ => {
            // openai / grok / local / custom
            let base = cfg
                .base_url
                .clone()
                .unwrap_or_else(|| "https://api.openai.com/v1".into());
            (
                format!("{}/chat/completions", base.trim_end_matches('/')),
                serde_json::json!({
                    "model": model, "max_tokens": 256, "stream": true,
                    "messages": [ { "role": "user", "content": "" } ]
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
        "anthropic" => v["delta"]["text"].as_str().map(str::to_string),
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
) -> Result<(), String> {
    let id = format!("ai-{}", u32_ts());
    {
        let state = app.state::<AiState>();
        let mut inflight = state.0.lock().map_err(|e| e.to_string())?;
        inflight.insert(id.clone());
    }
    let result = stream_complete(&app, &config, &prompt, &id).await;
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
    id: &str,
) -> Result<(), String> {
    let (url, mut body) = resolve_endpoint(config);
    match config.provider.as_str() {
        "anthropic" => {
            body["messages"][0]["content"] = serde_json::json!(prompt);
        }
        "gemini" => {
            body["contents"][0]["parts"][0]["text"] = serde_json::json!(prompt);
        }
        _ => {
            body["messages"][0]["content"] = serde_json::json!(prompt);
        }
    }

    let mut request = reqwest::Client::new().post(&url).json(&body);
    match config.provider.as_str() {
        "anthropic" => {
            if let Some(key) = &config.api_key {
                request = request.header("x-api-key", key);
            }
            request = request.header("anthropic-version", "2023-06-01");
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
    loop {
        if !is_active(app, id) {
            break;
        }
        match stream.next().await {
            Some(Ok(chunk)) => {
                let text = String::from_utf8_lossy(&chunk);
                for line in text.lines() {
                    if let Some(delta) = parse_sse_line(line, &config.provider, &mut full) {
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
            None => break,
        }
    }
    let _ = app.emit("ai-done", serde_json::json!({ "id": id, "full": full }));
    Ok(())
}
