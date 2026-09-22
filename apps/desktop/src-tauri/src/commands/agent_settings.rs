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
//!    members an engine expects is the adapter's answer (§3.4.5) and not this layer's. The
//!    *document* is the one thing an edit may bring into being, and only with the members the form
//!    named: a create is the same claim, checked against the same disk (see `apply_claim`), and it
//!    is the only way to write out of a state the readout can report — a profile whose engine has
//!    no configuration file yet.

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

use crate::agent_runtime::config_edit::Revision;
use crate::agent_runtime::profile::{
    ConfigMode, ConfigSource, CredentialChange, CredentialStorage, PermissionDefaults, Profile,
    ProfileError, ProfileFields, ProfileReadout, ProfileStore, RecordUpdate,
    SHIPPED_PERMISSION_RULES,
};
use crate::agent_runtime::secret::Secret;

#[path = "agent_settings/config_document.rs"]
mod config_document;
pub use config_document::{read_document, submit_document, EditSubmission};
use config_document::document_message;

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
    let mode = ConfigMode::parse(&submission.mode)
        .ok_or_else(|| refusal_message(&ProfileError::Field { field: "mode" }))?;
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
            CredentialSubmission::Remove { name } => {
                CredentialChange::Remove { name: name.clone() }
            }
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
        ProfileError::Credential { name, reserved } => match reserved {
            Some(why) => format!("`{name}` is reserved and cannot be set here: {why}"),
            None => format!("`{name}` cannot be an environment variable name"),
        },
        ProfileError::Document(error) => document_message(error),
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
        // The consent default, and the one thing about it a user has to be able to check: whether
        // the engine is configured to ask at all. Read out of the same object the session path
        // writes through (`Profile::apply_shipped_permissions`), so the page cannot report a rule
        // the engine was not given.
        "permissions": {
            "state": permission_state(readout.permission_defaults),
            "document": readout.permission_document.as_ref().map(|path| path.to_string_lossy()),
            // The rules this app ships, as the engine's configuration spells them. A fact about
            // this app rather than about the document — `state` is what says whether they are the
            // ones in force.
            "rules": SHIPPED_PERMISSION_RULES
                .iter()
                .map(|rule| json!({ "tool": rule.tool, "action": rule.action }))
                .collect::<Vec<_>>(),
        },
        // The relative path `agent_config_document` and `agent_config_edit` take for the engine's
        // own configuration, or `null` where this host owns no such file. The editor's page cannot
        // spell this itself: which document an engine reads under its own root is the engine's
        // layout, and a component holding a literal path is the engine known by name — the thing
        // §3.4's last line forbids in a window.
        "configDocument": readout.config_document,
    })
}

/// [`PermissionDefaults`] as the settings page reads it.
///
/// Three ids rather than a boolean, because the third state is a real one and the one a user whose
/// files are least protected is in: a profile that reuses the user's own installation is a profile
/// where this app wrote no rules and cannot say what the engine will ask.
fn permission_state(defaults: PermissionDefaults) -> &'static str {
    match defaults {
        PermissionDefaults::Written => "written",
        PermissionDefaults::Left | PermissionDefaults::Contended => "engine-own",
        PermissionDefaults::NotThisHosts => "not-this-host",
    }
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
    submit_profile(&state.store, &agent_id, &profile_id, &revision, &submission)
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

/// The revision is optional, and `null` is a claim rather than an omission: it is what a page read
/// for a document that is not there, and the backend checks it against the disk like any other
/// revision (`apply_claim`). A caller that dropped the field by mistake sends the same claim, and
/// the check turns it into a conflict rather than a write wherever a document does exist.
#[tauri::command]
pub fn agent_config_edit(
    state: State<'_, AgentSettingsState>,
    agent_id: String,
    profile_id: String,
    relative: String,
    revision: Option<String>,
    edits: Vec<EditSubmission>,
) -> Result<Value, String> {
    submit_document(
        &state.store,
        &agent_id,
        &profile_id,
        &relative,
        revision.as_deref(),
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
