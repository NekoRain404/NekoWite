//! §8.1's configuration mode: which directory a profile's files live in, which roots the engine is
//! told about, and which values may never be printed.
//!
//! §3.4's Profile row splits configuration from definition: `registry.rs` owns *which engines exist
//! and which profile belongs to which*, and this module owns *the profile itself* — its root, its
//! record, its credentials and the answer to "may this host write here at all". They are not merged
//! into one manager, and the reason is the one §3.4 gives: the two answer different questions, and
//! a profile bound to the wrong engine is a class of bug that a single object with one `agent_id`
//! field cannot even express.
//!
//! The layout is §3.2's, resolved under the app's managed directory rather than under `$HOME`:
//!
//! ```text
//! <managed>/agent-profiles/<profile-id>/
//!   profile.json        this host's record: which agent, which mode, which provider and model
//!   credentials.json    the values this host injects, mode 0600
//!   HOME, XDG_*         the engine's own roots, injected per §8.1's profile-isolated mode
//! ```
//!
//! Three rules are the reason this is a module rather than a path helper:
//!
//! 1. **A profile belongs to one engine** (§3.4). Its record names the agent it was created for and
//!    every entry point refuses a pair that disagrees, which is what stops one engine's
//!    authorization, model id or config file from being handed to another.
//! 2. **A credential is a type, not a string.** [`super::secret::Secret`] (where the launch
//!    environment can reach it too) has no `Display`, no `Serialize` and a hand-written `Debug`, so
//!    a struct that holds one cannot print it by accident — and [`Credentials::launch_pairs`] is the
//!    single, greppable place where a value leaves that protection. It answers `Secret`s rather than
//!    strings, so the value that leaves one protected type lands in another one instead of in a
//!    `Vec` that any `{:?}` could print.
//! 3. **The host writes only what it owns** (§8.1). In [`ConfigMode::UserConfig`] the profile is the
//!    user's own installation, so the host reports it and edits nothing.
//!
//! **Split by what makes each part change, not by arithmetic.** `docs/dev.md` §5.4.2 puts the
//! criterion on the number of reasons a file changes rather than on its line count, and this file
//! held five: the layout of a profile root, the credential set that is injected into it, the engine
//! configuration document this host writes a consent default into, the scope model that says what
//! the engine still reads on its own, and the record a settings page edits. Each is now a child
//! module whose header argues why it is the one that moves when its subject does:
//!
//! - [`layout`] — where a profile's files are, and the rule that decides whether an id or a relative
//!   path may name a place inside the root at all. The security boundary, in both of its halves.
//! - [`credentials`] — the credential set, the patch a form submits, the storage statement, and the
//!   name rule that decides whether a credential can reach a process.
//! - [`permissions`] — the engine's own configuration document and the consent default written into
//!   it, in the engine's own vocabulary.
//! - [`scope`] — the scope model: what this host injects, and the engine's own merges a profile
//!   still takes.
//! - [`record`] — `profile.json`'s members, the fields a settings page may set, and the revision
//!   rule a write obeys.
//!
//! What stays here is the profile as a whole: the store that says which profiles exist and opens
//! one (binding it to an engine), the profile's own identity, the readout that composes the five
//! subjects into what a page is shown, and the error vocabulary every child returns.
//!
//! Every name a caller outside this directory reached before is re-exported below, so the split
//! moved no path: `commands/agent_settings.rs`, `commands/agent_skills.rs`, `state/app_state.rs`,
//! `agent_runtime::registry`, `agent_runtime::environment` and the test targets name the same
//! symbols through `profile::` as they always did.

use std::fmt;
use std::fs;
use std::path::PathBuf;

use super::config_edit::{self, ConfigDocument, ConfigError, Revision};

// The layout a profile root is built from. Split out because it changes for its own reason — a file
// this host keeps, the mode a root is made with, or what may be one path component — and because
// the two halves of the path check (`root_of`, `document_path`) read as one question when they sit
// together.
mod layout;
// The credential set. Split out because it changes when the channel a credential travels in does,
// and because it is the file that defines the type the rest of the crate relies on to keep a value
// out of a log line.
mod credentials;
// The engine's consent default and the document it is written into. Split out because it changes
// when the engine's permission vocabulary or this app's shipped rules do.
mod permissions;
// The scope model. Split out because it changes when a measured fact about the engine's own
// discovery does, which is not when a path or a credential changes.
mod scope;
// The record document. Split out because it changes when `profile.json`'s members or the conflict
// rule of a write do, which is not when the store's directory walk does.
mod record;

// The two helpers the store itself calls while opening a profile: where a root goes, and the record
// a first open creates. Named here rather than through their module so the open reads as one
// sequence of steps.
use self::credentials::read_credentials;
use self::layout::{create_root, is_single_component};
use self::record::{create_record, StoredRecord};

/// The credentials this host injects, inside the profile's own root.
pub use self::layout::CREDENTIALS_FILE;
/// The directory every profile root sits under, inside the app's managed directory (§3.2).
pub use self::layout::PROFILES_DIR;
/// The mode a profile root is created with: owner only, since the engine's own files land in it.
///
/// Re-exported although nothing outside [`layout`] names it, because the name was reachable as
/// `profile::PROFILE_ROOT_MODE` before the split and the paths that name it are not this change's
/// to rewrite. `unused_imports` is allowed for the reason `agent_runtime::process` records: the
/// library, where this module is public, does not report the re-export, and a target that
/// `#[path]`-includes this tree does.
#[allow(unused_imports)]
pub use self::layout::PROFILE_ROOT_MODE;
/// The record this host keeps about a profile, inside the profile's own root.
pub use self::layout::RECORD_FILE;

pub use self::credentials::{CredentialChange, CredentialStorage, Credentials};
// `ShippedPermissionRule` is re-exported on its own, and allowed, for the same reason
// `PROFILE_ROOT_MODE` is: the type is named here only inside the array below, so a target that
// includes this tree reaches the rules without ever spelling the element type.
#[allow(unused_imports)]
pub use self::permissions::ShippedPermissionRule;
pub use self::permissions::{
    shipped_permission_block, PermissionDefaults, ENGINE_CONFIG_DOCUMENT, PERMISSION_MEMBER,
    SHIPPED_PERMISSION_RULES,
};
pub use self::record::{ProfileFields, RecordUpdate};
pub use self::scope::{ConfigMode, ConfigSource, DiscoverySurface};

/// Why a profile could not be opened, written or bound.
#[derive(Debug)]
pub enum ProfileError {
    /// An id that cannot be a path component. §3.2 puts it into a directory name, so anything that
    /// could leave the managed root is refused here rather than normalized.
    Id { profile_id: String },
    /// The profile belongs to a different engine (§3.4's Profile row). `bound` is the agent it does
    /// belong to, so the caller can say which one instead of "not found".
    AgentMismatch {
        profile_id: String,
        requested: String,
        bound: String,
    },
    /// The record is there and is not a record this build can read — a hand-edited file, a document
    /// from a newer build. Writes are refused rather than applied against fields that were not
    /// understood.
    Unreadable { path: PathBuf, message: String },
    /// A relative path that would leave the profile root.
    Escapes { relative: String },
    /// A field no environment variable, diagnostic or document could carry.
    Field { field: &'static str },
    /// This host does not write here: §8.1's reuse mode leaves the engine's own configuration and
    /// its own credentials alone, and the switch to that mode moves nothing.
    ReadOnly,
    /// A credential whose name cannot reach a process.
    Credential { name: String },
    /// The document layer's refusal, unchanged: the exit from this module is not a second place to
    /// interpret a revision conflict.
    Document(ConfigError),
}

impl From<ConfigError> for ProfileError {
    fn from(error: ConfigError) -> Self {
        ProfileError::Document(error)
    }
}

/// What the settings page is shown about one profile (§8.1's 「明确显示当前管理的引擎与 profile」).
#[derive(Debug, Clone)]
pub struct ProfileReadout {
    pub profile_id: String,
    pub agent_id: String,
    pub mode: ConfigMode,
    pub root: PathBuf,
    pub revision: Revision,
    pub fields: ProfileFields,
    pub sources: Vec<ConfigSource>,
    /// Names with values replaced. There is no arm of this type that carries a value.
    pub credentials: Vec<(String, String)>,
    pub credential_storage: CredentialStorage,
    /// The state of this app's consent default for this profile: whether its rules are the ones the
    /// engine's configuration carries, or whether that configuration already spoke for itself
    /// (see [`Profile::apply_shipped_permissions`]).
    pub permission_defaults: PermissionDefaults,
    /// Where the rules live, when this host may write them. `None` in the mode where it may not —
    /// a page that drew a path here would be naming a document this host does not own.
    pub permission_document: Option<PathBuf>,
    /// The engine's own configuration document, as the editor opens it: [`ENGINE_CONFIG_DOCUMENT`],
    /// or `None` in the mode where this host owns no such file.
    ///
    /// The *relative* spelling, and that is the point of having a second field beside
    /// [`ProfileReadout::permission_document`]: `agent_config_document` and `Profile::document_path`
    /// take a path relative to the profile root, and the confinement check that keeps an editor
    /// inside that root is the one every document read already goes through. An absolute path here
    /// would have to be turned back into a relative one by whoever called, and a caller doing that
    /// arithmetic is a second place for the answer to be wrong.
    ///
    /// `None` is the honest arm in `user-config` mode for the reason `permission_document` gives: a
    /// profile that reuses the user's own installation has an engine configuration, and it is that
    /// installation's file — a path this host does not own and will not hand out as if it did.
    pub config_document: Option<&'static str>,
}

impl ProfileReadout {
    /// Whether this profile's documents may be edited from the settings page.
    pub fn editable(&self) -> bool {
        self.mode.host_writes()
    }
}

/// One profile, open: its root, its record and its credentials.
///
/// `Debug` is hand-written for the same reason [`Credentials`]' is: a derived one would print the
/// record and the credential holder, and a `{:?}` of a profile is exactly the line that ends up in
/// a log. What it prints instead is what a diagnostic may legitimately show.
pub struct Profile {
    /// The store's directory, kept so a conflict can be answered with a fresh read of this same
    /// profile rather than with a path reconstructed from the root.
    managed: PathBuf,
    root: PathBuf,
    agent_id: String,
    profile_id: String,
    document: ConfigDocument,
    fields: ProfileFields,
    credentials: Credentials,
}

impl fmt::Debug for Profile {
    /// Names, modes and paths: what a diagnostic may show. Not the credentials, and not the
    /// record's text — a derived `Debug` would print both, and a `{:?}` of a profile is exactly the
    /// line that ends up in a log.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Profile")
            .field("profile_id", &self.profile_id)
            .field("agent_id", &self.agent_id)
            .field("root", &self.root)
            .field("fields", &self.fields)
            .field("revision", self.document.revision())
            .field("credentials", &self.credentials)
            .finish()
    }
}

/// The profiles this app has, under one managed directory.
pub struct ProfileStore {
    managed: PathBuf,
}

impl ProfileStore {
    /// `managed` is the app's own data directory for the agent runtime (§3.2); every profile root
    /// is a directory inside it, and nothing here reads or writes outside.
    pub fn new(managed: impl Into<PathBuf>) -> Self {
        Self {
            managed: managed.into(),
        }
    }

    /// Opens a profile, creating it on first use, and refuses a pair that disagrees.
    ///
    /// Opening is the moment a profile is *bound* to an engine: §3.1's first-run flow is the user
    /// choosing an engine and a provider, and the binding that follows is what §3.4's Profile row
    /// is about. A pairing is therefore written once and checked on every later open.
    pub fn open(&self, agent_id: &str, profile_id: &str) -> Result<Profile, ProfileError> {
        let root = self.root_of(profile_id)?;
        create_root(&root)?;
        let document = match config_edit::read(&root.join(RECORD_FILE))? {
            Some(document) => document,
            // First use: the record is created with the engine it is being created for, and the
            // binding is checked on the way *out* rather than here — what must never happen is an
            // existing record being read as though it belonged to the caller.
            //
            // The residual window, stated rather than hidden: the write is atomic but not
            // exclusive, so two engines creating the *same* id in the same instant would each read
            // back their own binding. It cannot persist — the next read of either profile sees the
            // one record that is on disk, and `registry.rs` refuses a second `bind_profile` for one
            // profile id — but for that instant the two would share a root directory, which is why
            // §7.2's 「读取后检查再写入不是跨进程原子比较替换」 applies to this file as it does to
            // the configuration documents.
            None => create_record(&root, agent_id)?,
        };
        let stored: StoredRecord =
            serde_json::from_str(document.text()).map_err(|error| ProfileError::Unreadable {
                path: document.path().to_path_buf(),
                message: error.to_string(),
            })?;
        let bound = stored.agent_id.unwrap_or_default();
        if bound != agent_id {
            return Err(ProfileError::AgentMismatch {
                profile_id: profile_id.to_string(),
                requested: agent_id.to_string(),
                bound,
            });
        }
        let fields = ProfileFields {
            mode: stored
                .mode
                .as_deref()
                .and_then(ConfigMode::parse)
                .unwrap_or(ConfigMode::AppManaged),
            provider: stored.provider,
            model_id: stored.model_id,
        };
        let credentials = read_credentials(&root.join(CREDENTIALS_FILE));
        let profile = Profile {
            managed: self.managed.clone(),
            root,
            agent_id: agent_id.to_string(),
            profile_id: profile_id.to_string(),
            document,
            fields,
            credentials,
        };
        // On the way *out* rather than on the way in, and only after the binding has been checked:
        // writing a consent default into a root this host has just refused to open would put it in
        // the wrong engine's profile. The answer is discarded here and read again by `readout` —
        // see `PermissionDefaults` for why the open's own answer is not the one a page may show.
        profile.apply_shipped_permissions()?;
        Ok(profile)
    }

    /// Every profile this store holds, as (profile_id, agent_id) — what the composition root hands
    /// `AgentRegistry::bind_profile` at startup, since the working copies of that answer live in
    /// memory while this one lives on disk.
    pub fn bindings(&self) -> Result<Vec<(String, String)>, ProfileError> {
        let directory = self.managed.join(PROFILES_DIR);
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(ProfileError::Unreadable {
                    path: directory,
                    message: error.to_string(),
                })
            }
        };
        let mut bindings = Vec::new();
        for entry in entries.flatten() {
            let profile_id = entry.file_name().to_string_lossy().into_owned();
            if !entry.path().is_dir() || !is_single_component(&profile_id) {
                continue;
            }
            let Some(document) = config_edit::read(&entry.path().join(RECORD_FILE))? else {
                continue;
            };
            let stored: StoredRecord = match serde_json::from_str(document.text()) {
                Ok(stored) => stored,
                Err(_) => continue,
            };
            if let Some(agent_id) = stored.agent_id {
                bindings.push((profile_id, agent_id));
            }
        }
        bindings.sort();
        Ok(bindings)
    }
}

impl Profile {
    /// What the settings page is shown.
    pub fn readout(&self) -> ProfileReadout {
        ProfileReadout {
            profile_id: self.profile_id.clone(),
            agent_id: self.agent_id.clone(),
            mode: self.fields.mode,
            root: self.root.clone(),
            revision: self.document.revision().clone(),
            fields: self.fields.clone(),
            sources: self.sources(),
            credentials: self.credentials.redacted(),
            credential_storage: self.credential_storage(),
            permission_defaults: self.permission_defaults(),
            permission_document: match self.fields.mode {
                ConfigMode::AppManaged => self.document_path(ENGINE_CONFIG_DOCUMENT).ok(),
                ConfigMode::UserConfig => None,
            },
            // The same document, spelled the way a caller may open it. Not derived from the field
            // above: that one is `document_path`'s answer *for this root*, this one is the relative
            // name `document_path` takes, and a caller stripping the prefix off the first would be
            // doing arithmetic the type system cannot check.
            config_document: match self.fields.mode {
                ConfigMode::AppManaged => Some(ENGINE_CONFIG_DOCUMENT),
                ConfigMode::UserConfig => None,
            },
        }
    }
}
