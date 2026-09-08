//! Gemini provider: request URL/body construction and SSE text extraction.
//!
//! Provider-specific knowledge lives here; the shared HTTP client, streaming
//! loop, concurrency limiter and SSRF guard live in [`super::client`], which
//! delegates to this module for anything Gemini-shaped.

use serde_json::Value;

use super::client::{split_data_url, system_prompt_of, AIConfig};

/// Build the Gemini request `(url, body)` for a completion. The URL stays free
/// of the API key so proxies/servers never log it; the credential rides in the
/// `x-goog-api-key` request header, which the client sets (Gemini rejects
/// `Authorization: Bearer`).
pub fn endpoint(cfg: &AIConfig, prompt: &str, images: &[Value]) -> (String, Value) {
    let base = cfg
        .base_url
        .clone()
        .unwrap_or_else(|| "https://generativelanguage.googleapis.com".into());
    let url = format!(
        "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
        base.trim_end_matches('/'),
        cfg.model
    );
    let parts = if !images.is_empty() {
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
    let mut body = serde_json::json!({
        "contents": [ { "role": "user", "parts": parts } ]
    });
    // Gemini puts the system prompt in `systemInstruction.parts[].text`;
    // there is no plain string field, so materialise the object.
    if let Some(sys) = system_prompt_of(cfg) {
        body["systemInstruction"] = serde_json::json!({
            "parts": [ { "text": sys } ]
        });
    }
    if let Some(temp) = cfg.temperature {
        body["generationConfig"] = serde_json::json!({ "temperature": temp });
    }
    if let Some(mt) = cfg.max_tokens {
        if let Some(gc) = body.get_mut("generationConfig") {
            gc["maxOutputTokens"] = serde_json::json!(mt);
        } else {
            body["generationConfig"] = serde_json::json!({ "maxOutputTokens": mt });
        }
    }
    (url, body)
}

/// Extract the incremental Gemini text for one parsed SSE event body.
pub fn extract_text(v: &Value) -> Option<String> {
    v["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .map(str::to_string)
}
