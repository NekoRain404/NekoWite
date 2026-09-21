//! The bound on a single frame from the engine's stdout.
//!
//! A module of its own because it is the one piece of this host's process handling that exists for a
//! *library* defect rather than for a policy of this app: §6.2's size bound could not be left to the
//! protocol library, so it is enforced here, on the raw stream, and [`MAX_FRAME_BYTES`]'s doc carries
//! the measurement (§6.2's plan assumption, and rust-sdk #340/#342). What makes it change is
//! therefore unlike anything in its siblings: the day the SDK bounds a line itself, this becomes
//! belt-and-braces and is re-measured — the test that would notice is named in that doc — and the
//! marker [`FRAME_TOO_LARGE_MARKER`] is what a caller classifies on until then.
//!
//! It is an adapter and not a second framing implementation: bytes pass through untouched, and the
//! SDK still splits and decodes them. All that is added is a count.

use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use futures_util::io::AsyncRead;

/// The largest frame this host will accept from the engine.
///
/// §6.2 requires that a message-size bound be enforced, "aborts the run and
/// reports", and never drops data silently. The plan assumed 「消息体上限由所选
/// 协议库正确处理」 — that the chosen protocol library handles it — and it does
/// not: `agent-client-protocol`'s `Lines` has no maximum anywhere, and its
/// splitter is `BufReader::lines()`, which grows until it finds a newline. So
/// the bound is ours, applied to the engine's stdout before the SDK ever sees a
/// line (`BoundedFrameReader`). A timeout is not a substitute: it bounds time,
/// not memory, and nine megabytes in one second is still nine megabytes.
///
/// Eight mebibytes is chosen to clear the largest legitimate frame — the
/// handshake advertises `promptCapabilities.embeddedContext` and `image`, so a
/// frame can carry a base64 attachment — while still stopping a runaway write.
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Marks a frame that hit [`MAX_FRAME_BYTES`], so the failure can be classified
/// as the bound being exceeded rather than as a generic transport error.
pub const FRAME_TOO_LARGE_MARKER: &str = "acp frame exceeds the host's size bound";

/// An `AsyncRead` that fails once a single line exceeds `limit` bytes.
///
/// It is an ADAPTER, not a second framing implementation: bytes pass through
/// untouched, the SDK still splits and decodes them, and this only counts —
/// which keeps the one piece §6.2 needs and the plan wrongly assumed the
/// library provided.
///
/// **It must wrap the raw stdout, upstream of the SDK's line reader.** The
/// allocation this defends against happens while an unterminated line is being
/// accumulated, before any JSON exists, so a bound applied to parsed messages
/// would never fire. This is not defensive programming — it is an open defect
/// in a crate we depend on: `rust-sdk` #340/#342, whose own description is that
/// "one malformed or hostile ACP frame can exhaust the client process before
/// JSON-RPC parsing". If a future SDK version fixes that, this adapter becomes
/// redundant belt-and-braces rather than load-bearing, and should be re-measured
/// (the test `an_endless_frame_aborts_the_run_and_reports_the_bound` is what
/// would notice).
pub struct BoundedFrameReader<R> {
    inner: R,
    since_newline: usize,
    limit: usize,
    /// Set when the bound trips. The transport otherwise only learns that the
    /// connection closed, and "the connection closed" would send a reader
    /// looking for a crash that never happened.
    trip: Arc<Mutex<Option<String>>>,
}

impl<R> BoundedFrameReader<R> {
    pub fn new(inner: R, limit: usize, trip: Arc<Mutex<Option<String>>>) -> Self {
        Self {
            inner,
            since_newline: 0,
            limit,
            trip,
        }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for BoundedFrameReader<R> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let read = match Pin::new(&mut this.inner).poll_read(cx, buf) {
            Poll::Ready(Ok(read)) => read,
            other => return other,
        };
        for byte in &buf[..read] {
            if *byte == b'\n' {
                this.since_newline = 0;
            } else {
                this.since_newline += 1;
            }
        }
        if this.since_newline > this.limit {
            // Failing the read is what makes this an abort rather than a drop:
            // the SDK's reader sees an error, the connection ends, and every
            // waiting request is told why. A frame this size cannot be a real
            // message, so there is nothing to preserve by buffering it.
            let reason = format!(
                "the engine sent a frame larger than the {}-byte limit, so the run was stopped \
                 rather than buffered",
                this.limit
            );
            *this.trip.lock().unwrap() = Some(reason.clone());
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{FRAME_TOO_LARGE_MARKER}: {reason}"),
            )));
        }
        Poll::Ready(Ok(read))
    }
}
