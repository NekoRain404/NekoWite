//! Reading `registry.json`: the aggregate's shape, the version gate, the rows, and [`parse`].
//!
//! This is the module's whole input, and bytes already in hand: nothing here has a URL, a socket or
//! a process, which is what makes the schema testable without a network. It changes when the
//! *reading* changes — a document-level gate (the major-version refusal), a row that must be kept
//! with its defects rather than dropped, or what a page can ask a catalogue for
//! ([`Catalogue::row`], [`Catalogue::offerable`]). The shapes it reads belong to
//! [`super::manifest`], [`super::distribution`] and [`super::platform`]; what a kept row says about
//! action belongs to [`super::standing`].
use serde::Deserialize;

use super::distribution::archive_suffix_reason;
use super::manifest::Entry;
use super::platform::Platform;
use super::refusal::{DocumentError, EntryDefect};
use super::standing::Standing;

/// The document that lists the registry's entries, and the version of its own shape
/// (`registry.schema.json`: `required: ["version", "agents"]`).
#[derive(Debug, Clone, Deserialize)]
pub struct CatalogueDocument {
    /// The registry schema's version. Read and kept — a document whose major version this build
    /// does not know is refused rather than parsed on the assumption that the shape held.
    pub version: String,
    pub agents: Vec<Entry>,
}

/// The manifest's own schema version this build understands.
///
/// The registry's `version` is its *schema* version and the schema's pattern is only `^x.y.z`, so
/// the major number is the whole of what can be compared. A document from a newer major describes
/// a shape this build has not read, and guessing would be the one thing a catalogue must not do.
pub const SUPPORTED_REGISTRY_MAJOR: u64 = 1;

/// One entry as a page reads it: the facts, the standing, and the defects that were found.
///
/// Defective entries are *returned* rather than dropped. A catalogue that silently omitted an
/// entry would make a missing engine look like an engine that does not exist, which is the same
/// failure as a button that offers nothing.
#[derive(Debug, Clone)]
pub struct CatalogueRow {
    pub entry: Entry,
    pub standing: Standing,
    pub defects: Vec<EntryDefect>,
}

impl CatalogueRow {
    /// Whether the entry is complete enough to act on.
    ///
    /// Two questions, and both must be yes: the document said everything the schema requires of
    /// the entry, *and* what it published is something this host can actually do something with
    /// ([`Standing::is_actionable`]). An entry that parses perfectly and publishes only an archive
    /// is not actionable here, and a row that counted it as offerable would be the button this
    /// module exists to not draw.
    pub fn is_offerable(&self) -> bool {
        self.defects.is_empty() && self.standing.is_actionable()
    }
}

/// A parsed catalogue: the registry's entries, each with what this host could do about it.
#[derive(Debug, Clone)]
pub struct Catalogue {
    pub version: String,
    pub rows: Vec<CatalogueRow>,
}

impl Catalogue {
    /// The row for `id`, if the registry publishes one.
    pub fn row(&self, id: &str) -> Option<&CatalogueRow> {
        self.rows.iter().find(|row| row.entry.id == id)
    }

    /// How many rows are complete enough to offer, so a page can say what it is showing.
    pub fn offerable(&self) -> usize {
        self.rows.iter().filter(|row| row.is_offerable()).count()
    }
}

/// Read the registry document.
///
/// The whole of this module's input, and bytes already in hand: nothing here has a URL, a socket
/// or a process. Where those bytes come from is [`super::super::super::commands::agent_registry`]'s
/// decision, and keeping it out of this function is what makes the schema testable without a
/// network.
pub fn parse(bytes: &[u8]) -> Result<Catalogue, DocumentError> {
    let document: CatalogueDocument =
        serde_json::from_slice(bytes).map_err(|error| DocumentError::Malformed {
            detail: error.to_string(),
        })?;
    let major = document
        .version
        .split('.')
        .next()
        .and_then(|major| major.parse::<u64>().ok())
        .ok_or_else(|| DocumentError::Version {
            value: document.version.clone(),
        })?;
    if major != SUPPORTED_REGISTRY_MAJOR {
        return Err(DocumentError::UnsupportedVersion {
            value: document.version.clone(),
            supported: SUPPORTED_REGISTRY_MAJOR,
        });
    }
    let rows = document
        .agents
        .into_iter()
        .map(|entry| {
            let mut defects: Vec<EntryDefect> = Vec::new();
            if let Err(defect) = entry.validate() {
                defects.push(defect);
            }
            for (key, target) in &entry.distribution.binary {
                if Platform::parse(key).is_none() {
                    defects.push(EntryDefect::Archive {
                        url: key.clone(),
                        reason: "not one of the six platform targets the schema names",
                    });
                }
                if let Some(reason) = archive_suffix_reason(&target.archive) {
                    defects.push(EntryDefect::Archive {
                        url: target.archive.clone(),
                        reason,
                    });
                }
            }
            let standing = entry.standing();
            CatalogueRow {
                entry,
                standing,
                defects,
            }
        })
        .collect();
    Ok(Catalogue {
        version: document.version,
        rows,
    })
}
