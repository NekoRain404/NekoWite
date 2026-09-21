//! One entry's manifest (`agent.schema.json`), as types and as the rules the schema states about it.
//!
//! What this module owns is the *entry*: its id, the version pattern, the licence URL the schema's
//! `if`/`else` makes mandatory for every entry but one, and the icon, which resolves against the
//! entry's own directory in the registry repository rather than against the CDN. It changes when
//! the published manifest changes — a new field, a widened charset, a different carve-out — and not
//! when the document around it does ([`super::document`]), when an entry's distribution grows a
//! kind ([`super::distribution`]), or when this host's reading of what it can act on changes
//! ([`super::standing`]).
//!
//! The rules live here because they are the schema's, and the *refusal* one produces lives in
//! [`super::refusal`]: the two change for different reasons — one when the schema moves, the other
//! when the sentence a window shows does.
use serde::Deserialize;

use super::distribution::{Distribution, Preview};
use super::refusal::{is_registry_id, is_semver, EntryDefect};

/// One agent's manifest (`agent.schema.json`). A manifest is also published on its own, so this
/// is the same type whether it arrived inside the aggregate or as a single file.
#[derive(Debug, Clone, Deserialize)]
pub struct Entry {
    /// The registry's id. The schema pins it to `^[a-z][a-z0-9-]*$`, which is a strict subset of
    /// this app's `validate_id` charset — so every registry id is usable as a registration id,
    /// and [`Entry::registration_id`] is the one place that mapping is stated.
    pub id: String,
    pub name: String,
    /// Semantic version, `^[0-9]+\.[0-9]+\.[0-9]+$` on the stable channel — no pre-release suffix.
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    /// Author names. Zed's parser has no field for these (`agent_registry_store.rs:641-656`); the
    /// schema has, and a licence or an author is exactly the provenance a user needs in order to
    /// decide whether to trust an engine, so it is kept.
    #[serde(default)]
    pub authors: Vec<String>,
    /// An SPDX identifier or the literal `proprietary` (the schema allows both strings).
    #[serde(default)]
    pub license: Option<String>,
    /// A URL to the licence text or the terms of service.
    ///
    /// Required by the schema for every entry except one (`agent.schema.json:8-16` carries an
    /// `if`/`else` that excludes the single id `dimcode`), so a missing one is reported rather
    /// than treated as an absent optional: for every other entry its absence is a bug in the
    /// document, and the field is what tells a user what they are agreeing to.
    #[serde(default)]
    pub license_url: Option<String>,
    /// Where the icon is. The schema says the build sets this from the entry's own `icon.svg`, and
    /// a relative value resolves against the entry's directory in the registry repository rather
    /// than against the CDN — which is why [`Entry::icon_url`] exists as a function.
    #[serde(default)]
    pub icon: Option<String>,
    pub distribution: Distribution,
    /// The optional preview channel. Package-based only: the schema's `previewChannel` permits
    /// `npx` and `uvx` and no `binary`, so a preview can never be something this host would have
    /// to download itself.
    #[serde(default)]
    pub preview: Option<Preview>,
}

impl Entry {
    /// Whether this entry carries everything the schema requires of it.
    ///
    /// Checked here rather than trusted, because the document is fetched over a network and a
    /// malformed entry must be one row that says so rather than a parse failure for the whole
    /// catalogue. The schema's own rules that serde cannot express: the id charset, the version
    /// pattern, and the licence URL the `if`/`else` makes mandatory.
    pub fn validate(&self) -> Result<(), EntryDefect> {
        if !is_registry_id(&self.id) {
            return Err(EntryDefect::Id {
                value: self.id.clone(),
            });
        }
        if !is_semver(&self.version) {
            return Err(EntryDefect::Version {
                value: self.version.clone(),
            });
        }
        if self.distribution.is_empty() {
            return Err(EntryDefect::NoDistribution);
        }
        // The schema requires a licence URL of every entry but `dimcode`. Refused here for the
        // same reason the schema refuses it: the URL is what a user reads before agreeing to run
        // someone's agent, and an entry that omitted it is not one to offer.
        if self.id != EXEMPT_FROM_LICENSE_URL && self.license_url.is_none() {
            return Err(EntryDefect::NoLicenseUrl);
        }
        Ok(())
    }

    /// The id a registration would carry. Total, and deliberately its own function: the registry's
    /// charset is a subset of this app's, and a reviewer reading `Entry::registration_id` should
    /// find that claim rather than a `.clone()` whose safety has to be re-derived.
    pub fn registration_id(&self) -> &str {
        &self.id
    }

    /// An absolute URL for the entry's icon, when it has one.
    ///
    /// Two cases, and the schema's `icon` field is only ever the second: a value that is already a
    /// URL, and a path relative to the entry's directory in the registry repository. Zed resolves
    /// the relative case against `raw.githubusercontent.com/agentclientprotocol/registry/main/…`
    /// (`agent_registry_store.rs:574-585`) rather than against the CDN, and this is the same
    /// mapping for the same reason: the CDN serves the aggregate, not the per-entry files.
    pub fn icon_url(&self) -> Option<String> {
        let icon = self.icon.as_ref()?;
        if icon.starts_with("https://") || icon.starts_with("http://") {
            return Some(icon.clone());
        }
        Some(format!(
            "{REGISTRY_REPO_RAW}/{}/{relative}",
            self.id,
            relative = icon.trim_start_matches("./")
        ))
    }
}

/// The schema's one carve-out: the `id` for which `license_url` is not required
/// (`agent.schema.json:8-16`).
const EXEMPT_FROM_LICENSE_URL: &str = "dimcode";

/// Where the registry's per-entry files live. The CDN serves the aggregate; the entry's own
/// directory — icons included — is in the repository.
const REGISTRY_REPO_RAW: &str =
    "https://raw.githubusercontent.com/agentclientprotocol/registry/main";
