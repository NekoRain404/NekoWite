//! The profile's record: the document `profile.json` holds, the fields a settings page may set, and
//! the rule that refuses a write built on a revision that has moved.
//!
//! **Why it is a file of its own.** `docs/dev.md:286` puts the budget for a business source file at
//! 600 lines, and [`super`] was 1027. The split is by *reason to change*, which is the criterion
//! that section states rather than the line count: this module moves when the *record document*
//! moves — a member `profile.json` gains or loses, the spelling of one, the fields a form may
//! submit, or the conflict rule a write obeys — while [`super`] moves when the store's directory
//! walk or the readout's shape does. Reading the record belongs to the store ([`super`]) because
//! opening a profile is also *binding* it to an engine (§3.4); writing it belongs here because that
//! is the one thing a settings page asks for.
//!
//! **`agent_id` is not a field here, on purpose.** A profile's engine is decided when the profile is
//! created and is not an editable member, so no write path exists that could rebind one to another
//! engine — §3.4's Profile row as a property of the types rather than a check somebody remembers.
//! [`ProfileFields`] is the shape that makes that true, and this is where it is defined.
//!
//! Every name a caller reached as `profile::X` before the split still resolves — [`super`]
//! re-exports it — and the methods stay inherent methods on [`Profile`].

use serde::Deserialize;
use serde_json::{json, Value};

use std::path::Path;

use super::super::config_edit::{self, ConfigDocument, ConfigEdit, Revision, WriteOutcome};
use super::layout::RECORD_FILE;
use super::scope::ConfigMode;
use super::{Profile, ProfileError, ProfileReadout, ProfileStore};

/// The record as it is stored. Every field is optional because a record written by an older build
/// may not have them, and a missing field is a value to default rather than a document to refuse.
///
/// `pub(super)` on the fields, not private: the walk that reads a binding for every profile is
/// [`ProfileStore::bindings`], which lives in the parent module — and a private field would be
/// invisible to the module that owns this one's *ancestor*, not just to callers.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredRecord {
    pub(super) agent_id: Option<String>,
    pub(super) mode: Option<String>,
    pub(super) provider: Option<String>,
    pub(super) model_id: Option<String>,
}

/// What a profile is set to: the three things a settings page may change.
///
/// There is no `agent_id` here on purpose. A profile's engine is decided when the profile is
/// created and is not an editable field, so no write path exists that could rebind one to another
/// engine — §3.4's Profile row as a property of the types rather than a check somebody remembers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileFields {
    pub mode: ConfigMode,
    pub provider: Option<String>,
    pub model_id: Option<String>,
}

impl ProfileFields {
    /// The fields a fresh profile starts with: the app's own mode, nothing chosen yet.
    pub fn initial() -> Self {
        Self {
            mode: ConfigMode::AppManaged,
            provider: None,
            model_id: None,
        }
    }

    /// Refuses a field that no diagnostic and no environment variable could carry: a control
    /// character would break a log line, and a blank provider is a form the user has not finished.
    fn validate(&self) -> Result<(), ProfileError> {
        for (field, value) in [("provider", &self.provider), ("model_id", &self.model_id)] {
            if let Some(value) = value {
                if value.trim().is_empty() || value.chars().any(char::is_control) {
                    return Err(ProfileError::Field { field });
                }
            }
        }
        Ok(())
    }
}

/// What a record write did. The same two arms as a document write, because it is the same rule.
#[derive(Debug)]
pub enum RecordUpdate {
    Written {
        revision: Revision,
    },
    /// Someone else's write landed first. `current` is the readout to reload from, and the caller
    /// re-applies its change to *that* — nothing is merged here.
    Conflicted {
        current: ProfileReadout,
    },
}

impl Profile {
    /// The record's revision, as the token a write must be built on.
    pub fn revision(&self) -> &Revision {
        self.document.revision()
    }

    /// Writes the record, or refuses because the record moved.
    ///
    /// `expected` is the caller's own token — the revision a settings page read and submitted, not
    /// the revision this object was opened with — so two writers on one profile cannot both apply:
    /// the second is told the record is not the one it read. `agentId` is deliberately not among the
    /// members written, so no write path exists that could rebind a profile to another engine.
    pub fn set_fields(
        &self,
        expected: &Revision,
        fields: ProfileFields,
    ) -> Result<RecordUpdate, ProfileError> {
        fields.validate()?;
        let text = |value: Option<&String>| match value {
            Some(value) => json!(value),
            None => Value::Null,
        };
        let edits = vec![
            ConfigEdit::set(vec!["mode".to_string()], json!(fields.mode.id()))?,
            ConfigEdit::set(vec!["provider".to_string()], text(fields.provider.as_ref()))?,
            ConfigEdit::set(vec!["modelId".to_string()], text(fields.model_id.as_ref()))?,
        ];
        match config_edit::apply(self.document.path(), expected, &edits)? {
            WriteOutcome::Written { revision } => Ok(RecordUpdate::Written { revision }),
            // Reloaded rather than merged: the caller re-applies its change to what is there now,
            // which is the rule `memory-pet/settings.ts` states and the only one that cannot undo a
            // value the user set on another page.
            WriteOutcome::Conflicted { .. } => {
                let current = ProfileStore::new(self.managed.clone())
                    .open(&self.agent_id, &self.profile_id)?
                    .readout();
                Ok(RecordUpdate::Conflicted { current })
            }
        }
    }
}

/// Writes the record a profile is created with: the engine it belongs to, and defaults for the rest.
pub(super) fn create_record(root: &Path, agent_id: &str) -> Result<ConfigDocument, ProfileError> {
    let fields = ProfileFields::initial();
    let record = json!({
        "agentId": agent_id,
        "mode": fields.mode.id(),
        "provider": Value::Null,
        "modelId": Value::Null,
    });
    let path = root.join(RECORD_FILE);
    config_edit::write_replacing(&path, &record.to_string())?;
    config_edit::read(&path)?.ok_or_else(|| ProfileError::Unreadable {
        path: path.clone(),
        message: "the record was written and is not there".to_string(),
    })
}
