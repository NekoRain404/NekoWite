//! One of `update.rs`'s children: what a candidate says about itself, and what the gate accepts.
//!
//! Split out of `update.rs` when it passed §13.1's 600-line default. The seam is "changes when the
//! claims vocabulary changes" — the names a download response and a verification result are written
//! in. The proof that consumes them is `verify.rs`; the refusals they feed are `error.rs`.

use std::path::PathBuf;

/// What the engine answers in the handshake — the part of the ACP initialization this host can
/// judge without a model, a credential or a network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handshake {
    pub agent_name: String,
    pub agent_version: String,
    pub protocol_version: u16,
}

/// What a download claimed about itself.
///
/// Recorded, never consulted. A response that carries its own digest proves only that the response
/// is self-consistent (§3.3: 不能从同一不可信响应同时获取二进制和摘要便声称可信), so this type exists to
/// keep the claim visible — in the refusal a user reads, and in the report of a promotion — while
/// every decision in this module goes through [`PinnedRelease`] instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactClaims {
    pub digest: Option<String>,
    pub version: Option<String>,
}

/// A downloaded candidate, staged in the download area and not yet verified.
#[derive(Debug, Clone)]
pub struct Artifact {
    pub path: PathBuf,
    pub claims: Option<ArtifactClaims>,
}

/// One step of the gate, in the order it runs.
///
/// The order is the content: a digest checked after the candidate has run is worth nothing, so the
/// sequence is a value rather than a comment, and [`Verified::checks`] carries it to the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Check {
    /// The bytes match the digest in the app's own record.
    Digest,
    /// The file is a 64-bit little-endian ELF for this release's architecture.
    Architecture,
    /// The candidate carries no execute bit before this check, and one after it.
    ExecuteBit,
    /// `--version` answers with the version the record names.
    Version,
    /// The candidate completes this host's ACP handshake.
    AcpInitialization,
}

impl Check {
    pub const ALL: [Check; 5] = [
        Check::Digest,
        Check::Architecture,
        Check::ExecuteBit,
        Check::Version,
        Check::AcpInitialization,
    ];

    /// A short name for a refusal or a log line; the user-facing wording is the frontend's.
    pub fn as_str(self) -> &'static str {
        match self {
            Check::Digest => "digest",
            Check::Architecture => "architecture",
            Check::ExecuteBit => "execute-permission",
            Check::Version => "version",
            Check::AcpInitialization => "acp-initialization",
        }
    }
}

/// A candidate that passed every check.
///
/// The only thing [`promote`] accepts, and the reason the order in [`Check`] cannot be skipped: the
/// value is produced at the end of the gate, so a caller that wants the pointer moved has to have
/// run all of it.
#[derive(Debug, Clone)]
pub struct Verified {
    /// The staged file, still in the download area, now executable.
    pub program: PathBuf,
    pub version: String,
    pub target: String,
    pub digest: String,
    /// What the candidate said about itself when asked. Kept beside the record's version so a
    /// mismatch can be read rather than inferred.
    pub reported_version: String,
    pub handshake: Handshake,
    pub checks: Vec<Check>,
    /// What the download claimed. Diagnostics only — see [`ArtifactClaims`].
    pub claims: Option<ArtifactClaims>,
}
