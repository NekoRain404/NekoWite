//! Gemini provider: request URL/body construction and SSE text extraction.
//!
//! Provider-specific knowledge lives here; everything shared is reached through
//! the sibling modules - request helpers from [`super::request`], usage parsing
//! from [`super::response`] - and [`super::client`] delegates to this module for
//! anything Gemini-shaped. This module imports none of `client`/`sse`, so the
//! provider side stays a leaf the dispatch can call into.

use serde_json::Value;

use super::request::{normalize_reasoning_effort, split_data_url, system_prompt_of, AIConfig};
use super::response::{token_count, TokenUsage};

/// Gemini's thinking budget in tokens for a normalised rung; `none` is an
/// explicit `0` (thinking off), unlike Anthropic where it means "omit the
/// field".
fn thinking_budget(effort: &str) -> u32 {
    match effort {
        "minimal" => 512,
        "low" => 1024,
        "medium" => 4096,
        "high" => 8192,
        "xhigh" => 16384,
        _ => 0, // "none"
    }
}

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
    // Gemini controls thinking with a token budget nested inside
    // `generationConfig` — an explicit 0 turns it off — so it is merged into
    // whatever temperature/maxOutputTokens are already there instead of
    // replacing the object.
    if let Some(effort) = normalize_reasoning_effort(cfg.reasoning_effort.as_deref()) {
        let budget = thinking_budget(effort);
        // The budget is a slice of the OUTPUT allowance, so a budget at or above
        // it can only be rejected — the rung then advertises more thinking than
        // the request has room for. Anthropic has the same rule and it is
        // documented there; clamping here costs nothing when the two are already
        // consistent and keeps the request valid when they are not. A rung of
        // `none` (budget 0) is left alone: that is a deliberate "off".
        let budget = match cfg.max_tokens {
            Some(mt) if budget > 1 && budget >= mt => mt.saturating_sub(1).min(budget),
            _ => budget,
        };
        if let Some(gc) = body.get_mut("generationConfig") {
            gc["thinkingConfig"] = serde_json::json!({ "thinkingBudget": budget });
        } else {
            body["generationConfig"] =
                serde_json::json!({ "thinkingConfig": { "thinkingBudget": budget } });
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

/// Extract token usage from a Gemini frame.
///
/// Gemini attaches `usageMetadata` to chunks — the last chunk of a stream
/// carries the final counts — with `promptTokenCount`, `candidatesTokenCount`
/// and `totalTokenCount`. A frame without it, and any count that is not a
/// non-negative integer, yields nothing rather than a guessed number;
/// `thoughtsTokenCount` is deliberately not folded into the candidate count,
/// which is not what the API reports it as.
pub fn extract_usage(v: &Value) -> Option<TokenUsage> {
    let meta = v.get("usageMetadata").filter(|m| m.is_object())?;
    let usage = TokenUsage {
        prompt_tokens: token_count(meta.get("promptTokenCount")),
        completion_tokens: token_count(meta.get("candidatesTokenCount")),
        total_tokens: token_count(meta.get("totalTokenCount")),
    };
    usage.has_any().then_some(usage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_usage_metadata() {
        let v = json!({
            "candidates": [{ "content": { "parts": [{ "text": "hi" }] } }],
            "usageMetadata": {
                "promptTokenCount": 9,
                "candidatesTokenCount": 4,
                "totalTokenCount": 13
            }
        });
        assert_eq!(
            extract_usage(&v),
            Some(TokenUsage {
                prompt_tokens: Some(9),
                completion_tokens: Some(4),
                total_tokens: Some(13),
            })
        );
    }

    #[test]
    fn partial_metadata_keeps_only_what_was_sent() {
        let v = json!({ "usageMetadata": { "totalTokenCount": 13 } });
        assert_eq!(
            extract_usage(&v),
            Some(TokenUsage {
                total_tokens: Some(13),
                ..TokenUsage::default()
            })
        );
    }

    #[test]
    fn absent_or_malformed_metadata_is_none() {
        assert_eq!(
            extract_usage(&json!({ "candidates": [{ "finishReason": "STOP" }] })),
            None
        );
        assert_eq!(extract_usage(&json!({ "usageMetadata": null })), None);
        assert_eq!(extract_usage(&json!({ "usageMetadata": {} })), None);
        assert_eq!(
            extract_usage(
                &json!({ "usageMetadata": { "promptTokenCount": "9", "candidatesTokenCount": -1 } })
            ),
            None
        );
    }
}
