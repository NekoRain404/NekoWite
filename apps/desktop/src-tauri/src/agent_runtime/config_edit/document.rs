//! Reading a document, and the questions a caller may ask of one.
//!
//! It changes when the document model changes — what a document remembers about where it came from,
//! and which questions it is allowed to answer. It never formats text, never writes, and answers
//! every question from the bytes it was read from rather than from a re-serialized copy.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::error::ConfigError;
use super::scanner::scan;
use super::write::Revision;

// `WriteOutcome` is named by `ConfigDocument::text`'s doc comment and by nothing else here — the
// hand-written `Debug` that paragraph defends — and the compiler counts callers, not doc links, so
// the import would otherwise be reported as unused. The allowance keeps the link resolving without
// turning a pre-existing absence of that warning into a new one.
#[allow(unused_imports)]
use super::write::WriteOutcome;

/// A document as it was read: the bytes, where they came from, and the revision they hash to.
///
/// The fields are `pub(super)` and not private, which is the scope they had when this type and
/// `apply_claim` were one file: the claim compares `revision` and takes `text` as the text it edits,
/// so the parent that applies an edit reads both. No wider than that — nothing outside `config_edit`
/// may hold a document's text, which is the whole point of [`ConfigDocument::text`] being the only
/// reader's door.
pub struct ConfigDocument {
    pub(super) path: PathBuf,
    pub(super) text: String,
    pub(super) revision: Revision,
}

impl ConfigDocument {
    /// Only expose scalar permission actions; complex values remain opaque to the simple editor.
    pub fn permission_rules(&self) -> Result<Value, ConfigError> {
        let root = scan(&self.text, &self.path)?;
        let Some(object) = root.object.as_ref() else {
            return Ok(serde_json::json!({ "kind": "complex" }));
        };
        let entries: Vec<_> = object
            .entries
            .iter()
            .filter(|entry| entry.key == "permission")
            .collect();
        if entries.is_empty() {
            return Ok(serde_json::json!({ "kind": "absent" }));
        }
        // Duplicate members have ambiguous engine precedence and cannot be safely edited here.
        if entries.len() != 1 {
            return Ok(serde_json::json!({ "kind": "complex" }));
        }
        let Some(rules) = entries[0].value.object.as_ref() else {
            return Ok(serde_json::json!({ "kind": "complex" }));
        };
        let mut result = serde_json::Map::new();
        for entry in &rules.entries {
            if result.contains_key(&entry.key) {
                return Ok(serde_json::json!({ "kind": "complex" }));
            }
            let action =
                serde_json::from_str::<String>(&self.text[entry.value.start..entry.value.end]).ok();
            let value = match action.as_deref() {
                Some("ask" | "allow" | "deny") => Value::String(action.unwrap()),
                _ => Value::Null,
            };
            result.insert(entry.key.clone(), value);
        }
        Ok(serde_json::json!({ "kind": "object", "rules": result }))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn revision(&self) -> &Revision {
        &self.revision
    }

    /// The document as written, for the structured editor — the only caller that may hold it.
    ///
    /// It can contain a credential (a provider block holds a key as often as a host), so this text
    /// is the editor's and nothing else's: not a log line, not a diagnostic, not an error message.
    /// Nothing in this module prints it — [`WriteOutcome`]'s `Debug` is hand-written for that
    /// reason — and the only answer that carries it is the one a settings page renders.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// Whether this document already has a member named `name` at its root.
    ///
    /// The question `apply` cannot answer, and the one a *default* needs: a value this host ships
    /// may only be written where the document has not spoken, and a caller that cannot tell "the
    /// member is absent" from "the member is there and says something else" cannot tell a first run
    /// from a user who made their own choice. Deliberately a `bool` and not a value: this document
    /// can hold a credential, and a query whose answer is a value would be a second way for that
    /// text to leave the module.
    ///
    /// A document whose root is not an object has no members, which is the honest answer and not a
    /// failure — nothing in this module writes such a document, and refusing here would make a file
    /// the host does not own a reason for a settings page to stop working.
    pub fn has_member(&self, name: &str) -> Result<bool, ConfigError> {
        let root = scan(&self.text, &self.path)?;
        Ok(root
            .object
            .as_ref()
            .is_some_and(|object| object.entries.iter().any(|entry| entry.key == name)))
    }

    /// Whether the member `name` is, byte for byte, `value` as this host serializes it.
    ///
    /// The question "is the thing in this document the thing I would write?" — which is what an
    /// idempotent default and a settings readout both need, and which [`has_member`] cannot answer:
    /// a member that is *there* and one that is *mine* are different facts, and the difference is
    /// the whole of whether a host may leave it alone.
    ///
    /// A comparison rather than a reader, deliberately. The text of a value is exactly what
    /// [`ConfigDocument::text`] exists to keep out of every other channel, and a method that handed
    /// back a member's span would be a second way for a credential to leave this module — so this
    /// one answers with a `bool` and the caller never sees the bytes it compared.
    ///
    /// Whitespace is part of the comparison and that is the safe direction: a member a user
    /// reformatted by hand compares unequal, and the caller's conservatism is to treat it as
    /// theirs rather than as its own.
    ///
    /// [`has_member`]: ConfigDocument::has_member
    pub fn member_is(&self, name: &str, value: &Value) -> Result<bool, ConfigError> {
        let root = scan(&self.text, &self.path)?;
        let found = root
            .object
            .as_ref()
            .and_then(|object| object.entries.iter().find(|entry| entry.key == name));
        Ok(found.is_some_and(|entry| {
            self.text[entry.value.start..entry.value.end] == value.to_string()
        }))
    }
}

/// Reads a document, or reports that there is none.
///
/// A missing file is `Ok(None)` and not an error: a profile whose engine has never been configured
/// has no document yet, and that is the state §3.1's first-run flow starts from.
pub fn read(path: &Path) -> Result<Option<ConfigDocument>, ConfigError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(ConfigError::Io {
                path: path.to_path_buf(),
                message: error.to_string(),
            })
        }
    };
    let text = String::from_utf8(bytes).map_err(|_| ConfigError::Io {
        path: path.to_path_buf(),
        message: "the file is not UTF-8".to_string(),
    })?;
    Ok(Some(ConfigDocument {
        path: path.to_path_buf(),
        revision: Revision::of(&text),
        text,
    }))
}
