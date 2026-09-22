//! Configuration document reads and revision-checked edits behind the settings IPC surface.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::agent_runtime::config_edit::{self, ConfigEdit, Revision};
use crate::agent_runtime::profile::{ProfileError, ProfileStore};

use super::{open, refusal_message, refused_revision};

/// One member a settings form changed, as the editor submits it: a path and a value, never a
/// document. A request that carried the whole file is not something this surface can express.
///
/// `ifAbsent` is the one thing a submission may say about *an existing member*, and it says nothing
/// about the value: it is [`ConfigEdit::if_absent`]'s arm, which adds a member where the document
/// has not spoken and leaves the document byte for byte where it has. It is what lets a form that
/// writes inside a group — a provider block lives inside `provider` — put the group there without
/// replacing the ones a user already has. Defaulted, because a request that omits it means the
/// plain `set` it has always meant.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSubmission {
    pub path: Vec<String>,
    pub value: Value,
    #[serde(default)]
    pub if_absent: bool,
}

/// The configuration document the editor opens.
///
/// `exists: false` is a normal answer, not a failure: a profile whose engine has never been
/// configured has no document yet, and the page answers it with a form whose first save creates the
/// file — the revision it submits for that is `null`, which is the claim [`submit_document`] takes
/// as "there was no document". Nothing is invented by it: the members are the ones the form named,
/// and a member whose parent chain the document does not have is still refused (§3.4.5).
pub fn read_document(
    store: &ProfileStore,
    agent_id: &str,
    profile_id: &str,
    relative: &str,
) -> Result<Value, String> {
    let profile = open(store, agent_id, profile_id)?;
    let path = profile
        .document_path(relative)
        .map_err(|error| refusal_message(&error))?;
    let document = config_edit::read(&path).map_err(|error| refusal_message(&error.into()))?;
    Ok(json!({
        "path": path.to_string_lossy(),
        "exists": document.is_some(),
        "revision": document.as_ref().map(|document| document.revision().as_str()),
        // The raw text, and the one answer that carries it: this is the editor's document, and the
        // page shows it to the user it belongs to. Nothing else in this file returns text.
        "text": document.as_ref().map(|document| document.text()),
        "editable": profile.mode().host_writes(),
        "permissionRules": document.as_ref().map(|document| document.permission_rules().unwrap_or_else(|_| json!({"kind": "unreadable"}))).unwrap_or_else(|| json!({"kind": "absent"})),
    }))
}

/// Applies the editor's edits at the revision it read, or reports the conflict with the document
/// that is there instead — the caller reloads and rebuilds its edits from that, because merging is
/// how a change made elsewhere gets undone.
///
/// `revision` is the token the read answered with, and `None` is the one it answers for a document
/// that is not there. It is the same value the page read (`revision: null`), so the round trip has
/// one spelling rather than two: a create is claimed by *reading no document* and submitting
/// nothing in its place, and a create that loses its race comes back as the same conflict a moved
/// revision does.
pub fn submit_document(
    store: &ProfileStore,
    agent_id: &str,
    profile_id: &str,
    relative: &str,
    revision: Option<&str>,
    edits: &[EditSubmission],
) -> Result<Value, String> {
    let expected = revision
        .map(|revision| Revision::parse(revision).ok_or_else(|| refused_revision(revision)))
        .transpose()?;
    let profile = open(store, agent_id, profile_id)?;
    if !profile.mode().host_writes() {
        return Err(refusal_message(&ProfileError::ReadOnly));
    }
    let path = profile
        .document_path(relative)
        .map_err(|error| refusal_message(&error))?;
    // Which of the two arms a submitted edit is, decided by the flag and by nothing else — the
    // values are the caller's either way, and the difference is what may happen to a member the
    // document already has.
    let edits = edits
        .iter()
        .map(|edit| {
            let path = edit.path.clone();
            let value = edit.value.clone();
            if edit.if_absent {
                ConfigEdit::if_absent(path, value)
            } else {
                ConfigEdit::set(path, value)
            }
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| refusal_message(&error.into()))?;
    let outcome = config_edit::apply_claim(&path, expected.as_ref(), &edits)
        .map_err(|error| refusal_message(&error.into()))?;
    match outcome {
        config_edit::WriteOutcome::Written { revision } => Ok(json!({
            "status": "written",
            "revision": revision.as_str(),
        })),
        config_edit::WriteOutcome::Conflicted { current } => Ok(json!({
            "status": "conflict",
            "current": current.as_ref().map(|document| json!({
                "revision": document.revision().as_str(),
                "text": document.text(),
            })),
        })),
    }
}

/// The document layer's refusals, in a form the form can act on.
pub(super) fn document_message(error: &config_edit::ConfigError) -> String {
    match error {
        config_edit::ConfigError::Io { path, message } => {
            format!("{} could not be read or written: {message}", path.display())
        }
        config_edit::ConfigError::Syntax {
            path,
            offset,
            message,
        } => format!(
            "{} is not JSONC this app can edit: {message} (at byte {offset}). It was left \
             unchanged",
            path.display()
        ),
        config_edit::ConfigError::Missing { path } => format!(
            "this configuration has no `{}` to change; the settings page does not create members \
             an engine has not written",
            path.join(".")
        ),
        config_edit::ConfigError::NotAnObject { path } => format!(
            "`{}` is not a group of settings in this file",
            path.join(".")
        ),
        config_edit::ConfigError::BlankPath => "a setting has to be named".to_string(),
    }
}
