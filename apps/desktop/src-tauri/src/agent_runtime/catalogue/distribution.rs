//! The distribution kinds the schema defines — `binary`, `npx` and `uvx` — and the archive formats
//! it names.
//!
//! This is the half of the schema an entry uses to say how it would be obtained, and the reason
//! `additionalProperties: false` is read here as "keep the unknown kind" rather than "refuse the
//! document": a client that failed the whole catalogue over one entry's new kind would go dark the
//! day the schema grew. It changes when the schema's distribution shape changes — a fourth kind, a
//! changed package object, or a different list of archive suffixes, which is
//! [`archive_suffix_reason`]'s subject and the reason that function sits here rather than beside
//! the document that calls it. What a distribution *means for this host* is [`super::standing`]'s
//! question, and it changes for its own reason.
use std::collections::BTreeMap;

use serde::Deserialize;

// Both names are doc-link targets below and are named by no line of code in this module:
// `Distribution`'s doc pins the binary key set to `Platform::ALL`, and `BinaryTarget`'s names
// `InstallGate::Digest`. A doc link is not a caller, so the compiler counts neither as a use and
// the allow is what keeps the link resolving from the module the item now lives in — the same
// shape `process.rs` uses for its own links.
#[allow(unused_imports)]
use super::install_gate::InstallGate;
#[allow(unused_imports)]
use super::platform::Platform;

/// One agent's distributions (`agent.schema.json`'s `distribution`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Distribution {
    /// Platform-keyed archives. The schema's `propertyNames` pins the keys to the six in
    /// [`Platform::ALL`], so an unrecognised key is a document this build does not fully
    /// understand rather than a target to guess at.
    #[serde(default)]
    pub binary: BTreeMap<String, BinaryTarget>,
    #[serde(default)]
    pub npx: Option<Package>,
    #[serde(default)]
    pub uvx: Option<Package>,
    /// Distribution kinds the schema does not (yet) define.
    ///
    /// Captured rather than refused, and this is a deliberate reading of
    /// `additionalProperties: false`. Strictly, a document with a fourth kind is invalid; a
    /// client that *failed the whole catalogue* over one entry's new distribution would go dark
    /// the day the schema grew, and one that silently ignored it would offer a row with no
    /// distribution and no explanation. Keeping them makes the third option available: the row
    /// says which kinds it did not understand.
    #[serde(flatten)]
    pub other: BTreeMap<String, serde_json::Value>,
}

impl Distribution {
    /// Whether anything at all is published. The schema's `minProperties: 1`.
    pub fn is_empty(&self) -> bool {
        self.binary.is_empty() && self.npx.is_none() && self.uvx.is_none() && self.other.is_empty()
    }
}

/// One platform's archive (`agent.schema.json`'s `binaryTarget`).
#[derive(Debug, Clone, Deserialize)]
pub struct BinaryTarget {
    /// `required`. The schema restricts the suffix to `.zip`, `.tar.gz`, `.tgz`, `.tar.bz2`,
    /// `.tbz2` or a raw binary, and refuses installer formats.
    pub archive: String,
    /// `required`. The command inside the extracted tree.
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// The archive's SHA-256, **optional in the schema** — and this is the field that decides
    /// whether a catalogue can become an installer on its own terms. See [`InstallGate::Digest`].
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// A package-manager distribution (`agent.schema.json`'s `packageDistribution`), shared by `npx`
/// and `uvx` because the schema gives them one shape.
#[derive(Debug, Clone, Deserialize)]
pub struct Package {
    /// The package name, with an optional version. The schema says "with optional version" and
    /// pins nothing further, so `@latest` is a legal value here even though the registry's
    /// submission guide asks contributors not to use it — which means a catalogue may not assume a
    /// version is stated. [`Package::pinned_version`] is the honest read of it.
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

impl Package {
    /// The version the package string pins, when it pins one.
    ///
    /// `@scope/name@1.2.3` pins `1.2.3`; `@scope/name` and `@scope/name@latest` pin nothing. Not a
    /// convenience: a row that says "version 1.2.3" for an unpinned package would be repeating the
    /// *entry's* version as though it were the artifact's, and those are different claims.
    pub fn pinned_version(&self) -> Option<&str> {
        let at = self.package.rfind('@')?;
        // A leading `@` is npm's scope marker, not a version separator.
        if at == 0 {
            return None;
        }
        let version = &self.package[at + 1..];
        if version.is_empty() || version == "latest" {
            return None;
        }
        Some(version)
    }
}

/// The optional preview channel (`agent.schema.json`'s `previewChannel`).
#[derive(Debug, Clone, Deserialize)]
pub struct Preview {
    pub version: String,
    /// Package-based only — the schema's `previewChannel.distribution` has `npx` and `uvx` and no
    /// `binary`. So a preview is never something this host would download itself, which is why
    /// this type reuses [`Package`] and cannot express an archive.
    #[serde(default)]
    pub distribution: PreviewDistribution,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PreviewDistribution {
    #[serde(default)]
    pub npx: Option<Package>,
    #[serde(default)]
    pub uvx: Option<Package>,
}

/// Why an archive URL is not one the schema allows, or `None` when it is.
///
/// The schema names the formats explicitly (`archive`: `.zip`, `.tar.gz`, `.tgz`, `.tar.bz2`,
/// `.tbz2`, or a raw binary) and refuses installer formats (.dmg, .pkg, .deb, .rpm). Worth
/// checking rather than trusting: the two lists are the difference between a file this host could
/// extract and a file it would have to hand to the system package manager, which is a different
/// act with a different trust model.
pub(super) fn archive_suffix_reason(url: &str) -> Option<&'static str> {
    const INSTALLERS: [&str; 4] = [".dmg", ".pkg", ".deb", ".rpm"];
    let lower = url.to_ascii_lowercase();
    if let Some(suffix) = INSTALLERS.iter().find(|suffix| lower.ends_with(**suffix)) {
        // Not a borrow of `suffix`'s text: the reason is a fixed sentence per case, and the
        // matched suffix is already in the URL a row prints.
        let _ = suffix;
        return Some("an installer format, which the schema does not allow as an archive");
    }
    None
}
