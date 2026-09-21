//! What this build refuses — one entry, or a whole document — and the sentence a window shows.
//!
//! The two vocabularies sit in one module because they are one subject: the words printed when
//! something will not be offered. [`EntryDefect`] is per row and is *returned* rather than raised,
//! so a malformed entry is one row that says what is wrong instead of a catalogue that failed to
//! load — [`super::document`]'s `parse` is the caller; [`DocumentError`] is the whole document. The
//! schema's own patterns, [`is_registry_id`] and [`is_semver`], are here because they are what
//! those refusals are decided by and they change with them: a widened charset is a new answer to
//! "is this an id", not a new field on [`super::manifest::Entry`].
use std::fmt;

/// Why an entry cannot be offered, or why a whole document cannot be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryDefect {
    /// The id does not match the schema's `^[a-z][a-z0-9-]*$`.
    Id { value: String },
    /// The version is not `x.y.z`.
    Version { value: String },
    /// `distribution` had no properties, which the schema forbids (`minProperties: 1`).
    NoDistribution,
    /// No `license_url` on an entry the schema does not exempt.
    NoLicenseUrl,
    /// An archive URL the schema's `format: uri` would reject, or an archive suffix the schema
    /// names as unsupported (`.dmg`, `.pkg`, `.deb`, `.rpm` are installers, not archives).
    Archive { url: String, reason: &'static str },
}

impl fmt::Display for EntryDefect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EntryDefect::Id { value } => write!(f, "`{value}` is not a usable registry id"),
            EntryDefect::Version { value } => write!(f, "`{value}` is not a semantic version"),
            EntryDefect::NoDistribution => write!(f, "the entry publishes no distribution"),
            EntryDefect::NoLicenseUrl => write!(f, "the entry publishes no licence URL"),
            EntryDefect::Archive { url, reason } => write!(f, "{url}: {reason}"),
        }
    }
}

/// The registry id charset, `agent.schema.json`'s `^[a-z][a-z0-9-]*$`.
pub(super) fn is_registry_id(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `agent.schema.json`'s `^[0-9]+\.[0-9]+\.[0-9]+$` — the stable channel's version, with no
/// pre-release suffix. The preview channel's pattern is a separate one and is not this.
pub(super) fn is_semver(value: &str) -> bool {
    let mut parts = value.split('.');
    let (Some(major), Some(minor), Some(patch), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    [major, minor, patch]
        .into_iter()
        .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

/// Why a whole document was refused, as opposed to one entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentError {
    /// The bytes are not the JSON this schema describes.
    Malformed { detail: String },
    /// `version` does not parse as `x.y.z`, so the schema's own pattern did not hold.
    Version { value: String },
    /// A major version this build has not read. Refused rather than parsed on the assumption that
    /// the shape held — the one thing a catalogue must not guess at.
    UnsupportedVersion { value: String, supported: u64 },
}

impl fmt::Display for DocumentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DocumentError::Malformed { detail } => {
                write!(f, "the registry is not readable: {detail}")
            }
            DocumentError::Version { value } => {
                write!(f, "`{value}` is not a registry schema version")
            }
            DocumentError::UnsupportedVersion { value, supported } => write!(
                f,
                "this build reads registry schema {supported}.x, and the document is {value}"
            ),
        }
    }
}
