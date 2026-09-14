//! Everything a provider's non-streaming response is read into: the bounded
//! body read, the error-body wording, and the token counts a completion
//! reports.
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

// The model list moved to `super::model_list`, which is also where the split's
// compatibility surface is kept: `client` and the integration tests import
// these two from here, exactly as before, and no consumer file had to be
// edited. The direction of USE is `model_list` → this file, never the reverse.
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
    http_error_message_at(None, status, detail)
}

/// Phrases that name the model's own context window, i.e. "the request did not
/// fit" — the one 400 whose cause the status hint below gets backwards.
///
/// The first is **observed**, not recalled: sent to the gateway this app is
/// configured against (`https://tokenflux.dev/v1`, model `deepseek-flash`), a
/// request past the window came back HTTP 400 with
/// `This model's maximum context length is 1048576 tokens. However, you
/// requested 1420272 tokens (1027056 in the messages, 393216 in the
/// completion). Please reduce the length of the messages or completion.` — the
/// provider naming the length while the app told the user their *format* was
/// wrong, which sends them looking for a broken image.
///
/// The rest are the wordings the providers this app speaks to are documented to
/// answer the same condition with — kept as a list of data so the next person
/// can correct one against a real body without touching the logic that reads
/// them.
///
/// Every entry is a phrase rather than a word on purpose: `max_tokens`,
/// `token` or `length` alone also appears in 400s that have nothing to do with
/// the window (measured on the same gateway: `Invalid max_tokens value, the
/// valid range of max_tokens is [1, 393216]`, and a rejected `reasoning_effort`
/// naming its six valid values), and a classifier that fires on those would be
/// lying in the other direction.
const CONTEXT_OVERFLOW_MARKERS: [&str; 9] = [
    "maximum context length",
    "context length exceeded",
    "context_length_exceeded",
    "context window",
    "reduce the length of the messages",
    "prompt is too long",
    "exceeds the maximum number of tokens",
    "too many tokens",
    "input is too long",
];

/// The hint for a request the model's own window refused.
///
/// Direction, and why it is the opposite of the truncation notice's: the app's
/// budget decides how much of the note is attached, so a note cut down to the
/// budget is answered by RAISING it (`contextTruncatedNotice`, Settings → AI)
/// and a request that still did not fit is answered by LOWERING it. Both name
/// the same setting because both are settled in the same place — the budget has
/// to sit between what the model accepts and what the note needs — and a reader
/// who meets only one of the two would take it for a contradiction.
///
/// It says "length, not format" because the hint it replaces said the opposite,
/// and a user who has seen that message once will look for the malformed part
/// until something tells them there is not one.
const CONTEXT_OVERFLOW_HINT: &str =
    "本次请求超出了模型能接收的上下文长度——内容太长，不是请求格式的问题。\
请缩短当前笔记，或在“设置 → AI”里把“笔记上下文长度”调小后重试；换用上下文窗口更大的模型也可以";

/// Whether the provider's own explanation says the request did not fit the
/// model's context window (see [`CONTEXT_OVERFLOW_MARKERS`]).
fn names_context_overflow(detail: &str) -> bool {
    let lower = detail.to_lowercase();
    CONTEXT_OVERFLOW_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
}

/// The status hint, with the address that answered and the provider's own
/// explanation appended when there are any.
///
/// Naming the endpoint is not decoration: the user typed a Base URL, the app
/// derived a path from it, and only the derived URL shows which of the two the
/// provider disagreed with. Both extras are omitted rather than faked when the
/// caller has neither, so the message stays total — and identical to the
/// URL-less form it has always produced.
///
/// The status is checked *against* the detail rather than on its own: a 400 is
/// the status a context overflow arrives under, and the format hint that status
/// produces is the one message in this function that is worse than saying
/// nothing, because the user who overflows is the user this app's context
/// budget exists for. Only the statuses that family of rejections uses are
/// overridden (400, 413, 422); an auth or rate-limit hint is never rewritten
/// from a provider's prose.
pub fn http_error_message_at(url: Option<&str>, status: u16, detail: Option<&str>) -> String {
    let overflowed = matches!(status, 400 | 413 | 422)
        && detail.map(str::trim).is_some_and(names_context_overflow);
    let hint = if overflowed {
        CONTEXT_OVERFLOW_HINT
    } else {
        match status {
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
        }
    };
    let mut parts = vec![format!("AI 请求失败：HTTP {status}，{hint}")];
    if let Some(url) = url {
        parts.push(format!("请求地址：{url}"));
    }
    if let Some(detail) = detail.map(str::trim).filter(|d| !d.is_empty()) {
        let mut shown = detail.to_string();
        if shown.chars().count() > 300 {
            shown = shown.chars().take(300).collect::<String>() + "…";
        }
        parts.push(format!("服务商说明：{shown}"));
    }
    parts.join("。")
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

    /// The provider's own words for a request past the model's window. Recorded
    /// verbatim from a live call to `https://tokenflux.dev/v1` (model
    /// `deepseek-flash`), which is what makes the classifier testable against a
    /// real rejection instead of a guess at one.
    const OBSERVED_OVERFLOW: &str = "This model's maximum context length is 1048576 tokens. \
However, you requested 1420272 tokens (1027056 in the messages, 393216 in the completion). \
Please reduce the length of the messages or completion.";

    /// Two 400s from the same gateway, recorded the same way, that are NOT about
    /// the window — the false positives this classifier must not produce.
    const OBSERVED_OTHER_400: [&str; 2] = [
        "Invalid max_tokens value, the valid range of max_tokens is [1, 393216]",
        "Failed to deserialize the JSON body into the target type: reasoning_effort: unknown variant `bogus-level`, expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` at line 1 column 74",
    ];

    #[test]
    fn a_context_overflow_is_named_as_one_and_says_what_to_do() {
        let message = http_error_message_at(
            Some("https://tokenflux.dev/v1/chat/completions"),
            400,
            Some(OBSERVED_OVERFLOW),
        );
        // The cause, in the user's language...
        assert!(message.contains("上下文长度"), "{message}");
        // ...the instruction not to go looking for a malformed request...
        assert!(message.contains("不是请求格式的问题"), "{message}");
        // ...and both ways out: the setting (named as the truncation notice
        // names it) and the model.
        assert!(message.contains("设置 → AI"), "{message}");
        assert!(message.contains("笔记上下文长度"), "{message}");
        assert!(message.contains("上下文窗口更大的模型"), "{message}");
        // The provider's own numbers survive: they are the only measurement of
        // how far over the request was.
        assert!(message.contains("1048576 tokens"), "{message}");
        // And the format hint that had the cause backwards is gone.
        assert!(!message.contains("请求格式不正确"), "{message}");
    }

    #[test]
    fn a_400_that_is_not_about_the_window_keeps_the_hint_it_had() {
        for detail in OBSERVED_OTHER_400 {
            let message = http_error_message_with_detail(400, Some(detail));
            assert!(message.contains("请求格式不正确"), "{message}");
            assert!(!message.contains("上下文长度"), "{message}");
        }
        // No detail at all is not evidence of anything.
        assert!(http_error_message_with_detail(400, None).contains("请求格式不正确"));
    }

    #[test]
    fn a_window_rejection_is_named_whatever_status_carries_it() {
        // Providers disagree about the code (400/413/422); the body is what
        // says which condition it is. The same body under an auth status is not
        // touched: a 401 is about the key, not about length.
        for status in [400, 413, 422] {
            assert!(
                http_error_message_with_detail(
                    status,
                    Some("prompt is too long: 218500 tokens > 200000 maximum")
                )
                .contains("上下文长度"),
                "status {status}"
            );
        }
        let unauthorized = http_error_message_with_detail(401, Some("context window exceeded?"));
        assert!(unauthorized.contains("API Key 无效"), "{unauthorized}");
    }

    #[test]
    fn the_status_message_names_the_url_only_when_it_has_one() {
        // The URL-less form is what the completion path and the older public
        // API still produce, byte for byte.
        assert_eq!(
            http_error_message_at(None, 404, None),
            http_error_message_with_detail(404, None)
        );
        let named =
            http_error_message_at(Some("https://api.example.com/v1/models"), 404, Some("nope"));
        assert!(
            named.contains("https://api.example.com/v1/models"),
            "{named}"
        );
        assert!(named.contains("nope"), "{named}");
    }
}
