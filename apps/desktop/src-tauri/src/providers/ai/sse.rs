//! SSE frame handling: reassembling the byte stream into lines, folding a line
//! into an [`SseDelta`], and the per-completion state ([`CompletionStream`])
//! that holds the reassembly and answer ceilings while it accumulates.
//!
//! Dependencies: [`super::limits`] for the two ceilings it enforces,
//! [`super::response`] for the token accounting a frame may carry, and the two
//! provider modules it dispatches text/usage extraction to by provider name.
//! The arrow points one way - `sse` to the provider modules, the provider
//! modules to `request`/`response`, never back here - so no cycle exists.

use super::limits::{MAX_ANSWER_BYTES, MAX_SSE_LINE_BYTES};
use super::response::TokenUsage;
use super::{gemini, openai_compatible};

/// Fold one parsed frame's usage into a stream's running total.
pub fn accumulate_usage(total: &mut Option<TokenUsage>, delta: &SseDelta) {
    if let Some(found) = delta.usage {
        total.get_or_insert_with(TokenUsage::default).merge(found);
    }
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
///
/// The buffer is bounded by [`MAX_SSE_LINE_BYTES`]. Because every complete line
/// is drained the moment its newline arrives, the only thing that ever stays
/// buffered is ONE unterminated line — so that single ceiling is also the
/// ceiling on the buffer. A peer that streams bytes without ever sending a
/// newline is refused rather than buffered.
#[derive(Debug, Default)]
pub struct SseBuffer {
    pending: Vec<u8>,
}

impl SseBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append a chunk and return the lines it completed.
    ///
    /// `Err` means the reassembly buffer's invariant is broken (a frame past
    /// [`MAX_SSE_LINE_BYTES`]): the caller must abandon the response, because
    /// the frame boundary it is waiting for can no longer be trusted to be a
    /// frame — a peer that never sends a newline has no lines left to give.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        let mut lines = Vec::new();
        let mut rest = chunk;
        // Walk the chunk instead of appending it whole: a single chunk may hold
        // thousands of complete frames, and buffering all of them before
        // checking the size would defeat the ceiling it is meant to enforce.
        while let Some(nl) = rest.iter().position(|&b| b == b'\n') {
            let (line, tail) = rest.split_at(nl + 1);
            self.buffer(line)?;
            lines.push(self.take_line());
            rest = tail;
        }
        // Whatever is left has no newline yet: it is the start (or middle) of
        // the next line and stays buffered.
        self.buffer(rest)?;
        Ok(lines)
    }

    /// Append bytes to the pending line, refusing to grow past the ceiling.
    fn buffer(&mut self, bytes: &[u8]) -> Result<(), String> {
        if self.pending.len() + bytes.len() > MAX_SSE_LINE_BYTES {
            return Err(format!(
                "AI 响应帧过大（超过 {} 字节），已中止本次生成。",
                MAX_SSE_LINE_BYTES
            ));
        }
        self.pending.extend_from_slice(bytes);
        Ok(())
    }

    /// Decode and drain the pending line. Only called right after a segment
    /// ending in `\n` was appended, so the pending bytes are exactly one
    /// complete line and its last byte is that newline.
    fn take_line(&mut self) -> String {
        let nl = self.pending.len() - 1;
        let line: Vec<u8> = self.pending.drain(..=nl).collect();
        String::from_utf8_lossy(&line)
            .trim_end_matches(['\r', '\n'])
            .to_string()
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
/// ceiling on a live answer ([`MAX_ANSWER_BYTES`]) belongs to the stream that
/// owns the accumulation, and that is [`CompletionStream`]. Anything streaming
/// a provider response must go through it rather than calling this directly in
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
fn extract_stream_error(v: &serde_json::Value) -> Option<String> {
    let is_anthropic_error = v.get("type").and_then(|t| t.as_str()) == Some("error");
    let err = v.get("error");
    if err.is_none() && !is_anthropic_error {
        return None;
    }
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
        .unwrap_or_else(|| "服务端在流中返回了错误".to_string());
    let kind = err
        .and_then(|e| e.get("type").and_then(|t| t.as_str()))
        .unwrap_or("");
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

/// What one folded chunk produced, in the order it must be delivered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEvent {
    /// Answer text to append to the document.
    Text(String),
    /// Reasoning progress; drives the "thinking" indicator only, never the text.
    Reasoning(String),
    /// The provider ended the stream (`data: [DONE]`).
    Done,
    /// The provider reported a failure INSIDE an HTTP 200 response.
    ProviderError(String),
}

/// The streaming state of ONE completion: the SSE reassembly buffer, the answer
/// being accumulated, the provider's token accounting and the reason it
/// stopped.
///
/// This is the streaming loop minus the socket and minus the Tauri events, so
/// the response-side size policy ([`MAX_SSE_LINE_BYTES`] on reassembly,
/// [`MAX_ANSWER_BYTES`] on the accumulated answer) is enforced in one place and
/// can be driven in tests without a running app. The caller owns the transport
/// and the emits: feed it bytes, deliver the events it returns, stop on `Done`.
#[derive(Debug)]
pub struct CompletionStream {
    provider: String,
    buffer: SseBuffer,
    full: String,
    usage: Option<TokenUsage>,
    reasoning_seen: bool,
    finish_reason: Option<String>,
}

impl CompletionStream {
    pub fn new(provider: &str) -> Self {
        Self {
            provider: provider.to_string(),
            buffer: SseBuffer::new(),
            full: String::new(),
            usage: None,
            reasoning_seen: false,
            finish_reason: None,
        }
    }

    /// Fold one network chunk.
    ///
    /// `Err` is a coded ceiling (an oversized frame, an over-long answer): the
    /// caller must stop, report it and abandon the connection. A PROVIDER error
    /// inside a 200 response is deliberately NOT an `Err` — it comes back as a
    /// [`StreamEvent::ProviderError`] so any deltas the same chunk produced
    /// first are still delivered, which is what the loop did before the fold
    /// moved here.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<StreamEvent>, String> {
        let lines = self.buffer.feed(chunk)?;
        self.fold(lines)
    }

    /// Fold the bytes still buffered after the stream ended (a server that
    /// stopped mid-line). A cancelled stream must NOT be flushed: the tail of
    /// an abandoned response is how a late chunk got adopted by the next
    /// request.
    pub fn finish(&mut self) -> Result<Vec<StreamEvent>, String> {
        let lines = self.buffer.flush();
        self.fold(lines)
    }

    fn fold(&mut self, lines: Vec<String>) -> Result<Vec<StreamEvent>, String> {
        let mut events = Vec::new();
        for line in lines {
            let Some(delta) = parse_sse_event(&line, &self.provider, &mut self.full) else {
                continue;
            };
            accumulate_usage(&mut self.usage, &delta);
            if let Some(message) = delta.error {
                events.push(StreamEvent::ProviderError(message));
                return Ok(events);
            }
            if delta.done {
                events.push(StreamEvent::Done);
                return Ok(events);
            }
            if let Some(reason) = delta.finish_reason {
                self.finish_reason = Some(reason);
            }
            if let Some(reasoning) = delta.reasoning {
                self.reasoning_seen = true;
                events.push(StreamEvent::Reasoning(reasoning));
            }
            if let Some(text) = delta.text {
                events.push(StreamEvent::Text(text));
            }
            // The answer ceiling is checked beside the accumulation it bounds,
            // and it has to be checked here rather than at the end: without it
            // `full` grows for as long as the provider keeps sending. The
            // overshoot is one frame, since that is the granularity of a check
            // that also has to keep streaming in real time.
            if self.full.len() > MAX_ANSWER_BYTES {
                return Err(format!(
                    "AI 回答过长（超过 {} 字节），已中止本次生成。",
                    MAX_ANSWER_BYTES
                ));
            }
        }
        Ok(events)
    }

    /// The answer accumulated so far.
    pub fn answer(&self) -> &str {
        &self.full
    }

    /// Token counts the provider reported, when it reported any.
    pub fn usage(&self) -> Option<TokenUsage> {
        self.usage
    }

    /// Why the provider said it stopped (`length`, `content_filter`, `stop`, …).
    pub fn finish_reason(&self) -> Option<&str> {
        self.finish_reason.as_deref()
    }

    /// True when the provider streamed reasoning progress. An answer-less
    /// completion that reasoned spent its budget thinking, which is not an
    /// ordinary empty reply.
    pub fn saw_reasoning(&self) -> bool {
        self.reasoning_seen
    }
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
