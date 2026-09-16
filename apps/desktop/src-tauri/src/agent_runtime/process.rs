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

/// Shortest injected value treated as a secret. Redaction is textual, so a
/// two-character value like `1` would replace every `1` in every line and shred
/// the diagnostics this exists to preserve.
const MIN_SECRET_LEN: usize = 8;

/// How to start one engine.
///
/// The caller owns `program`: the bundled artifact's path is a packaging
/// decision (T14), and the tests pass a fixture script instead.
#[derive(Debug, Clone, Default)]
pub struct EngineLaunch {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Credentials and profile roots travel in the environment, never in
    /// `argv` (P0 §3): `/proc/<pid>/cmdline` is world-readable, so an API key
    /// on a command line is a key disclosed to every process on the machine.
    pub env: Vec<(String, String)>,
    /// A CA bundle to hand the engine; `None` means "the system one, when it is
    /// there".
    pub ca_bundle: Option<PathBuf>,
}

impl EngineLaunch {
    /// The SDK's launch description, with the CA variable resolved.
    pub fn agent_config(&self) -> AcpAgentConfig {
        let mut config = AcpAgentConfig::new(&self.program).args(self.args.clone());
        config = config.envs(self.env.iter().map(|(k, v)| (k.clone(), v.clone())));
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

/// The environment an engine gets when it must not touch the developer's own
/// profile: `HOME` and the XDG roots all point into `root`.
///
/// Plan §10.4 forbids exercising the real OpenCode profile, and the engine
/// writes config, state and logs under these roots the moment it starts. Used
/// by the real-engine test, where there is a real profile to protect.
pub fn isolated_profile_env(root: &std::path::Path) -> Vec<(String, String)> {
    let at = |name: &str| (name.to_string(), root.join(name).to_string_lossy().into_owned());
    vec![
        at("HOME"),
        at("XDG_CONFIG_HOME"),
        at("XDG_DATA_HOME"),
        at("XDG_CACHE_HOME"),
        at("XDG_STATE_HOME"),
    ]
}


/// The engine's stderr, sampled and redacted.
///
/// What this guarantees is bounded memory and no injected credential in the
/// retained text. What it does NOT do is throttle the engine: stderr is always
/// drained, because a full pipe would block the engine on its own logging and
/// deadlock a run that has nothing to do with the message.
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
}

/// The credentials a runtime injected, for redaction.
pub fn secrets_of(launch: &EngineLaunch) -> Vec<String> {
    launch
        .env
        .iter()
        .map(|(_, value)| value.clone())
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
