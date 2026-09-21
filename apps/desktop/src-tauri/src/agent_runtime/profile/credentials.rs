//! The credential set this host injects into one engine's environment: the values, the patch a
//! settings form submits, the honest statement of where they are stored, and the rule that decides
//! whether a credential's *name* can reach a process at all.
//!
//! **Why it is a file of its own.** `docs/dev.md:286` puts the budget for a business source file at
//! 600 lines, and [`super`] was 1027. The split is by *reason to change*, which is the criterion
//! that section states rather than the line count: this module moves when the *credential channel*
//! moves — the day §8.1's preference wins and a value starts arriving from the engine's own
//! authorization file instead of the environment, a change to the shape of the patch a form submits,
//! or a change to the kernel's rule for what an environment variable name may be. It does not move
//! when a path rule does ([`super::layout`]) or when the engine's consent default does
//! ([`super::permissions`]).
//!
//! **The protection is the type, and this is where it is defined.** [`Credentials`] has no
//! `Display`, no `Serialize` and a hand-written `Debug`, so a struct that holds one cannot print it
//! by accident — and [`Credentials::launch_pairs`] is the single, greppable place where a value
//! leaves that protection. It answers [`Secret`]s rather than strings, so the value that leaves one
//! protected type lands in another one instead of in a `Vec` that any `{:?}` could print. The two
//! places that must have the text — the credential file this host writes and the launch environment
//! the engine reads — call [`Secret::expose`] by name, and one of them is
//! [`Profile::apply_credentials`] below.
//!
//! [`Secret`] itself lives in [`super::super::secret`], where the launch environment can reach it
//! too: a type either of them owned would make one depend on the other.
//!
//! Every name a caller reached as `profile::X` before the split still resolves — [`super`]
//! re-exports it — and the methods stay inherent methods on [`Profile`].

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::super::config_edit;
use super::super::secret::Secret;
use super::scope::ConfigMode;
use super::{Profile, ProfileError};

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

impl Profile {
    pub fn credentials(&self) -> &Credentials {
        &self.credentials
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
                    reserved: None,
                });
            }
            if let Some(why) = reserved_name(name) {
                return Err(ProfileError::Credential {
                    name: name.to_string(),
                    reserved: Some(why),
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

    /// `pub(super)` rather than private, because the readout that calls it is [`super`]'s and an
    /// ancestor cannot see a child's private item — the parent's right to the answer is the right
    /// it had when this method sat in the same file as the readout.
    pub(super) fn credential_storage(&self) -> CredentialStorage {
        match self.fields.mode {
            ConfigMode::AppManaged => CredentialStorage::HostFile {
                path: self.credential_file(),
                mode: config_edit::DOCUMENT_MODE,
            },
            ConfigMode::UserConfig => CredentialStorage::None,
        }
    }
}

/// The credentials file, read as a name-to-value map.
///
/// A file that cannot be read is reported as an empty set rather than as a failure to open the
/// profile: the settings page has to be able to show the profile in order to let the user fix what
/// is wrong with it, and a secret that cannot be read is one that will not be injected — the safe
/// direction for every failure in this function.
pub(super) fn read_credentials(path: &Path) -> Credentials {
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

/// The names a credential may not use, with the reason, or `None` when the name is the user's to choose.
///
/// **This surface is reachable from the window, and what it writes becomes the engine's own
/// environment.** The names below are the ones that decide something other than *who the engine is*,
/// which is the only thing a credential is for (finding S5 in
/// `docs/audits/2026-09-21-code-review.md`):
///
/// - **What code runs.** `LD_*` and `DYLD_*` are read by the dynamic loader before the engine's
///   first instruction, and `NODE_OPTIONS`/`NODE_PATH` by its runtime before its first line — so a
///   value here is not a credential but code, executed as the user, chosen by a request the renderer
///   can make. `PATH`, `SHELL`, `ENV` and `IFS` are the same family: they decide which program a
///   bare command resolves to, or how a shell the engine starts reads its own words.
/// - **Where the engine reads and writes.** `HOME`, `XDG_*`, `OPENCODE_*`, `TMPDIR` and `PWD` are
///   the roots this host isolates the engine into. `environment.rs` records as *measured* that a
///   mis-set `OPENCODE_CONFIG_DIR` stops this app's shipped permission block from being applied —
///   i.e. this path can turn the consent gate off from a text field, which is the sharpest form of
///   the defect.
///
/// The second half of the fix is in `AgentRegistration::launch`: the host's isolation roots are
/// applied **last**, so a name that is not on this list still cannot move them. This list is the
/// part that says *why* the user is refused; the ordering is the part that does not depend on the
/// list being complete.
fn reserved_name(name: &str) -> Option<&'static str> {
    const EXACT: [(&str, &str); 9] = [
        (
            "PATH",
            "it decides which program a bare command resolves to",
        ),
        ("HOME", "the engine's configuration and state live under it"),
        ("PWD", "the engine resolves configuration against it"),
        ("SHELL", "a shell the engine starts reads it"),
        (
            "TMPDIR",
            "the engine's scratch files would land outside the profile",
        ),
        (
            "NODE_OPTIONS",
            "the engine's runtime reads it before its first line",
        ),
        (
            "NODE_PATH",
            "the engine's runtime resolves modules through it",
        ),
        (
            "IFS",
            "it changes how a shell the engine starts splits words",
        ),
        ("ENV", "a shell reads commands out of it at startup"),
    ];
    const PREFIXES: [(&str, &str); 4] = [
        (
            "LD_",
            "the dynamic loader reads it before the engine's first instruction",
        ),
        (
            "DYLD_",
            "the dynamic loader reads it before the engine's first instruction",
        ),
        (
            "XDG_",
            "the host sets the engine's configuration roots there",
        ),
        (
            "OPENCODE_",
            "the engine's own configuration namespace is set there",
        ),
    ];
    // Upper-cased first: the kernel treats `home` and `HOME` as one variable on this platform, and
    // under-refusing is the dangerous direction — the same argument `is_credential_name` makes for
    // redaction, one layer over.
    let upper = name.to_ascii_uppercase();
    if let Some((_, why)) = EXACT.iter().find(|(reserved, _)| *reserved == upper) {
        return Some(why);
    }
    PREFIXES
        .iter()
        .find(|(prefix, _)| upper.starts_with(prefix))
        .map(|(_, why)| *why)
}
