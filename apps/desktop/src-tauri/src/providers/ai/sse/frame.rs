//! Interpreting one SSE line: folding it into an [`SseDelta`], the in-band error
//! it may carry, and the usage accounting that accumulates across frames.
//!
//! Extracted from [`super`] as the middle slice of the stream reader, because
//! reading a line and holding a stream's state are two concerns: a parse is a
//! pure function of the line's text and the provider's name, so a dialect rule
//! is a change here alone and can be pinned without a socket, a buffer or a
//! running completion.
//!
//! Dependencies: [`super::super::response`] for the token accounting a frame may
//! carry, and the two provider modules it dispatches text/usage extraction to by
//! provider name. The arrow points one way - `frame` to the provider modules,
//! the provider modules to `request`/`response`, never back here - so no cycle
//! exists.

use super::super::response::TokenUsage;
use super::super::{gemini, openai_compatible};

/// Fold one parsed frame's usage into a stream's running total.
pub fn accumulate_usage(total: &mut Option<TokenUsage>, delta: &SseDelta) {
    if let Some(found) = delta.usage {
        total.get_or_insert_with(TokenUsage::default).merge(found);
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

/// Parse one SSE line for a provider and append any delta to `acc`.
/// Returns the incremental text, or `None` for comments, blanks, `[DONE]`,
/// and non-data lines. The accumulated `acc` is used for the final `full`.
///
/// `acc` grows by whatever the line carries and is NOT bounded here: the
/// ceiling on a live answer ([`MAX_ANSWER_BYTES`](super::super::limits::MAX_ANSWER_BYTES))
/// belongs to the stream that owns the accumulation, and that is
/// [`CompletionStream`](super::CompletionStream). Anything streaming a
/// provider response must go through it rather than calling this directly in
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
///
/// A PRESENT `error` key is not a report: `Value::get` answers
/// `Some(&Value::Null)` for `{"error": null}`, so a healthy frame that merely
/// carries the field failed the whole chunk and lost its text. Only what the
/// field SAYS counts — a message, or a `type` — plus Anthropic's `type: "error"`.
fn extract_stream_error(v: &serde_json::Value) -> Option<String> {
    let is_anthropic_error = v.get("type").and_then(|t| t.as_str()) == Some("error");
    let err = v.get("error");
    let kind = err
        .and_then(|e| e.get("type").and_then(|t| t.as_str()))
        .unwrap_or("");
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
        .filter(|m| !m.trim().is_empty());
    if message.is_none() && kind.is_empty() && !is_anthropic_error {
        return None;
    }
    let message = message.unwrap_or_else(|| "服务端在流中返回了错误".to_string());
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
