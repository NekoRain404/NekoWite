//! One of `update.rs`'s children: the releases this build will install.
//!
//! Split out of `update.rs` when it passed §13.1's 600-line default (docs/dev.md §5.4.2: 超过 600
//! 行应默认进入拆分 backlog). The seam is "changes when a release is pinned" — nothing else in the
//! update path moves when this file does, and nothing here changes when a claim, a proof or a
//! rollback changes.

use super::super::binary_registry;
use std::sync::OnceLock;
use std::time::Duration;

/// How long a candidate gets to answer `--version`.
///
/// Shorter than the handshake's bound on purpose: printing a version is not a negotiation, and a
/// program that cannot do it promptly is a program this host should not be waiting on. The decision
/// to make it a *bound* rather than a wait is §6.2's (a timeout is what keeps a hang from becoming
/// the app's hang), applied here to the one process this module starts on its own.
pub const VERSION_BOUND: Duration = Duration::from_secs(10);

/// One release this app is willing to install, and the facts that make it checkable.
///
/// The fields are the supply-chain record §3.3 asks for: which version, for which target, from
/// which source, under which licence, and the digest that ties all of it to a file. Records come
/// from [`shipped`] in production; a record is never built from a network response, which is what
/// `Artifact::claims` being a separate type is for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedRelease {
    // `pub(crate)` rather than private: the fields are read directly by `verify.rs`, which was
    // inside this file until the split and is the only reader that ever has been. The accessors
    // below remain the path for everything outside the tree.
    pub(crate) version: String,
    pub(crate) target: String,
    pub(crate) sha256: String,
    /// Where the artifact came from, and through which channel — the provenance that makes a
    /// digest worth checking. §5.6 of the architecture record is why this is one channel and not
    /// two: the registry's entry for a version and this app's artifact are not guaranteed to be
    /// byte-identical, so only the channel this app actually downloads through may be recorded.
    pub(crate) source: String,
    pub(crate) licence: String,
    /// The invocation that puts this release into ACP mode. Part of the record rather than of the
    /// probe, so the update path never has to know an engine's name to check one.
    pub(crate) acp_args: Vec<String>,
}

impl PinnedRelease {
    /// Builds a record. Called by the shipped manifest below, and by tests that need bytes they
    /// control; never from anything a download said.
    pub fn new(
        version: &str,
        target: &str,
        sha256: &str,
        source: &str,
        licence: &str,
        acp_args: Vec<String>,
    ) -> Self {
        Self {
            version: version.to_string(),
            target: target.to_string(),
            sha256: sha256.to_string(),
            source: source.to_string(),
            licence: licence.to_string(),
            acp_args,
        }
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    pub fn target(&self) -> &str {
        &self.target
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn licence(&self) -> &str {
        &self.licence
    }

    pub fn acp_args(&self) -> Vec<String> {
        self.acp_args.clone()
    }
}

/// The releases this build will install, compiled in.
///
/// This is the trusted half of §3.3's rule. The digest lives here and not in a file the app reads
/// at run time, because a file beside the download is one more thing an attacker who can reach the
/// download can reach; the record travels with the binary that checks it.
fn manifest() -> &'static [PinnedRelease] {
    static MANIFEST: OnceLock<Vec<PinnedRelease>> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        vec![PinnedRelease::new(
            "1.18.29",
            binary_registry::supported_target(),
            // sha256 of the *program*, which is what the gate hashes; the tarball it was extracted
            // from is pinned by `scripts/fetch-opencode-linux.sh` with npm's own sha512 integrity
            // for `opencode-linux-x64@1.18.29`, and `scripts/verify-opencode-linux.sh` holds the two
            // records against each other on every packaged release.
            "ca6c0e1f42be3120595bf6848937e7586ec862c87fa7aa111e89c7cc6e9a4650",
            "npm opencode-linux-x64@1.18.29 (registry integrity sha512 verified on fetch)",
            "MIT",
            vec!["acp".to_string()],
        )]
    })
}

/// The record for `version`, if this build installs it.
pub fn shipped(version: &str) -> Option<&'static PinnedRelease> {
    manifest().iter().find(|release| release.version == version)
}

/// Every version this build installs, so a settings page can say what it will accept.
pub fn shipped_versions() -> Vec<&'static str> {
    manifest()
        .iter()
        .map(|release| release.version.as_str())
        .collect()
}
