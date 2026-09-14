//! Reassembling the byte stream: the rolling buffer that turns arbitrary-size
//! network chunks into complete SSE lines.
//!
//! Extracted from [`super`] as the lowest slice of the stream reader, because
//! holding bytes and giving them meaning are two concerns: what arrives here is
//! never decoded, never parsed and never interpreted, so the frame rules in
//! `frame` and the accumulation in `super` can change without touching the
//! reassembly - and the reassembly can be driven without a provider.
//!
//! Dependencies: [`super::super::limits`] for the one ceiling it enforces,
//! [`MAX_SSE_LINE_BYTES`]. Nothing here imports a provider module or a sibling,
//! so the buffer cannot join a cycle.

use super::super::limits::MAX_SSE_LINE_BYTES;

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
