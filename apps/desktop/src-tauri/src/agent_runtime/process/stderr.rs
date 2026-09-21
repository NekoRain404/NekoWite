//! The engine's stderr as a failure reads it: the pump that drains it, the bound it keeps to, the
//! redaction of what it keeps, and the wait for the end of the pipe.
//!
//! A module of its own because it changes for reasons of its own. What this host retains of the
//! engine's own explanation is a *diagnostic* policy — [`MAX_STDERR_LINES`], [`MAX_STDERR_LINE_BYTES`],
//! [`MIN_SECRET_LEN`], what [`redact`] treats as a credential, how long a failure waits for the end
//! of the pipe ([`STDERR_EOF_BOUND`]) — and none of it moves when a launch field, a frame bound or a
//! signal does. It is also the one part of the process whose work the *engine's own output* decides,
//! which is why its bound is per line as well as per log: a count of lines alone is defeated by one
//! enormous line.
//!
//! Two properties are load-bearing, and both are argued where they are enforced rather than here:
//! the log never grows without bound, and no credential this host injected is ever retained — and
//! both hold on the way *in*, in [`pump_stderr`], because a reader that redacted on the way out
//! would still be holding the secret in memory.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::io::{AsyncRead, AsyncReadExt};
use tokio::sync::watch;

use super::launch::EngineLaunch;

/// Longest stderr line kept. A bound on "lines" is defeated by one enormous
/// line, so the cap is per line as well.
const MAX_STDERR_LINE_BYTES: usize = 2048;

/// Lines of stderr kept before the oldest are dropped. §6.2 keeps stderr
/// outside the protocol and gives it its own bound.
const MAX_STDERR_LINES: usize = 200;

/// How long a failure sentence waits for the pump to reach the end of the engine's stderr.
///
/// The wait is normally no wait at all, because the condition it waits for is already true: the
/// engine's death closes its end of the pipe, and the pump's work *ends* there — everything
/// written before that close is in the buffer and is read before the pump sees EOF — so a failure
/// that arrives after the engine is gone is waiting on a task that is already finishing rather
/// than on a delay.
///
/// The bound is for the case where the condition cannot become true soon: stderr stays open while
/// the connection does not when the engine closed its stdout and kept running, or when a wrapper
/// such as `npx` left a grandchild holding the write end past the engine's own exit. A failure
/// that hangs is worse than a failure with a short log, and a second is several thousand times
/// the drain of a pipe the engine has already let go of — on a loaded machine as on an idle one.
///
/// `pub` rather than private for one reason and no other: `engine_exit`, a sibling under
/// [`super`], argues its own bound by naming this one, and a sibling cannot reach a private item.
/// The name is therefore re-exported by [`super`] so that `super::STDERR_EOF_BOUND` — the path both
/// modules' docs use — still resolves.
pub const STDERR_EOF_BOUND: Duration = Duration::from_secs(1);

/// Shortest injected value treated as a secret. Redaction is textual, so a
/// two-character value like `1` would replace every `1` in every line and shred
/// the diagnostics this exists to preserve.
const MIN_SECRET_LEN: usize = 8;

/// The engine's stderr, sampled and redacted.
///
/// What this guarantees is bounded memory and no injected credential in the
/// retained text. What it does NOT do is throttle the engine: stderr is always
/// drained, because a full pipe would block the engine on its own logging and
/// deadlock a run that has nothing to do with the message.
///
/// Its reader is a *failure*: [`Self::tail`] is what the transport appends to the
/// engine's side of a broken connection, so a log that used to be written and then
/// dropped by nobody's hand is now the engine's own account of why it is gone.
#[derive(Debug, Default)]
pub struct StderrLog {
    lines: VecDeque<String>,
    dropped: u64,
}

impl StderrLog {
    fn push(&mut self, line: String) {
        if self.lines.len() == MAX_STDERR_LINES {
            self.lines.pop_front();
            self.dropped += 1;
        }
        self.lines.push_back(line);
    }

    /// The retained lines, oldest first.
    pub fn lines(&self) -> Vec<String> {
        self.lines.iter().cloned().collect()
    }

    /// How many lines the bound discarded, so a truncated log says so instead
    /// of looking complete.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// The engine's own last words, as the text a failure carries.
    ///
    /// `None` when nothing was captured: a launch failure with an empty log has
    /// nothing to add to its sentence, and a heading with no lines under it would
    /// be worse than silence.
    ///
    /// Two of the three properties here come from the way the text arrived rather
    /// than from this method. Every line has already been through [`redact`] —
    /// `pump_stderr` is the only writer of a log and it redacts each line on the way
    /// in — and what is left is bounded by [`MAX_STDERR_LINE_BYTES`] per line and
    /// [`MAX_STDERR_LINES`] lines. The third is this method's: a log the bound
    /// truncated *says so*, so a partial sample is never presentable as the whole of
    /// what the engine said.
    pub fn tail(&self) -> Option<String> {
        let lines = self.lines();
        if lines.is_empty() {
            return None;
        }
        let mut text = format!("the engine's own stderr, last {} lines:", lines.len());
        for line in &lines {
            text.push_str("\n  ");
            text.push_str(line);
        }
        let dropped = self.dropped();
        if dropped > 0 {
            text.push_str(&format!(
                "\n({dropped} earlier lines were discarded by this app's {MAX_STDERR_LINES}-line \
                 bound, so this is not the whole of what the engine said)"
            ));
        }
        Some(text)
    }
}

/// The credentials a runtime injected, for redaction.
///
/// Read out of the launch by name. Every variable the launch carries is treated as a candidate,
/// including the profile roots and the CA bundle — over-redacting a path in the engine's stderr
/// costs a diagnostic line, and under-redacting costs the credential (see `redact`).
pub fn secrets_of(launch: &EngineLaunch) -> Vec<String> {
    launch
        .env
        .iter()
        .map(|(_, value)| value.expose().to_string())
        .filter(|value| value.len() >= MIN_SECRET_LEN)
        .collect()
}

/// Drains the engine's stderr forever, keeping a bounded, redacted sample.
pub async fn pump_stderr<R: AsyncRead + Unpin>(
    mut reader: R,
    log: Arc<Mutex<StderrLog>>,
    secrets: Vec<String>,
) {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    // Set while discarding the tail of a line that already blew the cap: the
    // rest of it must not be buffered, or one enormous line defeats the bound
    // by being one line.
    let mut overlong = false;

    loop {
        let read = match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        buf.extend_from_slice(&chunk[..read]);
        while let Some(end) = buf.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buf.drain(..=end).collect();
            if !overlong {
                keep_line(&log, &secrets, &line[..line.len() - 1]);
            }
            overlong = false;
        }
        if buf.len() > MAX_STDERR_LINE_BYTES {
            buf.clear();
            overlong = true;
        }
    }
    // The engine's last line may have no newline; it is still a line.
    if !overlong && !buf.is_empty() {
        keep_line(&log, &secrets, &buf);
    }
}

/// The engine's stderr as a failure reads it: the pump, the log it fills, and the end of both.
///
/// The two travel together because one without the other is what the sample problem was.
/// [`StderrLog::tail`] on its own answers with whatever the pump happens to have stored, and the
/// pump runs as a task of its own — so a failure noticed the instant the engine dies can arrive
/// before that task has been polled even once, and the sentence is built with nothing under it.
/// [`Self::tail`] waits for the pump to reach EOF first, which is the one moment at which the log
/// is known to hold everything the engine wrote.
pub struct EngineStderr {
    log: Arc<Mutex<StderrLog>>,
    /// Set once the pump has stopped, at the end of the pipe.
    ///
    /// A `watch` rather than a notification because it is level-triggered: a reader that arrives
    /// after the pump is done — which is every reader, once the engine is gone — reads the state
    /// instead of having missed a wake-up, and the second failure reads it as well as the first.
    ended: watch::Receiver<bool>,
}

impl EngineStderr {
    /// Drains `reader` on a task of its own and returns the reading end.
    ///
    /// The log is built *here*, before the spawn, and the handle to it comes back. A log that
    /// exists only as an argument to `tokio::spawn` is one no failure can read: written,
    /// bounded, redacted, and dropped with the task that filled it — which is what this was
    /// before a start failure had a reader, and why the constructor is the only way to get one.
    pub fn drain<R>(reader: R, secrets: Vec<String>) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
    {
        let log = Arc::new(Mutex::new(StderrLog::default()));
        let (ended_tx, ended) = watch::channel(false);
        let pumped = Arc::clone(&log);
        tokio::spawn(async move {
            pump_stderr(reader, pumped, secrets).await;
            // Sent after the pump has returned, so the reading side cannot see `true` while a
            // line is still on its way into the log. A pump that panics drops the sender
            // instead, which ends the wait the same way: nothing more is coming.
            let _ = ended_tx.send(true);
        });
        Self { log, ended }
    }

    /// The engine's own last words, once the pump that reads them has finished.
    ///
    /// Every line has been through [`redact`] on its way in — `pump_stderr` is this log's only
    /// writer — so this reads the log and is never a second path to the pipe.
    ///
    /// Waits, bounded by [`STDERR_EOF_BOUND`], for the pump to stop: see that constant for why
    /// the wait is normally nothing, and for the case it is there to cut short. What is shown is
    /// bounded by [`MAX_STDERR_LINES`] and [`MAX_STDERR_LINE_BYTES`] either way, and a log that
    /// hit the bound still says so.
    pub async fn tail(&self) -> Option<String> {
        self.await_end().await;
        self.log.lock().unwrap().tail()
    }

    /// Waits for the pump to stop, for at most [`STDERR_EOF_BOUND`].
    async fn await_end(&self) {
        if *self.ended.borrow() {
            return;
        }
        let mut ended = self.ended.clone();
        // `Ok` and `Err` both mean the pump is done: it either said so or dropped the sender on
        // its way out, and neither leaves a line behind for a reader to wait for.
        let _ = tokio::time::timeout(STDERR_EOF_BOUND, ended.changed()).await;
    }
}

fn keep_line(log: &Arc<Mutex<StderrLog>>, secrets: &[String], line: &[u8]) {
    let line = &line[..line.len().min(MAX_STDERR_LINE_BYTES)];
    let text = redact(String::from_utf8_lossy(line).trim_end(), secrets);
    log.lock().unwrap().push(text);
}

/// Removes credentials from a line before it is kept.
///
/// Redaction is by value, not by pattern: the only secrets this process can be
/// certain of are the ones it injected itself, and a pattern broad enough to
/// catch an unknown provider's key would also catch ordinary prose. `Bearer` is
/// the one exception, because it is a scheme rather than a vendor format and a
/// token following it is a token by construction.
fn redact(line: &str, secrets: &[String]) -> String {
    let mut out = line.to_string();
    for secret in secrets {
        if out.contains(secret.as_str()) {
            out = out.replace(secret.as_str(), "<redacted>");
        }
    }
    let mut parts: Vec<&str> = out.split(' ').collect();
    for index in 0..parts.len().saturating_sub(1) {
        if parts[index].eq_ignore_ascii_case("bearer") {
            parts[index + 1] = "<redacted>";
        }
    }
    parts.join(" ")
}

#[cfg(test)]
mod stderr_tests {
    use super::*;
    use std::io;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    /// One reading of an engine's stderr, drained by the transport's own pump and read
    /// back the way a failure reads it — the whole path from the pipe to the sentence,
    /// rather than the formatter alone.
    async fn tail_of(text: &str, secrets: Vec<String>) -> Option<String> {
        EngineStderr::drain(pipe_of(text), secrets).tail().await
    }

    /// The engine's end of stderr, as the pump takes it: bytes that are already there and a
    /// pipe that is already closed, with nothing left to wait for but the reading. The pump
    /// owns it for as long as it runs, which is why this is an owned reader rather than a
    /// borrow of the caller's text.
    fn pipe_of(text: &str) -> futures_util::io::AllowStdIo<std::io::Cursor<Vec<u8>>> {
        futures_util::io::AllowStdIo::new(std::io::Cursor::new(text.as_bytes().to_vec()))
    }

    /// What a line is printed as, once the pump has taken it and the tail renders it.
    /// Written out because the rendering is the thing being asserted on, and a helper
    /// that recomputed it would only restate the implementation.
    fn shown(index: usize) -> String {
        format!("engine line {index}")
    }

    /// An engine's end of stderr that never closes: the bytes it wrote are handed over, and
    /// after that there is simply nothing — the state a process that closed its stdout and
    /// kept running leaves its reader in, and the one no pump can finish on its own.
    struct HeldOpen(Vec<u8>);

    impl HeldOpen {
        fn with(text: &str) -> Self {
            Self(text.as_bytes().to_vec())
        }
    }

    impl AsyncRead for HeldOpen {
        fn poll_read(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut [u8],
        ) -> Poll<io::Result<usize>> {
            let this = self.get_mut();
            if this.0.is_empty() {
                // Not EOF and not an error: the engine is still holding the pipe, and a
                // reader can only wait. No waker is registered because nothing will ever
                // wake it — which is the shape the bound exists for.
                return Poll::Pending;
            }
            let read = this.0.len().min(buf.len());
            buf[..read].copy_from_slice(&this.0[..read]);
            this.0.drain(..read);
            Poll::Ready(Ok(read))
        }
    }

    #[tokio::test]
    async fn a_line_the_engine_wrote_before_it_died_is_read_even_when_nothing_waited() {
        // The race, at the scale of the two tasks it is between and with no machine load in
        // it. The bytes are already in the pipe and the engine has already let go of it, so
        // the pump has nothing to wait for — but it is a task of its own, and the failure
        // that reads the log can be built before that task has been polled even once. The
        // reading is taken here without yielding to the runtime first, which is what makes
        // the interleaving a fact of this test rather than a hope about the machine: an
        // implementation that samples the log instead of waiting for the pump sees `None`.
        let engine = EngineStderr::drain(pipe_of("Error: no provider is configured\n"), Vec::new());
        let tail = engine
            .tail()
            .await
            .expect("the engine's last line is quoted, whenever the failure was noticed");
        assert!(
            tail.contains("no provider is configured"),
            "and it is the line the engine wrote: {tail}"
        );
    }

    #[tokio::test]
    async fn a_pipe_the_engine_kept_open_does_not_hold_a_failure_forever() {
        // The other end of the same wait: an engine that is alive but no longer answering
        // leaves stderr open, so waiting for the pump to finish is waiting for something that
        // is not going to happen. A failure that hangs is worse than one with a short log, so
        // the wait is bounded and what has been written so far is quoted as it stands.
        let engine = EngineStderr::drain(HeldOpen::with("still starting\n"), Vec::new());

        let tail = tokio::time::timeout(STDERR_EOF_BOUND * 4, engine.tail())
            .await
            .expect("a reader must not wait on a pipe the engine has not closed")
            .expect("the line written so far is still quoted");
        assert!(tail.contains("still starting"), "{tail}");
    }

    #[tokio::test]
    async fn an_empty_log_says_nothing_rather_than_heading_a_failure() {
        // A launch that failed before the engine wrote anything: `None` leaves the
        // failure's own sentence alone. A heading over no lines would read as an
        // engine that said nothing, which is not the same as one nothing was kept from.
        assert!(tail_of("", Vec::new()).await.is_none());
    }

    #[tokio::test]
    async fn a_surfaced_line_has_been_through_the_redactor() {
        // The non-negotiable property of showing stderr at all: what is shown is the
        // already-redacted text, never the stream. The credential here is the launch's
        // own injected value, which is the one secret this process can be certain of.
        const SECRET: &str = "sk-test-9d41f7c2ab3e";
        let tail = tail_of(
            &format!("provider credential {SECRET} was refused\n"),
            vec![SECRET.to_string()],
        )
        .await
        .expect("the line was captured");
        assert!(
            !tail.contains(SECRET),
            "an injected credential must not reach a failure sentence: {tail}"
        );
        assert!(
            tail.contains("<redacted>"),
            "and what replaces it is the marker, not an omission: {tail}"
        );
    }

    #[tokio::test]
    async fn a_truncated_log_says_that_it_is_one() {
        // More lines than the bound holds. The tail must keep the newest, drop the
        // oldest, and *say* that it dropped them: `dropped` exists so a partial sample
        // is never presentable as the whole of what the engine said.
        let mut text = String::new();
        for index in 0..MAX_STDERR_LINES + 3 {
            text.push_str(&shown(index));
            text.push('\n');
        }
        let tail = tail_of(&text, Vec::new())
            .await
            .expect("lines were captured");

        assert!(
            tail.contains(&shown(MAX_STDERR_LINES + 2)),
            "the newest line is what an engine's failure is read for: {tail}"
        );
        assert!(
            !tail.contains(&shown(0)),
            "the oldest lines are what the bound is for, and they are gone: {tail}"
        );
        assert!(
            tail.contains(&format!(
                "3 earlier lines were discarded by this app's {MAX_STDERR_LINES}-line bound"
            )),
            "and the sample says it is one rather than looking complete: {tail}"
        );
    }
}
