//! What a provider's non-streaming response is READ into: the bounded body
//! read, and the token counts a completion reports.
//!
//! What a failed request SAYS to the user is its own module
//! ([`super::error_message`]): turning a rejection into a sentence is a
//! different job from turning bytes into values, and that half grew on its own
//! (the context-overflow wording is a user-visible policy with its own tests).
//!
//! The model list has its own module ([`super::model_list`]): it is read on
//! demand rather than as part of a completion, and it is the one response whose
//! failures a human reads directly in the settings page.
//!
//! Dependencies: [`super::limits`] for the read ceilings. One arrow only: the
//! streaming modules depend on this file (the token accounting they fold lives
//! here), never the other way round.

use futures_util::StreamExt;
use serde::Serialize;

// The two splits' compatibility surface, kept here because this is the module
// path consumers already import from: `model_list` gave up the models fetch,
// and `error_message` gave up the failure wording. `client`, `model_list` and
// the integration tests import all of these from here exactly as before, and no
// consumer file had to be edited. The direction of USE is `model_list` and
// `error_message` → this file, never the reverse.
pub use super::error_message::{
    error_detail_from_body, http_error_message, http_error_message_at,
    http_error_message_with_detail,
};
pub use super::model_list::{fetch_model_ids, parse_model_ids};

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

/// Read a token count the provider actually sent: only a non-negative integer
/// counts. A string, a float, a negative number or an object is not a
/// measurement, so it is ignored instead of coerced (see [`TokenUsage`]).
pub(crate) fn token_count(raw: Option<&serde_json::Value>) -> Option<u64> {
    raw.and_then(serde_json::Value::as_u64)
}

/// The content type a response declares, lowercased, or `""` when it declares
/// none.
///
/// Read BEFORE the body consumes the response: it is half of the diagnosis when
/// a 2xx carries something other than what was asked for. Both paths that have
/// to make that diagnosis show it — the models list when a body is not JSON, the
/// completion when a response never became an event stream — and a header read
/// written twice is a header read that can drift, so both call this one.
pub(crate) fn declared_content_type(response: &reqwest::Response) -> String {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase()
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
pub(crate) async fn read_body_bounded(
    response: reqwest::Response,
    limit: usize,
) -> Result<String, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

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

    // The failure-wording tests moved with the functions to
    // `super::error_message`, which is where the statuses and the recorded
    // provider bodies they are written against now live.
}
