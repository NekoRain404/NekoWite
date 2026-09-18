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

use super::secret::Secret;

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

/// The environment an engine gets when it must not touch the developer's own
/// profile: `HOME` and the four XDG roots all point into `root`.
///
/// Plan §10.4 forbids exercising the real OpenCode profile, and the engine
/// writes config, state and logs under these roots the moment it starts. Used
/// by the real-engine test, where there is a real profile to protect.
///
/// # What this closes, and what it does not (measured)
///
/// §8.1 refused to let 「所有全局发现已关闭」 be asserted without evidence, and P0
/// §4 listed the profile's isolation as unverified. It has now been measured
/// against the pinned engine, by planting a decoy provider in every place the
/// engine's discovery looks and reading back what `session/new` advertised —
/// `tests/agent_profile_isolation_test.rs` is that measurement, and it fails if
/// either half of what follows changes.
///
/// **Closed, and by these roots.** The engine resolves its own home from
/// `$HOME`, so `$HOME/.config/opencode`, `$HOME/.opencode`, `$HOME/.claude` and
/// `$HOME/.agents` are all read from inside `root`; `XDG_CONFIG_HOME` moves the
/// global configuration root with them. The decoys planted at those relative
/// paths are discovered, which is the positive control — the same files at the
/// same paths stop being reachable when `HOME` is left alone. The developer's
/// real profile, real configuration and real compatible-tool directories are
/// therefore not read by an engine launched this way.
///
/// **Closed a second time, because the roots alone did not close it.**
/// `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` is set here for one measured reason:
/// the engine reaches `.claude` and `.agents` by a *second* route that no
/// environment root can move. Alongside reading them under `$HOME`, it walks up
/// from the working directory — to the worktree, and past it where there is
/// none — and reads `skills/**` from every `.claude` and `.agents` it passes.
/// That walk is driven by the path, not by the environment, so a vault anywhere
/// under the user's home directory drags the user's real `~/.claude/skills` into
/// this profile as agent commands: measured, the same launch discovered 9
/// commands from a working directory inside a checkout and 43 (3 built in, 38
/// the developer's own, in-profile decoys beside them) from one under the home
/// directory, with nothing changed but the path. This is the leak the README of
/// this module is about — it is the developer's *own profile* being read, not a
/// project's configuration — which is why the switch is here and not in an
/// adapter. The engine's own documentation names it for exactly this, and
/// `skills.rs` already records it as the one whole-scope switch that exists.
///
/// **Open, and deliberately not closed here.** The same walk also reads a
/// project's `opencode.json` and `.opencode/` directories, and every decoy
/// planted along it is discovered: a vault contributes its providers and its
/// permission rules to this profile. `OPENCODE_DISABLE_PROJECT_CONFIG=1` closes
/// that, and is not set here for §3.4's reason rather than for convenience —
/// which project configuration an engine merges is a fact about that engine, so
/// it belongs in `AgentRegistration::env_extra` and `adapters/opencode.rs`,
/// beside the invocation and the config format. Nothing about the user's own
/// profile is at stake in it, which is what separates it from the switch above.
///
/// **Open, and not closable by any supported variable.** On Linux the engine
/// merges `opencode.json`/`opencode.jsonc` from its managed configuration root,
/// `/etc/opencode`, at global precedence. Nothing turns that off. The engine's
/// one way to move it is `OPENCODE_TEST_MANAGED_CONFIG_DIR`, a hook named for
/// the engine's own test suite; pointing it elsewhere from this app would
/// override a system administrator's policy rather than protect a user's
/// profile, and a machine with no `/etc/opencode` has nothing to close. So this
/// surface is left where the engine put it and named here instead of being
/// implied shut.
///
/// **Closed: the environment this launch *inherits*.** The roots above are
/// added to an environment, not substituted for one. The SDK spawns the engine
/// with `Command::envs` on a `Command` that never calls `env_clear`
/// (`agent-client-protocol` 2.1.0, `acp_agent.rs`'s `spawn_process`), so the
/// engine receives everything this app was itself started with, and the
/// launch's own entry is what `execve` carries where the two name the same
/// variable. Nothing here could *remove* a variable — the SDK's launch
/// description has no way to say so — but setting one is enough, and the
/// difference between that and nothing is what the four entries below are.
///
/// The four are the variables the engine reads from its environment to decide
/// **where its configuration comes from and where it writes**, and they are
/// named by measurement against the pinned engine rather than by reading its
/// documentation. A decoy provider planted in each, delivered exactly as an
/// inherited variable is, reached `session/new`'s model list through three of
/// them and put the engine's database at the developer's own path through the
/// fourth — a database this profile would then read and write for as long as
/// the app ran. Setting each to the value below removes it, leaves the
/// profile's own configuration document discovered, and leaves the database
/// inside the profile root. `tests/agent_profile_isolation_test.rs`'s
/// `the_launch_closes_what_the_environment_it_inherits_points_at` is that
/// measurement, and it fails if any of the four is dropped or stops being
/// honoured.
///
/// **What this does not cover, said rather than implied.** It is a deny-list,
/// and a deny-list cannot be complete: the pinned engine's string table names
/// 79 distinct `OPENCODE_*` variables, this launch neutralises the four that
/// were measured to redirect configuration or storage, and the other 75 were
/// not measured. `OPENCODE_PERMISSION`, `OPENCODE_AUTH_CONTENT` and
/// `OPENCODE_API_KEY` are the three worth measuring next, and the reason is
/// only that each reaches the engine exactly the way the four above did — a
/// variable this host does not set, in an environment it does not clear. What
/// the first of them would do here is not known.
pub fn isolated_profile_env(root: &std::path::Path) -> Vec<(String, String)> {
    let at = |name: &str| {
        (
            name.to_string(),
            root.join(name).to_string_lossy().into_owned(),
        )
    };
    vec![
        at("HOME"),
        at("XDG_CONFIG_HOME"),
        at("XDG_DATA_HOME"),
        at("XDG_CACHE_HOME"),
        // Where the engine's `locks/` directory lands (`<this>/opencode/locks/`). The name
        // promises a lock and the thing is not one, which matters here because this line is
        // what decides where it lands: each entry is a directory holding a `meta.json` (token,
        // pid, hostname) and an empty `heartbeat`, taken with no kernel lock and refused by
        // nobody. Two instances share one profile root, so they share this directory too —
        // measured in `two-instances-shared-state.md` §2, where two and at one point three
        // engines ran on one root with a marker present and a `SIGKILL`ed engine left one
        // behind with its dead pid. The only mutual exclusion between two engines is SQLite's
        // own, inside the database; nothing may be read out of this directory as protection.
        at("XDG_STATE_HOME"),
        // The one entry here that is not a root, and the only one that could be:
        // see the doc comment. It is what stops the engine's path-driven walk
        // from reaching the user's real `.claude` and `.agents` directories.
        (
            "OPENCODE_DISABLE_EXTERNAL_SKILLS".to_string(),
            "1".to_string(),
        ),
        // **The inherited environment, closed.** Each of these names somewhere
        // the engine would read configuration from, or write to, other than the
        // roots above — and each is read from the environment *in preference*
        // to what a root decides, so a developer who exported one reached this
        // profile through it.
        //
        // They come last, so nothing above can outrank them and
        // `AgentRegistration::env_extra` can still put one back deliberately —
        // `registry.rs` appends that vector after this one for exactly this
        // reason.
        //
        // **`OPENCODE_CONFIG_DIR` is a path here and not `""`, and that is the
        // one value arrived at by breaking something.** `""` closes the
        // inherited directory exactly as well, and it also costs the profile
        // its own permission rules: measured, the engine stops applying the
        // block this app ships in its configuration document, so
        // `agent_permission_grants_live_test`'s
        // `the_engines_own_evaluation_stops_silencing_after_the_revoke` goes
        // from `ask` to `allow` — the app's whole permission gate, off, with
        // the rest of the suite green. The document itself is *not* what is
        // lost: its provider is still discovered with `""` in place, measured
        // the same way every other discovery in this module was. So the effect
        // is on how the engine resolves permissions and the mechanism behind it
        // was not established — said that way because a guess would read as a
        // measurement, which is the failure this whole doc comment exists to
        // avoid.
        //
        // Pointing the variable at the directory the document already lives in
        // closes the inherited value *and* keeps the permission block, because
        // it names the root discovery would have chosen anyway. The path is
        // `profile::ENGINE_CONFIG_DOCUMENT`'s parent, spelled here rather than
        // imported so this module keeps knowing nothing about profiles — the
        // unit test at the foot of this file is what stops the two drifting
        // apart.
        (
            "OPENCODE_CONFIG_DIR".to_string(),
            root.join("XDG_CONFIG_HOME/opencode")
                .to_string_lossy()
                .into_owned(),
        ),
        // A file this host does not designate, and inline content it does not
        // carry: `""` is this engine's spelling for "not set" and `"{}"` is the
        // same statement where the value has to keep being valid JSON. Both
        // measured to close the inherited value without disturbing the
        // document.
        ("OPENCODE_CONFIG".to_string(), String::new()),
        ("OPENCODE_CONFIG_CONTENT".to_string(), "{}".to_string()),
        // The engine's session database. An inherited value put it at the
        // developer's own path, where this profile then read and wrote a
        // database that is not its own.
        ("OPENCODE_DB".to_string(), String::new()),
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
mod tests {
    use super::*;

    /// The one thing two modules have to agree about.
    ///
    /// `isolated_profile_env` names `OPENCODE_CONFIG_DIR` by spelling the path, because this module
    /// knows nothing about profiles and importing the constant would be the wrong direction. That
    /// leaves one way for the two to drift, and the drift is not cosmetic: point the variable at a
    /// directory the document does not live in and the engine stops applying the permission block
    /// this app ships — the engine goes back to allowing an edit without asking anything. This test
    /// is the agreement, and it is the only place that says the two names are the same directory.
    #[test]
    fn the_configuration_directory_is_the_one_the_document_lives_in() {
        let root = Path::new("/tmp/nwk-profile");
        let configured = isolated_profile_env(root)
            .into_iter()
            .find(|(name, _)| name == "OPENCODE_CONFIG_DIR")
            .expect("an app-managed launch pins the engine's configuration directory")
            .1;
        let document = root.join(crate::agent_runtime::profile::ENGINE_CONFIG_DOCUMENT);
        assert_eq!(
            Path::new(&configured),
            document.parent().expect("the document has a parent"),
            "OPENCODE_CONFIG_DIR must name the directory the profile's configuration document \
             lives in, or the engine reads a different configuration and the permission block \
             this app ships stops being applied"
        );
    }
}
