//! The configuration IPC surface: the profile the settings page manages, and the documents it edits.
//!
//! §6.1 draws this file's boundary as "validates and delegates". The profile, the record, the
//! revision rule and the JSONC splicing all live in `agent_runtime::{profile, config_edit}`; what
//! belongs *here* is the other half of §6.1's rule — **the renderer is not a trusted source of
//! identity, of a revision or of a mode**. Every id a request carries is checked against what the
//! backend recorded when the profile was created, a revision that is not the shape this host issues
//! is refused before it is compared, and a mode string the host does not know is refused rather than
//! defaulted — a default would turn a typo into "app-managed" and quietly decide where a user's
//! configuration is written.
//!
//! The wording lives here too. `refusal_message` is the sentence the renderer shows, and it is on
//! this side because it is about what the user's click did; the module below answers with the fact.
//!
//! Two things this surface deliberately cannot do:
//!
//!  - **It cannot hand out a credential.** The readout carries names and the placeholder, and the
//!    only way to put a value in is to submit a new one (`profile::Credentials` has no `Serialize`
//!    for exactly this reason).
//!  - **It cannot invent a configuration shape.** An edit sets a member whose parent chain the
//!    document already has; a chain that is missing is refused rather than created, because which
//!    members an engine expects is the adapter's answer (§3.4.5) and not this layer's.

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

use crate::agent_runtime::config_edit::{self, ConfigEdit, Revision};
use crate::agent_runtime::profile::{
    ConfigMode, ConfigSource, CredentialChange, CredentialStorage, Profile, ProfileError,
    ProfileFields, ProfileReadout, ProfileStore, RecordUpdate,
};
use crate::agent_runtime::secret::Secret;

/// What every command in this file needs: where the profiles are.
///
/// The store is a directory path and nothing else — no open files, no cached readout — so there is
/// nothing here to keep in sync with disk. It is in the state rather than in each call because a
/// command signature has to name something Tauri can look up.
pub struct AgentSettingsState {
    pub store: ProfileStore,
}

impl AgentSettingsState {
    pub fn new(managed: impl Into<PathBuf>) -> Self {
        Self {
            store: ProfileStore::new(managed),
        }
    }
}

/// The fields a settings form submits for a profile record.
///
/// `agentId` is absent on purpose: a profile's engine is decided when it is created (§3.4's Profile
/// row), and a request that named one would be asking for a rebind.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSubmission {
    pub mode: String,
    pub provider: Option<String>,
    pub model_id: Option<String>,
}

/// One member a settings form changed, as the editor submits it: a path and a value, never a
/// document. A request that carried the whole file is not something this surface can express.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSubmission {
    pub path: Vec<String>,
    pub value: Value,
}

/// One change to the credential set, as the settings form sends it.
///
/// Tagged, so the request says which operation it is — `{"op":"set","name":"…","value":"…"}` or
/// `{"op":"remove","name":"…"}`. A *patch* is the only shape that works here: the page shows names
/// and the placeholder, so a form that edits one credential cannot resubmit the others, and a
/// surface that took a whole set would delete every credential the form did not mention.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum CredentialSubmission {
    Set { name: String, value: String },
    Remove { name: String },
}

/// The profile as the settings page reads it.
pub fn read_profile(
    store: &ProfileStore,
    agent_id: &str,
    profile_id: &str,
) -> Result<Value, String> {
    Ok(profile_view(&open(store, agent_id, profile_id)?.readout()))
}

/// Applies a record submission at the revision the form read.
pub fn submit_profile(
    store: &ProfileStore,
    agent_id: &str,
    profile_id: &str,
    revision: &str,
    submission: &ProfileSubmission,
) -> Result<Value, String> {
    let expected = Revision::parse(revision).ok_or_else(|| refused_revision(revision))?;
    let mode = ConfigMode::parse(&submission.mode).ok_or_else(|| {
        refusal_message(&ProfileError::Field { field: "mode" })
    })?;
    let fields = ProfileFields {
        mode,
        provider: submission.provider.clone(),
        model_id: submission.model_id.clone(),
    };
    match open(store, agent_id, profile_id)?.set_fields(&expected, fields) {
        Ok(RecordUpdate::Written { revision }) => Ok(json!({
            "status": "written",
            "revision": revision.as_str(),
        })),
        Ok(RecordUpdate::Conflicted { current }) => Ok(json!({
            "status": "conflict",
            "current": profile_view(&current),
        })),
        Err(error) => Err(refusal_message(&error)),
    }
}

/// The configuration document the editor opens.
///
/// `exists: false` is a normal answer, not a failure: a profile whose engine has never run has no
/// document yet, and the page's answer to that is the engine's own configuration entry point
/// rather than a file this host invents (§3.4.5).
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
    }))
}

/// Applies the editor's edits at the revision it read, or reports the conflict with the document
/// that is there instead — the caller reloads and rebuilds its edits from that, because merging is
/// how a change made elsewhere gets undone.
pub fn submit_document(
    store: &ProfileStore,
    agent_id: &str,
    profile_id: &str,
    relative: &str,
    revision: &str,
    edits: &[EditSubmission],
) -> Result<Value, String> {
    let expected = Revision::parse(revision).ok_or_else(|| refused_revision(revision))?;
    let profile = open(store, agent_id, profile_id)?;
    if !profile.mode().host_writes() {
        return Err(refusal_message(&ProfileError::ReadOnly));
    }
    let path = profile
        .document_path(relative)
        .map_err(|error| refusal_message(&error))?;
    let edits = edits
        .iter()
        .map(|edit| ConfigEdit::set(edit.path.clone(), edit.value.clone()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| refusal_message(&error.into()))?;
    let outcome =
        config_edit::apply(&path, &expected, &edits).map_err(|error| refusal_message(&error.into()))?;
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

/// Applies a patch to the profile's credential set.
pub fn submit_credentials(
    store: &ProfileStore,
    agent_id: &str,
    profile_id: &str,
    changes: &[CredentialSubmission],
) -> Result<Value, String> {
    let mut profile = open(store, agent_id, profile_id)?;
    let changes = changes
        .iter()
        .map(|change| match change {
            CredentialSubmission::Set { name, value } => CredentialChange::Set {
                name: name.clone(),
                value: Secret::new(value.clone()),
            },
            CredentialSubmission::Remove { name } => CredentialChange::Remove { name: name.clone() },
        })
        .collect::<Vec<_>>();
    profile
        .apply_credentials(&changes)
        .map_err(|error| refusal_message(&error))?;
    Ok(profile_view(&profile.readout()))
}

/// The sentence a refused request is answered with.
///
/// It never quotes a document and never echoes a credential: `Secret` cannot be printed, the
/// document's text is not in any error variant, and the field names below are the ones the form
/// asked about.
pub fn refusal_message(error: &ProfileError) -> String {
    match error {
        ProfileError::Id { profile_id } => format!(
            "`{profile_id}` cannot be a profile id: a profile is a directory name inside this \
             app's own folder"
        ),
        ProfileError::AgentMismatch {
            profile_id,
            requested,
            bound,
        } => format!(
            "profile `{profile_id}` belongs to {bound}; it cannot be opened as {requested}. \
             Configuration and authorization are not shared between engines"
        ),
        ProfileError::Unreadable { path, message } => {
            format!("{} could not be read: {message}", path.display())
        }
        ProfileError::Escapes { relative } => {
            format!("`{relative}` is not a path inside this profile")
        }
        ProfileError::Field { field } => match *field {
            "mode" => "that configuration mode is not one this build knows".to_string(),
            other => format!("`{other}` is not a value this profile can hold"),
        },
        ProfileError::ReadOnly => {
            "this profile reuses the engine's own configuration, so this app writes nothing \
             here — not a document and not a credential"
                .to_string()
        }
        ProfileError::Credential { name } => {
            format!("`{name}` cannot be an environment variable name")
        }
        ProfileError::Document(error) => document_message(error),
    }
}

/// The document layer's refusals, in a form the form can act on.
fn document_message(error: &config_edit::ConfigError) -> String {
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

/// A revision that is not the shape this host issues is a form that was not built from a document.
/// Reported as its own fact rather than as a conflict, because the two send the user to different
/// places: reload the page, or the page never had the document at all.
fn refused_revision(revision: &str) -> String {
    let shown = revision.chars().take(12).collect::<String>();
    format!("`{shown}` is not a revision this app issued; reload the profile and edit again")
}

fn open(store: &ProfileStore, agent_id: &str, profile_id: &str) -> Result<Profile, String> {
    store
        .open(agent_id, profile_id)
        .map_err(|error| refusal_message(&error))
}

/// The readout, as the JSON the settings page reads.
///
/// Built here rather than derived on the domain types, so that the shape the renderer sees is one
/// somebody chose — and so that the credential entries can only be built from `redacted()`, which
/// has no counterpart returning values.
fn profile_view(readout: &ProfileReadout) -> Value {
    json!({
        "profileId": readout.profile_id,
        "agentId": readout.agent_id,
        "mode": readout.mode.id(),
        "root": readout.root.to_string_lossy(),
        "revision": readout.revision.as_str(),
        "provider": readout.fields.provider,
        "modelId": readout.fields.model_id,
        "editable": readout.editable(),
        "sources": readout.sources.iter().map(source_view).collect::<Vec<_>>(),
        "credentials": readout
            .credentials
            .iter()
            .map(|(name, value)| json!({ "name": name, "value": value }))
            .collect::<Vec<_>>(),
        "credentialStorage": storage_view(&readout.credential_storage),
    })
}

fn source_view(source: &ConfigSource) -> Value {
    match source {
        ConfigSource::Injected { variable, path } => json!({
            "kind": "injected",
            "variable": variable,
            "path": path.to_string_lossy(),
        }),
        ConfigSource::EngineDiscovery { what } => json!({
            "kind": "engine-discovery",
            "what": what,
        }),
    }
}

fn storage_view(storage: &CredentialStorage) -> Value {
    match storage {
        CredentialStorage::HostFile { path, mode } => json!({
            "kind": "host-file",
            "path": path.to_string_lossy(),
            "mode": format!("{mode:o}"),
            "encrypted": false,
            "keychain": false,
        }),
        CredentialStorage::None => json!({ "kind": "none" }),
    }
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/// Registered by the composition root (§6.1: this file validates and delegates; wiring it into the
/// app is the integrator's serialized change).
#[tauri::command]
pub fn agent_profile_read(
    state: State<'_, AgentSettingsState>,
    agent_id: String,
    profile_id: String,
) -> Result<Value, String> {
    read_profile(&state.store, &agent_id, &profile_id)
}

#[tauri::command]
pub fn agent_profile_write(
    state: State<'_, AgentSettingsState>,
    agent_id: String,
    profile_id: String,
    revision: String,
    submission: ProfileSubmission,
) -> Result<Value, String> {
    submit_profile(
        &state.store,
        &agent_id,
        &profile_id,
        &revision,
        &submission,
    )
}

#[tauri::command]
pub fn agent_config_document(
    state: State<'_, AgentSettingsState>,
    agent_id: String,
    profile_id: String,
    relative: String,
) -> Result<Value, String> {
    read_document(&state.store, &agent_id, &profile_id, &relative)
}

#[tauri::command]
pub fn agent_config_edit(
    state: State<'_, AgentSettingsState>,
    agent_id: String,
    profile_id: String,
    relative: String,
    revision: String,
    edits: Vec<EditSubmission>,
) -> Result<Value, String> {
    submit_document(
        &state.store,
        &agent_id,
        &profile_id,
        &relative,
        &revision,
        &edits,
    )
}

#[tauri::command]
pub fn agent_credentials_write(
    state: State<'_, AgentSettingsState>,
    agent_id: String,
    profile_id: String,
    changes: Vec<CredentialSubmission>,
) -> Result<Value, String> {
    submit_credentials(&state.store, &agent_id, &profile_id, &changes)
}
