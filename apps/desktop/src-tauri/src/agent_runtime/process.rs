//! The process the engine runs as, as much of it as this host owns.
//!
//! The process itself — spawning, its own Linux process group, killing that
//! group, reaping — belongs to the ACP SDK's `AcpAgent` transport, which is the same code path Zed
//! uses. It sets `process_group(0)` when it spawns and kills the whole group on drop with
//! `rustix::process::kill_process_group`, which is the §6.2 requirement implemented once, by the
//! library, instead of twice by us. What the SDK cannot know is which CA bundle this app must hand
//! its engine, how large a frame it will accept, what the engine's stderr is worth keeping, which
//! signal ends a run, and which process is still the one this host started — and that is what is
//! left here.
//!
//! §6.3's other half still applies to this host: only processes this runtime
//! started may be signalled. `AcpAgent` signals the group it created and holds
//! the handle to, so the user's own `opencode` — a different process, in a
//! different group, started by them — is never a candidate.
//!
//! **Split by what makes each part change, not by arithmetic.** `docs/dev.md` §5.4.2 puts the
//! criterion on the number of reasons a file changes rather than on its line count, and this file
//! had five: the contents of a launch, a bound on stdout, a bounded sample of the engine's own
//! output, the reading that frees a claim, and the sequence that ends a run. Each is now a child
//! module whose header argues why it is the one that moves when its subject does:
//!
//! - [`launch`] — what a launch *is*: the program, the arguments, the credential-bearing
//!   environment ([`EngineLaunch::env`] holds `Secret`s) and the CA bundle of P0 §2.4.
//! - [`frame`] — the bound on a single frame of the engine's stdout, which exists because the
//!   protocol library enforces none.
//! - [`stderr`] — the pump, the per-line and per-log bounds, the redaction, and the wait for the
//!   end of the pipe that turns a sample into the engine's last words.
//! - [`identity`] — the kernel's answer to "is the engine this host started still running?", which
//!   is the reading §3.4's claim is freed by.
//! - [`shutdown`] — the group signal and the grace it gets first, where §6.3's "never by name" is
//!   enforced rather than described.
//!
//! [`engine_exit`] was split out first, by the same rule: the host's reading of the engine's *end*
//! changes when a failure's account of a disconnected engine does, and not when any of the five
//! above do. It is the reason [`super::environment`] is a module of its own too — a question with
//! its own failure mode is not a section of the file that happens to sit near it.
//!
//! Every name a caller outside this directory reached before is re-exported below, so the split
//! moved no path: `acp_transport`, `events`, `registry`, `profile` and `permission_grants` name the
//! same symbols through `super::process` as they always did.

// The host's reading of the engine's *end*, split out for the reason this module's doc gives about
// `super::environment`: what `process.rs` changes for and what "is the engine still there?" changes
// for are different questions. Re-exported because a failure names it where the launch and the
// pipes are named, rather than through a path of its own.
mod engine_exit;
mod frame;
mod identity;
mod launch;
mod shutdown;
mod stderr;

pub(super) use engine_exit::EngineExit;

/// The roots a profile-isolated launch pins, re-exported so the path every caller already names
/// keeps working after it moved to a module of its own — see [`super::environment`], which carries
/// the record of what it closes, what it leaves open, and how each was measured.
pub use super::environment::isolated_profile_env;

pub use frame::{BoundedFrameReader, FRAME_TOO_LARGE_MARKER, MAX_FRAME_BYTES};
pub use identity::EngineProcess;
pub use launch::{env_pairs, EngineLaunch};
pub use shutdown::{signal_group, SHUTDOWN_GRACE};
pub use stderr::{secrets_of, EngineStderr};

// Two groups below are re-exported although nothing reaches them through this path, because the
// names were reachable here before the split and the paths that name them are not this change's to
// rewrite. `unused_imports` sees neither, for a different reason in each group: the `stderr` names
// are used only by *intra-doc links* — `acp_transport`'s `with_stderr_tail` reads `StderrLog` as the
// only writer of the text a failure shows and `STDERR_EOF_BOUND` as the bound on the wait for it,
// and `engine_exit` argues its own bound by naming it — and the compiler counts callers, not doc
// links; `SYSTEM_CA_BUNDLE` is used by `agent_runtime/mod.rs`'s re-export of it, which is a caller
// the library build sees and a test target that `#[path]`-includes this tree does not. Allowing the
// re-export keeps those paths resolving and leaves the one lint that a path-including target still
// has to report — the same `unused import` it reported before this split — in the file that owned
// it then, rather than moving a pre-existing warning into a new one.
#[allow(unused_imports)]
pub use launch::SYSTEM_CA_BUNDLE;
#[allow(unused_imports)]
pub use stderr::{pump_stderr, StderrLog, STDERR_EOF_BOUND};
