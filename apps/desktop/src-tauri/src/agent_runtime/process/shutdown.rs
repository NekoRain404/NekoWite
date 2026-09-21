//! How a running engine is ended: the signal sent to its process group, and the grace it gets
//! before the next one.
//!
//! A module of its own because the sequence is a policy with a measurement behind it — §6.2's
//! 「先正常取消/退出再限时终止」, and the SDK's own `SHUTDOWN_GRACE_PERIOD` value that
//! [`SHUTDOWN_GRACE`] reproduces — and because this is where §6.3's rule is *enforced* rather than
//! described: [`signal_group`] names a process group by its negative id and never by name, because
//! `pkill -f opencode` would reach the user's own installation, which this host never started. What
//! makes it change is a change in what a killed engine is owed, not in how it was launched or in
//! what it said while it ran.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

/// How long the engine gets to exit on its own before the group is signalled.
///
/// The ACP SDK's own transport uses one second for exactly this
/// (`SHUTDOWN_GRACE_PERIOD` in `acp_agent.rs`), and we reproduce it because we
/// own the child here: §6.2 asks for 「先正常取消/退出再限时终止」, and a process
/// given no time at all cannot finish a write it had started — which §3.3 of
/// the plan cares about, since engines migrate their own session databases.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(1);

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
        // `Error::other` rather than `new(ErrorKind::Other, …)`: the same error, without the lint
        // that says the shorter constructor is the one to use. The line was
        // `new(ErrorKind::Other, …)` in `process.rs` before this file was split out of it, so
        // clippy reported `io_other_error` at the moved location; `Error::other` is identical in
        // effect and takes the report away with it.
        Err(io::Error::other(format!(
            "could not send {signal} to process group {pgid}"
        )))
    }
}
