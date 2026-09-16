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
//! 2. **A credential is a type, not a string.** [`Secret`] (defined in [`super::secret`], where the
//!    launch environment can reach it too) has no `Display`, no `Serialize` and a hand-written
//!    `Debug`, so a struct that holds one cannot print it by accident — and
//!    [`Credentials::launch_pairs`] is the single, greppable place where a value leaves that
//!    protection. It answers [`Secret`]s rather than strings, so the value that leaves one
//!    protected type lands in another one instead of in a `Vec` that any `{:?}` could print.
//! 3. **The host writes only what it owns** (§8.1). In [`ConfigMode::UserConfig`] the profile is the
//!    user's own installation, so the host reports it and edits nothing.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::config_edit::{self, ConfigDocument, ConfigEdit, ConfigError, Revision, WriteOutcome};
use super::process::isolated_profile_env;
use super::secret::Secret;

/// The directory every profile root sits under, inside the app's managed directory (§3.2).
pub const PROFILES_DIR: &str = "agent-profiles";

/// The record this host keeps about a profile, inside the profile's own root.
pub const RECORD_FILE: &str = "profile.json";

/// The credentials this host injects, inside the profile's own root.
pub const CREDENTIALS_FILE: &str = "credentials.json";

/// The mode a profile root is created with: owner only, since the engine's own files land in it.
pub const PROFILE_ROOT_MODE: u32 = 0o700;

/// The credentials this host injects into one engine's environment.
///
/// Not the only place a credential can live, and §8.1 prefers the other one: the engine's own
/// authorization flow keeps its own file, and this host neither reads nor reports it. What is here
/// is the set that has to arrive through the environment — the channel P0 §3 names, `argv` being
/// world-readable. The values are [`Secret`]s, so this holder inherits the rule instead of
/// restating it.
#[derive(Clone, Default)]
pub struct Credentials(BTreeMap<String, Secret>);

impl Credentials {
    pub fn new(entries: impl IntoIterator<Item = (String, Secret)>) -> Self {
        Self(entries.into_iter().collect())
    }

    /// The names only. Public because a report says *which* providers are configured, which is a
    /// fact about the setup rather than about the secret.
    pub fn names(&self) -> Vec<String> {
        self.0.keys().cloned().collect()
    }

    /// The readout: every value replaced. This is the only form a report, a diagnostic or an IPC
    /// answer may carry, and it is the reason `Credentials` has no `Serialize`.
    pub fn redacted(&self) -> Vec<(String, String)> {
        self.0
            .iter()
            .map(|(name, _)| (name.clone(), "<redacted>".to_string()))
            .collect()
    }

    /// This set with `changes` applied — the patch a settings form submits.
    fn patched(&self, changes: &[CredentialChange]) -> Credentials {
        let mut entries = self.0.clone();
        for change in changes {
            match change {
                CredentialChange::Set { name, value } => {
                    entries.insert(name.clone(), value.clone());
                }
                CredentialChange::Remove { name } => {
                    entries.remove(name);
                }
            }
        }
        Credentials(entries)
    }

    /// The real pairs, for the launch environment — the one caller that needs them.
    ///
    /// A named method rather than an `Iterator` implementation, because this is the point where a
    /// credential leaves the type that protects it, and it has to be visible at the call site. What
    /// comes back is still made of [`Secret`]s: the caller that assembles an `EngineLaunch` puts
    /// them into a field whose own `Debug` cannot print them, so the value moves from one protected
    /// holder into another and never passes through a `String` a `{:?}` could reach. The two places
    /// that must have the text — the credential file this host writes, and the launch environment
    /// the engine reads — call [`Secret::expose`] by name.
    pub fn launch_pairs(&self) -> Vec<(String, Secret)> {
        self.0
            .iter()
            .map(|(name, secret)| (name.clone(), secret.clone()))
            .collect()
    }
}

impl fmt::Debug for Credentials {
    /// Names, never values — the whole reason this is hand-written.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("Credentials").field(&self.names()).finish()
    }
}

/// §8.1's configuration mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigMode {
    /// The app's own profile: `HOME` and the XDG roots point inside the profile root, so the engine
    /// writes its configuration and credentials where this host owns them.
    AppManaged,
    /// The user's own installation, explicitly chosen (§8.1: 「已有 OpenCode 用户可显式选择复用其
    /// 配置」). Nothing is injected and nothing is written: the host reports what it finds, because a
    /// page that edited the file the user's own tools also read is the overwrite the mode switch is
    /// required not to perform.
    UserConfig,
}

impl ConfigMode {
    pub fn id(self) -> &'static str {
        match self {
            ConfigMode::AppManaged => "app-managed",
            ConfigMode::UserConfig => "user-config",
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        match id {
            "app-managed" => Some(ConfigMode::AppManaged),
            "user-config" => Some(ConfigMode::UserConfig),
            _ => None,
        }
    }

    /// Whether this host may write configuration documents in this mode (see [`ConfigMode`]).
    pub fn host_writes(self) -> bool {
        matches!(self, ConfigMode::AppManaged)
    }
}

/// One configuration source, as the settings page reports it (§8.1: 「列出实际生效源」).
///
/// An enum rather than a list of paths, because the second arm is the point: §8.1 forbids
/// presenting the injected roots as though nothing else were read, and a shape that can only hold
/// paths has nowhere to say that.
#[derive(Debug, Clone)]
pub enum ConfigSource {
    /// A root this host sets, derived from what the launch environment actually gets rather than
    /// from a list kept beside it.
    Injected { variable: String, path: PathBuf },
    /// A merge this host does not set and does not claim to have closed. The engine's own discovery
    /// rules are the engine's (§8.1: `OPENCODE_CONFIG_DIR` is not a complete isolation switch, and
    /// pretending otherwise is the claim the plan forbids).
    EngineDiscovery { what: DiscoverySurface },
}

/// Which of the engine's own merges this profile still takes.
///
/// Named one at a time rather than summed up in a sentence, because the sentence this replaces grew
/// false the moment the isolation was measured. It said the engine's own discovery was 「not claimed
/// to have been turned off」 — true of the configuration roots, and untrue of the two compatible
/// `skills` directories, which the app-managed launch had by then stopped reading. A page that
/// renders a summary cannot be corrected when one clause of it changes; a page that renders a list
/// of surfaces can, and each arm here is one that was measured.
///
/// **The wording is not here.** Each arm serializes to a key the page's own copy is looked up by
/// (carried across the boundary as `what`, the field name from when it held prose — see
/// `commands/agent_settings.rs`), so the sentences a user reads live in the i18n catalogue with
/// every other sentence, and a second English wording in Rust cannot drift from them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
// The kebab-case spelling `ConfigMode::id` uses, so every id that crosses this boundary is written
// the one way; the field keeps `commands/agent_settings.rs` unchanged by serializing *into* the
// shape it already sends.
#[serde(rename_all = "kebab-case")]
pub enum DiscoverySurface {
    /// Nothing narrower is worth naming: this profile *is* the user's own installation, so the
    /// engine reads what it always reads and this host enumerates none of it.
    Reused,
    /// The configuration of the folder a session runs in and of every folder above it — a vault's
    /// own providers and permission rules, merged into this profile (measured). The engine honours
    /// `OPENCODE_DISABLE_PROJECT_CONFIG` for exactly this merge and this host does not set it:
    /// which project configuration an engine reads is a fact about that engine (§3.4), and reading
    /// the vault's own configuration may be wanted. Reported, not decided here.
    Project,
    /// Linux's managed configuration root, `/etc/opencode`, merged at global precedence: a system
    /// administrator's providers and permission rules reach every profile, and no supported switch
    /// closes it. Reported because a page that drew only what this host sets would leave a reader
    /// to assume nothing else was there.
    Managed,
}

/// Where a profile's credentials are, stated rather than implied.
///
/// §8.1: 「凭据若由 OpenCode 原生文件保存，就如实显示存储方式，不宣称已经使用系统钥匙串或加密」.
/// The variant name is the statement, so a page rendering this cannot accidentally promise more.
#[derive(Debug, Clone)]
pub enum CredentialStorage {
    /// This host's file, inside the profile root, with minimal permissions. Not encrypted, and not
    /// a system keychain.
    HostFile { path: PathBuf, mode: u32 },
    /// Nothing is stored by this host: in [`ConfigMode::UserConfig`] the credentials are the
    /// engine's own and this app does not read, copy or report them.
    None,
}

/// One change to a profile's credential set.
///
/// Tagged rather than positional, so the JSON a renderer sends says which operation it is:
/// `{"op":"set","name":"…","value":"…"}` or `{"op":"remove","name":"…"}`. `Debug` is safe to derive
/// because the value inside is a [`Secret`], whose own `Debug` prints the placeholder.
#[derive(Debug, Clone)]
pub enum CredentialChange {
    Set { name: String, value: Secret },
    Remove { name: String },
}

impl CredentialChange {
    pub fn name(&self) -> &str {
        match self {
            CredentialChange::Set { name, .. } | CredentialChange::Remove { name } => name,
        }
    }
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
        for (field, value) in [
            ("provider", &self.provider),
            ("model_id", &self.model_id),
        ] {
            if let Some(value) = value {
                if value.trim().is_empty() || value.chars().any(char::is_control) {
                    return Err(ProfileError::Field { field });
                }
            }
        }
        Ok(())
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
}

impl ProfileReadout {
    /// Whether this profile's documents may be edited from the settings page.
    pub fn editable(&self) -> bool {
        self.mode.host_writes()
    }
}

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

/// The record as it is stored. Every field is optional because a record written by an older build
/// may not have them, and a missing field is a value to default rather than a document to refuse.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRecord {
    agent_id: Option<String>,
    mode: Option<String>,
    provider: Option<String>,
    model_id: Option<String>,
}

/// What a record write did. The same two arms as a document write, because it is the same rule.
#[derive(Debug)]
pub enum RecordUpdate {
    Written { revision: Revision },
    /// Someone else's write landed first. `current` is the readout to reload from, and the caller
    /// re-applies its change to *that* — nothing is merged here.
    Conflicted { current: ProfileReadout },
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

    /// Where one profile's files are, whether or not the profile exists yet.
    pub fn root_of(&self, profile_id: &str) -> Result<PathBuf, ProfileError> {
        if !is_single_component(profile_id) {
            return Err(ProfileError::Id {
                profile_id: profile_id.to_string(),
            });
        }
        Ok(self.managed.join(PROFILES_DIR).join(profile_id))
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
        let stored: StoredRecord = serde_json::from_str(document.text()).map_err(|error| {
            ProfileError::Unreadable {
                path: document.path().to_path_buf(),
                message: error.to_string(),
            }
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
        Ok(Profile {
            managed: self.managed.clone(),
            root,
            agent_id: agent_id.to_string(),
            profile_id: profile_id.to_string(),
            document,
            fields,
            credentials,
        })
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

impl Profile {
    /// The directory to hand `AgentRegistry::start` as its managed root.
    ///
    /// It is exactly what §8.1's profile-isolated mode points `HOME` and the XDG roots into, so the
    /// engine's configuration, credentials and sessions land in this profile and in no other.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn mode(&self) -> ConfigMode {
        self.fields.mode
    }

    pub fn credentials(&self) -> &Credentials {
        &self.credentials
    }

    /// The record's revision, as the token a write must be built on.
    pub fn revision(&self) -> &Revision {
        self.document.revision()
    }

    pub fn credential_file(&self) -> PathBuf {
        self.root.join(CREDENTIALS_FILE)
    }

    /// The absolute path of a configuration document inside this profile.
    ///
    /// The caller supplies where inside the profile the document lives — for OpenCode that is its
    /// own `XDG_CONFIG_HOME` path, which is the adapter's fact (§3.4's last line) and not this
    /// module's. What this owns is the guarantee that the answer is *inside*: a relative path that
    /// would leave the root is refused rather than normalized.
    pub fn document_path(&self, relative: &str) -> Result<PathBuf, ProfileError> {
        let escapes = || ProfileError::Escapes {
            relative: relative.to_string(),
        };
        let path = Path::new(relative);
        if path.as_os_str().is_empty()
            || path.is_absolute()
            || !path
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err(escapes());
        }
        Ok(self.root.join(path))
    }

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
        }
    }

    /// The sources the engine will actually read, as far as this host knows them.
    ///
    /// The injected half is derived from [`isolated_profile_env`] — the same function the launch
    /// uses — so the report cannot drift from what the engine is given, and the rest is the part
    /// §8.1 requires be said out loud: these roots are what this host sets, and they do not close
    /// the engine's own discovery.
    ///
    /// What the launch injects and what this lists are not quite the same set, and the difference
    /// is stated rather than smoothed over: [`isolated_profile_env`] also carries one *switch* —
    /// `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, the engine's own way of stopping its path-driven scan
    /// of `.claude` and `.agents` — and a switch is not a source. [`ConfigSource::Injected`] is a
    /// root, a page renders it as a directory, and reporting `1` as one would be the kind of
    /// confident nonsense §8.1 is about. A switch is a fact about a *scope* rather than about a
    /// configuration root, and the readout that carries it is the skills one
    /// (`skills::SkillScope::suppressed_by`); this list keeps the roots, and names the merges that
    /// remain below rather than summarizing them.
    pub fn sources(&self) -> Vec<ConfigSource> {
        let mut sources: Vec<ConfigSource> = match self.fields.mode {
            ConfigMode::AppManaged => isolated_profile_env(&self.root)
                .into_iter()
                // An absolute path is what a root is; everything else the launch carries is a
                // value, and the readout has no place to put one.
                .filter(|(_, value)| Path::new(value).is_absolute())
                .map(|(variable, path)| ConfigSource::Injected {
                    variable,
                    path: PathBuf::from(path),
                })
                .collect(),
            ConfigMode::UserConfig => Vec::new(),
        };
        sources.extend(
            self.discovery_surfaces()
                .iter()
                .map(|surface| ConfigSource::EngineDiscovery { what: *surface }),
        );
        sources
    }

    /// The engine's own merges this profile still takes, one per surface (see
    /// [`DiscoverySurface`]).
    ///
    /// An isolated profile narrows the engine's discovery to exactly the merges no injected root
    /// reaches, and those are the ones a page has to state — leaving them out is what would let a
    /// reader take the injected list for the whole of it. A profile reusing the user's own
    /// installation narrows nothing, and naming two of the merges *it* keeps would read as though
    /// the rest had been closed.
    fn discovery_surfaces(&self) -> &'static [DiscoverySurface] {
        match self.fields.mode {
            ConfigMode::AppManaged => &[DiscoverySurface::Project, DiscoverySurface::Managed],
            ConfigMode::UserConfig => &[DiscoverySurface::Reused],
        }
    }

    fn credential_storage(&self) -> CredentialStorage {
        match self.fields.mode {
            ConfigMode::AppManaged => CredentialStorage::HostFile {
                path: self.credential_file(),
                mode: config_edit::DOCUMENT_MODE,
            },
            ConfigMode::UserConfig => CredentialStorage::None,
        }
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

    /// Applies a patch to this profile's credential set.
    ///
    /// A **patch and not a whole set**, because the settings page never has the set: it shows names
    /// and the placeholder, so a form that edits one credential cannot resubmit the others. A
    /// surface that took a whole set would delete every credential the form did not mention — the
    /// user edits one key and the other three disappear, with nothing on screen to say so.
    ///
    /// No revision token: there is nothing to merge, since a credential is write-only from the
    /// user's side — the value they typed last is the one they meant. Names are checked here because
    /// these become environment variables, the shape `registry.rs` requires of `env_extra` and for
    /// its reason: the environment is the channel a credential travels in.
    pub fn apply_credentials(&mut self, changes: &[CredentialChange]) -> Result<(), ProfileError> {
        if self.fields.mode == ConfigMode::UserConfig {
            return Err(ProfileError::ReadOnly);
        }
        for change in changes {
            let name = change.name();
            if !is_variable_name(name) {
                return Err(ProfileError::Credential {
                    name: name.to_string(),
                });
            }
        }
        let credentials = self.credentials.patched(changes);
        // The file this host owns is one of the two places the text itself has to exist, so it is
        // written from `expose` by name — the same way the launch environment is built.
        let object: Value = credentials
            .launch_pairs()
            .into_iter()
            .map(|(name, secret)| (name, Value::String(secret.expose().to_string())))
            .collect::<serde_json::Map<_, _>>()
            .into();
        config_edit::write_replacing(&self.credential_file(), &object.to_string())?;
        self.credentials = credentials;
        Ok(())
    }
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

/// The directory a profile root sits in, made with [`PROFILE_ROOT_MODE`].
///
/// The mode is set when the root is *created*; a root that already exists keeps what it has, which
/// is safe because what protects a credential is the file's own 0600 — a readable directory does
/// not make an unreadable file readable.
fn create_root(root: &Path) -> Result<(), ProfileError> {
    use std::os::unix::fs::DirBuilderExt;

    fs::DirBuilder::new()
        .recursive(true)
        .mode(PROFILE_ROOT_MODE)
        .create(root)
        .map_err(|error| ProfileError::Unreadable {
            path: root.to_path_buf(),
            message: error.to_string(),
        })
}

/// Writes the record a profile is created with: the engine it belongs to, and defaults for the rest.
fn create_record(root: &Path, agent_id: &str) -> Result<ConfigDocument, ProfileError> {
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

/// The credentials file, read as a name-to-value map.
///
/// A file that cannot be read is reported as an empty set rather than as a failure to open the
/// profile: the settings page has to be able to show the profile in order to let the user fix what
/// is wrong with it, and a secret that cannot be read is one that will not be injected — the safe
/// direction for every failure in this function.
fn read_credentials(path: &Path) -> Credentials {
    let Ok(Some(document)) = config_edit::read(path) else {
        return Credentials::default();
    };
    let Ok(stored) = serde_json::from_str::<BTreeMap<String, String>>(document.text()) else {
        return Credentials::default();
    };
    Credentials::new(
        stored
            .into_iter()
            .map(|(name, value)| (name, Secret::new(value))),
    )
}

/// Whether a name can be handed to a process at all.
///
/// The kernel's own rule, and the one `registry.rs` applies to `env_extra`: an empty name, an `=`
/// or a control character cannot be an environment variable, and a name that crept past this would
/// fail at `execve` — long after the settings page reported the credential as saved.
fn is_variable_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('=') && !name.chars().any(char::is_control)
}

/// Whether an id can be one path component and nothing else.
///
/// Deliberately *not* the charset `registry.rs` applies to an identity: what matters here is only
/// that the value cannot leave the managed root or name something other than itself, and
/// `Component::Normal` is that question asked of the path parser instead of a list of letters.
fn is_single_component(id: &str) -> bool {
    let mut parts = Path::new(id).components();
    matches!(parts.next(), Some(Component::Normal(_))) && parts.next().is_none()
}
