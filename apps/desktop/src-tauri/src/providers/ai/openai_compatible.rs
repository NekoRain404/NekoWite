//! Anthropic + OpenAI-compatible providers (`openai` / `grok` / `local` /
//! `custom`): request URL/body construction and SSE text extraction.
//!
//! Provider-specific knowledge lives here; the shared HTTP client, streaming
//! loop, concurrency limiter and SSRF guard live in [`super::client`].

use serde_json::Value;

use super::client::{
    default_base_url, normalize_reasoning_effort, split_data_url, system_prompt_of, AIConfig,
};

/// Smallest extended-thinking budget we will ask for. Anthropic requires
/// `budget_tokens < max_tokens`, so `MIN_THINKING_BUDGET + 1` output tokens is
/// the floor for a request that enables thinking at all.
const MIN_THINKING_BUDGET: u32 = 1024;

/// The `thinking.budget_tokens` for a thinking-depth choice, clamped to stay
/// strictly below the request's `max_tokens`. `None` means "send no `thinking`
/// field": either the rung is `none` (thinking off), or the output cap is too
/// small to host even the smallest budget — a rejected request is worse than
/// no extended thinking at all.
fn thinking_budget(raw: Option<&str>, max_tokens: u32) -> Option<u32> {
    let budget = match normalize_reasoning_effort(raw)? {
        "minimal" => MIN_THINKING_BUDGET,
        "low" => 2048,
        "medium" => 4096,
        "high" => 8192,
        "xhigh" => 16384,
        _ => return None, // "none": thinking is off, so omit the field.
    };
    if max_tokens <= MIN_THINKING_BUDGET {
        return None;
    }
    Some(budget.min(max_tokens - 1))
}

/// Build an Anthropic request `(url, body)`. Anthropic carries the system
/// prompt as a top-level `system` field.
pub fn endpoint_anthropic(cfg: &AIConfig, prompt: &str, images: &[Value]) -> (String, Value) {
    let base = cfg
        .base_url
        .clone()
        .unwrap_or_else(|| "https://api.anthropic.com".into());
    let content = if !images.is_empty() {
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
    // The legacy default (1024) is also the ceiling the thinking budget below
    // has to stay under.
    let max_tokens = cfg.max_tokens.unwrap_or(1024);
    let mut body = serde_json::json!({
        "model": cfg.model,
        "max_tokens": max_tokens,
        "stream": true,
        "messages": [ { "role": "user", "content": content } ]
    });
    if let Some(sys) = system_prompt_of(cfg) {
        body["system"] = serde_json::Value::String(sys);
    }
    if let Some(temp) = cfg.temperature {
        body["temperature"] = serde_json::json!(temp);
    }
    // Extended thinking does not use `reasoning_effort`: Anthropic wants an
    // explicit budget object, rejects `budget_tokens >= max_tokens`, and has
    // no "off" spelling other than omitting the field (what `none` does).
    if let Some(budget) = thinking_budget(cfg.reasoning_effort.as_deref(), max_tokens) {
        body["thinking"] = serde_json::json!({ "type": "enabled", "budget_tokens": budget });
    }
    (format!("{}/v1/messages", base.trim_end_matches('/')), body)
}

/// Build an OpenAI-compatible request `(url, body)`. The system prompt becomes
/// `messages[0]` so any images still ride in `messages[1]`.
pub fn endpoint_default(cfg: &AIConfig, prompt: &str, images: &[Value]) -> (String, Value) {
    // Per-provider default: without one, every OpenAI-compatible provider
    // that has no explicit Base URL (grok, deepseek, ...) would be sent to
    // api.openai.com — reaching the wrong host with someone else's key.
    let base = cfg
        .base_url
        .clone()
        .unwrap_or_else(|| default_base_url(&cfg.provider).to_string());
    let content = if !images.is_empty() {
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
    let mut messages = Vec::new();
    if let Some(sys) = system_prompt_of(cfg) {
        messages.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": content }));
    let mut body = serde_json::json!({
        "model": cfg.model,
        "max_tokens": cfg.max_tokens.unwrap_or(1024),
        "stream": true,
        "messages": messages
    });
    if let Some(temp) = cfg.temperature {
        body["temperature"] = serde_json::json!(temp);
    }
    // The measured ladder rung the server honours. Values outside the six are
    // already gone (the server 400s on them), so this is safe to send as-is.
    if let Some(effort) = normalize_reasoning_effort(cfg.reasoning_effort.as_deref()) {
        body["reasoning_effort"] = serde_json::json!(effort);
    }
    (format!("{}/chat/completions", base.trim_end_matches('/')), body)
}

/// Extract the incremental Anthropic text for one parsed SSE event body.
/// Anthropic streams the FIRST text block inside `content_block_start`
/// (`content_block.text`) and only subsequent deltas via
/// `content_block_delta` (`delta.text`). Read both so the initial text is not
/// dropped.
pub fn extract_anthropic_text(v: &Value) -> Option<String> {
    v["delta"]["text"]
        .as_str()
        .map(str::to_string)
        .or_else(|| v["content_block"]["text"].as_str().map(str::to_string))
}

/// Extract the incremental OpenAI-compatible text for one parsed SSE event body.
pub fn extract_openai_text(v: &Value) -> Option<String> {
    v["choices"][0]["delta"]["content"]
        .as_str()
        .map(str::to_string)
        .or_else(|| v["choices"][0]["text"].as_str().map(str::to_string))
}

/// Extract the incremental REASONING text for one parsed SSE event body.
///
/// Reasoning models (DeepSeek-R1 and the `-reasoner`/`-flash` families, plus
/// OpenAI's o-series behind compatible gateways) stream their thinking first in
/// `delta.reasoning_content` with `content` set to `null`: measured against
/// toneflux's `deepseek-flash`, 27 reasoning deltas arrived before the first
/// content delta. The answer text must NOT include it — it is internal
/// monologue, and the ghost-writer inserts what it streams straight into the
/// document — so this is reported separately and only drives a progress
/// indicator. Some gateways spell the field `reasoning` instead.
pub fn extract_openai_reasoning(v: &Value) -> Option<String> {
    let delta = &v["choices"][0]["delta"];
    delta["reasoning_content"]
        .as_str()
        .or_else(|| delta["reasoning"].as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}
