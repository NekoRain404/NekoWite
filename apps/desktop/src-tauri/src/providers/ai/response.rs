//! Everything a provider's non-streaming response is read into: the bounded
//! body read, the error-body wording and the JSON it parses (model ids, token
//! counts).
//!
//! Dependencies: [`super::limits`] for the read ceilings and
//! [`super::request`] for the endpoint a read is issued against. One arrow
//! only: the streaming modules depend on this file (the token accounting they
//! fold lives here), never the other way round.

use futures_util::StreamExt;
use serde::Serialize;

use super::limits::{MAX_ERROR_BODY_BYTES, MAX_MODELS_RESPONSE_BYTES};
use super::request::{models_endpoint, AIConfig};

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

/// Run the `GET /models` round trip against an already-built, already-pinned
/// client and return the parsed model ids.
///
/// The client is injected rather than constructed here: the transport (timeouts
/// from `limits`, the SSRF pin and the redirect refusal from `url_policy`, both
/// applied by `client::ai_http_client`) belongs to the caller, so this function
/// owns only what the response side owns - the endpoint's status, its bounded
/// body read and the JSON it parses into.
pub async fn fetch_model_ids(
    client: &reqwest::Client,
    config: &AIConfig,
) -> Result<Vec<String>, String> {
    let (url, headers) = models_endpoint(config);

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
}
