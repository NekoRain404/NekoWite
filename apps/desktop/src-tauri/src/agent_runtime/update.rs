//! The update path: what a candidate must prove before the active pointer moves, and what a
//! rollback must not discard.
//!
//! §3.3 is a list of failures rather than features, and each one is a rule here:
//!
//! - **A digest that arrived with the artifact proves nothing.** [`Artifact::claims`] carries what
//!   the download response said about itself, and no decision in this module reads it. The only
//!   digest that counts is the one in the app's own [`PinnedRelease`] record, which ships inside
//!   the binary — so a response cannot supply both halves of its own proof.
//! - **A download is not executable until it has passed.** [`verify`] runs the checks in one order,
//!   and the order is the rule: the digest and the architecture are read before the file is given
//!   an execute bit, and the bit is given before anything runs it. `downloads/` holds bytes
//!   (未验证文件不得执行); only [`promote`] makes one of them the version this app starts.
//! - **No hot-swap while a session is live.** [`promote`] asks [`SessionActivity`] before it moves
//!   the pointer, so the question is asked rather than assumed, and this module never reaches into
//!   the agent registry to answer it.
//! - **A migrated profile cannot be rolled back by moving a binary.** [`rollback`] refuses that
//!   outright (若新版本已迁移数据库，不得仅回退二进制), and when a restore is confirmed it retains the
//!   newer data first, refuses to touch the profile if the backup is unusable, and reports what it
//!   could not reconcile. A profile no version record covers is refused the same way
//!   ([`UpdateError::UnrecordedState`]) rather than assumed to be safe: the refusal fails closed.
//!
//! What this module deliberately does not own: profiles (T12), agent definitions (T3a), and the
//! question of which of their releases a network should be asked about.

// Bare `mod name;`, which is what finds `update/<name>.rs` beside this file — the root keeps its
// own name rather than becoming `update/mod.rs`, so every caller that names `update` still resolves
// through it. Deliberately *not* `#[path = "update/<name>.rs"]`: `module_tree_test.rs` replays this
// walk with a comment stripper that removes string literals along with comments, so a path
// attribute is invisible to it and its five children read as orphans. `skills.rs` writes
// `#[path]` because a test target `#[path]`-includes `skills.rs` directly; nothing does that to
// `update.rs` — it reaches the tree only through `agent_runtime/mod.rs`'s `pub mod update;` — so
// the plain declaration is both sufficient and what the tree check can see.
mod claims;
mod error;
mod manifest;
mod rollback;
mod verify;

// The re-exports below are what keeps every path that resolved before this split resolving after it:
// `agent_runtime::update::X` is spelled exactly as it was, and the callers
// (`catalogue/install_gate.rs`, `commands/agent_runtime.rs`, `state/app_state.rs`, the
// `tests/agent_update_test*` targets) are not this change's to rewrite.
//
// `manifest` itself is deliberately not re-exported: it stayed private to the module before the
// split, and re-exporting it here would widen a private lookup into the crate's public surface.
// A caller reaches the records through `shipped` and `shipped_versions`, as it did before.

pub use manifest::{shipped, shipped_versions, PinnedRelease, VERSION_BOUND};

pub use claims::{Artifact, ArtifactClaims, Check, Handshake, Verified};

pub use error::UpdateError;

pub use verify::{verify, AcpProbe, CandidateProbe};

pub use rollback::{
    may_replace, promote, rollback, ProfileState, RollbackReport, RollbackRequest, SessionActivity,
};
