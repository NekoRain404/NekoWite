//! SSE frame handling: the per-completion state ([`CompletionStream`]) that
//! drives reassembly and folding, and the compatibility surface of the two
//! slices under it.
//!
//! The stream reader is three pieces. `reassembly` turns arbitrary-size network
//! chunks into complete SSE lines, `frame` folds one line into an [`SseDelta`],
//! and this file is the state that drives both - the reassembly buffer, the
//! answer being accumulated, and the ceilings it accumulates under. The names
//! the old single-file layout exposed are re-exported below, so `client`,
//! `events` and the integration tests import them from where they always did -
//! no consumer file had to be edited.
//!
//! Dependencies: [`super::limits`] for the three ceilings it enforces,
//! [`super::response`] for the token accounting a frame may carry, and the two
//! provider modules the frame rules dispatch text/usage extraction to by
//! provider name. The arrow points one way - `sse` to the provider modules, the
//! provider modules to `request`/`response`, never back here - so no cycle
//! exists.

mod frame;
mod reassembly;

// A re-export, not a wrapper: each item has exactly one definition (in the
// slice named above) and this block is what lets the split land without
// touching `client`, `events` or the integration tests in the same commit.
// The internal code below uses these same names, so the list doubles as the
// module's import list.
pub use self::frame::{accumulate_usage, parse_sse_event, parse_sse_line, SseDelta};
pub use self::reassembly::SseBuffer;

use super::limits::{MAX_ANSWER_BYTES, MAX_RESPONSE_HEAD_BYTES};
use super::response::TokenUsage;

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
/// being accumulated, the provider's token accounting, the reason it stopped,
/// and whether anything was read from the response at all.
///
/// This is the streaming loop minus the socket and minus the Tauri events, so
/// the response-side size policy ([`MAX_SSE_LINE_BYTES`](super::limits::MAX_SSE_LINE_BYTES) on
/// reassembly, [`MAX_ANSWER_BYTES`] on the accumulated answer,
/// [`MAX_RESPONSE_HEAD_BYTES`] on the head kept for a failure) is enforced in
/// one place and can be driven in tests without a running app. The caller owns
/// the transport and the emits: feed it bytes, deliver the events it returns,
/// stop on `Done`.
#[derive(Debug)]
pub struct CompletionStream {
    provider: String,
    buffer: SseBuffer,
    full: String,
    usage: Option<TokenUsage>,
    reasoning_seen: bool,
    finish_reason: Option<String>,
    /// True once a line decoded as an event. See [`Self::saw_any_event`].
    saw_event: bool,
    /// The opening bytes of the response, kept only while no event has been
    /// read. See [`Self::response_head`].
    head: Vec<u8>,
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
            saw_event: false,
            head: Vec::new(),
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
        self.capture_head(chunk);
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
            // The response has now said something this app can read, whatever it
            // turns out to carry: from here it is a stream, not an answer we
            // could not read, and the head kept for a failure stops growing.
            self.saw_event = true;
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

    /// Whether any line of the response decoded as an event at all.
    ///
    /// This is the distinction the terminal verdict turns on, and the two halves
    /// are different statements about the world. A response that yielded events
    /// and has an empty answer is the provider saying nothing — an ordinary
    /// no-op, see [`super::refusal::completion_refusal`]. A response that
    /// yielded NO event is one this app could not read: a web page answered 200,
    /// a gateway's plain-text page, an empty body. There the app cannot say the
    /// model was silent, only that it could not read what came back, and it has
    /// to say so rather than end in an empty `ai-done`.
    ///
    /// `data: [DONE]` counts: a provider that ends a stream without content is a
    /// provider this app understood.
    pub fn saw_any_event(&self) -> bool {
        self.saw_event
    }

    /// The opening of the response, for the failure that has to show what came
    /// back when [`Self::saw_any_event`] is false.
    ///
    /// It is what arrived before the response proved to be a stream, capped at
    /// [`MAX_RESPONSE_HEAD_BYTES`] — the bound on this COPY, not on what is
    /// shown (see [`super::error_message::body_preview`]). The bytes are held
    /// raw and decoded only here, like the reassembly buffer's, so a multi-byte
    /// character split across two chunks cannot corrupt them.
    pub fn response_head(&self) -> String {
        String::from_utf8_lossy(&self.head).into_owned()
    }

    /// Keep the response's opening bytes while it has not yet proved to be an
    /// event stream. Bounded and cheap: a real stream stops filling this on its
    /// first event, and a response that never produces one is exactly the case
    /// the failure path is about to describe.
    fn capture_head(&mut self, chunk: &[u8]) {
        if self.saw_event || self.head.len() >= MAX_RESPONSE_HEAD_BYTES {
            return;
        }
        let room = MAX_RESPONSE_HEAD_BYTES - self.head.len();
        self.head.extend_from_slice(&chunk[..chunk.len().min(room)]);
    }
}
