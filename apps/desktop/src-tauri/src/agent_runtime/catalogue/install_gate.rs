//! §3.3's install checks, and which of them a registry entry can support.
//!
//! This is the module's answer to "why is there no Install button", as a value rather than a
//! paragraph: each arm names what `update.rs`'s own gate does and what a catalogue entry can offer
//! instead. It changes when §3.3 or that gate changes — a check added, a check that stops being
//! runnable against a third-party artifact — and not when an entry's shape does. The arms are a
//! list held against another file's list, which is what [`InstallGate::ALL`], [`InstallGate::as_str`]
//! and their test exist to keep true.
// Both names are doc-link targets below and are used by no line of code in this module: the arms
// compare themselves against `Standing`'s, and one of them argues from `Package::pinned_version`.
#[allow(unused_imports)]
use super::distribution::Package;
#[allow(unused_imports)]
use super::standing::Standing;

/// The checks §3.3 requires of a download, and which of them a registry entry can support.
///
/// This is the module's answer to "why is there no Install button", as a value rather than a
/// paragraph. `update.rs`'s gate (`Check::ALL`, `update.rs:198-204`) is the shape being compared
/// against, and each arm below names what that gate does and what a catalogue entry can offer
/// instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallGate {
    /// **The digest. Does not transfer, and this is the one that decides it.**
    ///
    /// §3.3's rule is that a response must not supply both halves of its own proof (the rule
    /// `update.rs`'s module doc states and `verify`'s own doc repeats): the digest that counts is
    /// the one in the app's own [`super::super::update::PinnedRelease`], which ships inside the
    /// binary (`update/manifest.rs`). A registry entry's `sha256` arrives in the same document as
    /// its `archive` URL — one fetch, one origin, both halves — so checking it proves the download
    /// is self-consistent and nothing more. It is the same status as `ArtifactClaims`, which
    /// `update.rs` records and never reads.
    /// Worse, the field is `Option` in the schema: an entry may publish no digest at all, and a
    /// gate that cannot run is not a gate that passed.
    Digest,
    /// **The architecture. Transfers.**
    ///
    /// `update.rs:347-354` reads a 64-byte ELF header out of the candidate file itself, which is
    /// self-contained and so works for any URL. For a registry entry the check changes meaning
    /// slightly and stays necessary: the platform key is the publisher's claim, so the header is
    /// what confirms the artifact matches the key it was filed under.
    Architecture,
    /// **The execute permission. Transfers unchanged.**
    ///
    /// `update.rs:356-377` refuses a staged file that already carries a bit and applies `0o755`
    /// only after the checks that can be made without one. A downloaded archive is the same
    /// situation, and the rule §3.2 states (未验证文件不得执行) is the same rule.
    ExecuteBit,
    /// **The version. Transfers in part.**
    ///
    /// `update.rs:379-394` compares what the candidate prints against the version its
    /// `PinnedRelease` names. For a registry entry the version compared against is the
    /// *publisher's* string in the document, so the check confirms the artifact matches its own
    /// listing rather than that either is what this app intended. For a package distribution it
    /// may not be runnable at all: the schema permits an unpinned `package`
    /// ([`Package::pinned_version`] answers `None`), and nothing in the schema says an engine
    /// answers `--version` with its entry's version.
    Version,
    /// **ACP initialisation. Transfers, and it is the only check that measures a capability.**
    ///
    /// `verify` (`update/verify.rs`) performs this host's handshake against the candidate, which is
    /// what `update`'s own [`super::super::update::Handshake`] (`update/claims.rs`) carries. For a
    /// catalogue entry this is the check that turns a listing into a measured engine — and it is
    /// per (agent, version), so it cannot be run once for the registry and reused: two entries are
    /// two programs, and a version change is a new thing to ask.
    AcpInitialization,
    /// **The contract tests. Do not transfer.**
    ///
    /// §3.3's last check pins a release by running this host's own suite against it. That is
    /// possible for the one engine this app bundles and not for a registry of third-party
    /// engines: there is no suite that a `uvx` invocation of someone else's agent is expected to
    /// pass, and inventing one would make this app the arbiter of a protocol it does not own.
    ContractTests,
}

impl InstallGate {
    pub const ALL: [InstallGate; 6] = [
        InstallGate::Digest,
        InstallGate::Architecture,
        InstallGate::ExecuteBit,
        InstallGate::Version,
        InstallGate::AcpInitialization,
        InstallGate::ContractTests,
    ];

    /// Whether this check can run for an entry that came from the registry.
    ///
    /// `false` is not a gap in this build's work: it is the reason the archive arm of
    /// [`Standing`] offers no action. Anything other than `true` here is a check that would have to
    /// be replaced by a *decision* — pinning a digest in-app, or shipping a suite — and neither is
    /// a catalogue's to make.
    pub fn transfers(self) -> bool {
        match self {
            // Both halves of the proof come from one fetch; and the field is optional besides.
            InstallGate::Digest => false,
            InstallGate::Architecture
            | InstallGate::ExecuteBit
            | InstallGate::AcpInitialization => true,
            // Only in part: runnable for a binary whose `--version` follows the convention, not
            // runnable at all for an unpinned package.
            InstallGate::Version => false,
            // Nothing a third-party registry entry could be held to.
            InstallGate::ContractTests => false,
        }
    }

    /// The wire spelling, for the reason `HostFeature::as_str` gives: one vocabulary for one value.
    pub fn as_str(self) -> &'static str {
        match self {
            InstallGate::Digest => "digest",
            InstallGate::Architecture => "architecture",
            InstallGate::ExecuteBit => "execute-permission",
            InstallGate::Version => "version",
            InstallGate::AcpInitialization => "acp-initialization",
            InstallGate::ContractTests => "contract-tests",
        }
    }
}
