//! The environment the engine is launched with.
//!
//! The process itself — spawning, its own Linux process group, killing that
//! group, reaping, and a bounded capture of its stderr — belongs to the ACP
//! SDK's `AcpAgent` transport, which is the same code path Zed uses. It sets
//! `process_group(0)` when it spawns and kills the whole group on drop with
//! `rustix::process::kill_process_group`, which is the §6.2 requirement
//! implemented once, by the library, instead of twice by us. What the SDK
//! cannot know is which CA bundle this app must hand its engine, and that is
//! what is left here.
//!
//! §6.3's other half still applies to this host: only processes this runtime
//! started may be signalled. `AcpAgent` signals the group it created and holds
//! the handle to, so the user's own `opencode` — a different process, in a
//! different group, started by them — is never a candidate.

use std::collections::VecDeque;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use agent_client_protocol::AcpAgentConfig;
use futures_util::io::{AsyncRead, AsyncReadExt};
use tokio::sync::watch;

use super::secret::Secret;

/// The roots a profile-isolated launch pins, re-exported so the path every caller already names
/// keeps working after it moved to a module of its own — see [`super::environment`], which carries
/// the record of what it closes, what it leaves open, and how each was measured.
pub use super::environment::isolated_profile_env;

/// The CA bundle handed to the engine through `NODE_EXTRA_CA_CERTS`.
///
/// P0 §2.4: without it every prompt against a host whose chain is complete but
/// absent from the engine's bundled store fails as `unknown certificate
/// verification error` — a sentence that names neither the host nor the fix.
/// The value is the path the measurement used, which is the Debian/Arch
/// spelling of the system bundle; a distribution that keeps its store
/// elsewhere can override it through [`EngineLaunch::ca_bundle`].
pub const SYSTEM_CA_BUNDLE: &str = "/etc/ssl/certs/ca-certificates.crt";

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

/// How long the engine gets to exit on its own before the group is signalled.
///
/// The ACP SDK's own transport uses one second for exactly this
/// (`SHUTDOWN_GRACE_PERIOD` in `acp_agent.rs`), and we reproduce it because we
/// own the child here: §6.2 asks for 「先正常取消/退出再限时终止」, and a process
/// given no time at all cannot finish a write it had started — which §3.3 of
/// the plan cares about, since engines migrate their own session databases.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(1);

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
const STDERR_EOF_BOUND: Duration = Duration::from_secs(1);

/// Shortest injected value treated as a secret. Redaction is textual, so a
/// two-character value like `1` would replace every `1` in every line and shred
/// the diagnostics this exists to preserve.
const MIN_SECRET_LEN: usize = 8;

/// How to start one engine.
///
/// The caller owns `program`: the bundled artifact's path is a packaging
/// decision (T14), and the tests pass a fixture script instead.
///
/// **`env` holds [`Secret`]s, and that is the whole of what makes this struct
/// safe to derive `Debug` on.** T3a found the derived impl printing `env`
/// verbatim while the field was a `Vec<(String, String)>`; T12 then refused to
/// inject a provider key into a vector any `{:?}` could print, which left the
/// plan's credential flow unimplemented. The fix is the field's type rather
/// than an impl here: a value that cannot be printed is unprintable in *every*
/// struct that holds one — this one, a future wrapper, a `Vec` of launches in a
/// diagnostic — while a hand-written `Debug` would only be a promise about this
/// one. `ca_bundle` and the arguments stay plain: neither is a credential, and
/// P0 §3 keeps credentials out of `argv` entirely.
#[derive(Debug, Clone, Default)]
pub struct EngineLaunch {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Profile roots and credentials travel in the environment, never in
    /// `argv` (P0 §3): `/proc/<pid>/cmdline` is world-readable, so an API key
    /// on a command line is a key disclosed to every process on the machine.
    pub env: Vec<(String, Secret)>,
    /// A CA bundle to hand the engine; `None` means "the system one, when it is
    /// there".
    pub ca_bundle: Option<PathBuf>,
}

impl EngineLaunch {
    /// The SDK's launch description, with the CA variable resolved.
    ///
    /// This is one of the places the text itself has to exist — the SDK hands
    /// it to `execve`'s child environment — so it calls [`Secret::expose`] by
    /// name rather than the field being printable.
    pub fn agent_config(&self) -> AcpAgentConfig {
        let mut config = AcpAgentConfig::new(&self.program).args(self.args.clone());
        config = config.envs(
            self.env
                .iter()
                .map(|(name, value)| (name.clone(), value.expose().to_string())),
        );
        if let Some(bundle) = self.resolve_ca_bundle() {
            config = config.env("NODE_EXTRA_CA_CERTS", bundle.to_string_lossy().into_owned());
        }
        config
    }

    /// The CA bundle to inject, or `None` to leave the environment as it is.
    fn resolve_ca_bundle(&self) -> Option<PathBuf> {
        // An explicit override wins, including over an inherited variable: the
        // caller naming a bundle has a reason to.
        if let Some(explicit) = &self.ca_bundle {
            return Some(explicit.clone());
        }
        // An inherited `NODE_EXTRA_CA_CERTS` is a deliberate environment — a
        // corporate bundle, a test harness, a distribution that patches the
        // default — and is exactly the case the variable exists to serve, so
        // it is left alone.
        if std::env::var_os("NODE_EXTRA_CA_CERTS").is_some() {
            return None;
        }
        let system = PathBuf::from(SYSTEM_CA_BUNDLE);
        // A path the engine cannot read is worse than no variable at all: Node
        // warns and ignores it, and the user is left with the opaque TLS
        // failure this is here to prevent. A distribution without a system
        // bundle gets none, and the certificate failure is classified instead
        // (see `acp_transport::certificate_failure`).
        system.is_file().then_some(system)
    }
}

/// Plain pairs as launch environment entries.
///
/// The one conversion in the crate from `String` values into [`EngineLaunch::env`], and it only
/// ever moves a value *into* the protector: a caller that has strings is a caller that holds no
/// credential type (a probe launch, a test fixture, the profile roots), and what it produces cannot
/// be printed afterwards — so the conversion cannot be the step a credential escapes through.
pub fn env_pairs(pairs: impl IntoIterator<Item = (String, String)>) -> Vec<(String, Secret)> {
    pairs
        .into_iter()
        .map(|(name, value)| (name, Secret::new(value)))
        .collect()
}

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

/// Signals a whole process group.
///
/// The negative pid is the group form, and it is deliberately the ONLY way this
/// module names a target: §6.3 forbids signalling by name, because
/// `pkill -f opencode` would reach the user's own installation, which this host
/// never started and has no business ending.
///
/// `kill(1)` is invoked rather than `libc::kill` because `libc` is not a direct
/// dependency of this crate and adding one would edit `Cargo.lock`. The path is
/// probed rather than assumed: the binary lives under `/bin` on distributions
/// that never merged `/usr`.
pub fn signal_group(pgid: i32, signal: &str) -> io::Result<()> {
    const CANDIDATES: [&str; 2] = ["/usr/bin/kill", "/bin/kill"];
    let binary = CANDIDATES
        .iter()
        .map(Path::new)
        .find(|path| path.is_file())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("kill"));
    let status = std::process::Command::new(binary)
        .arg(signal)
        // Without `--`, a negative pid is read as a bundle of options.
        .arg("--")
        .arg(format!("-{pgid}"))
        // `kill` explains itself on stderr; the caller already knows what it
        // asked for, and this text must not reach the user's terminal.
        .stderr(Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::Other,
            format!("could not send {signal} to process group {pgid}"),
        ))
    }
}

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

#[cfg(test)]
mod stderr_tests {
    use super::*;

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
