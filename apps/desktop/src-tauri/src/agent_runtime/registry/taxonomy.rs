//! The small closed vocabularies a registration is described with: where its program came from,
//! who may replace that program, what its environment is built from, and what its path was at the
//! moment it was asked.
//!
//! A module of its own rather than a section of [`super`], and the split is by what makes each part
//! change. These four move together and for one reason: they are the *words* the settings page and
//! the registry have to agree on, so a new arm or a new spelling is a change to what a caller
//! outside this module receives, and to nothing about how a definition is validated, stored or
//! launched. Each `id` is the wire spelling for the reason [`InstallSource::id`] gives, which is
//! why a rename is a change here rather than anywhere the value is used.

/// Where a registration's program came from (§3.4's install-source row).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallSource {
    /// Shipped in the app package; the default engine's source.
    Bundled,
    /// Installed by this host into its own data directory (§3.2).
    Managed,
    /// The user's own installation; §3.4.6 leaves it alone.
    External,
}

/// Who may replace a program, decided by where it came from — a method, not a stored
/// field, so an `External` registration cannot claim a host-managed policy and describe
/// an app that swaps a binary out from under the user's own installation (§3.4.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdatePolicy {
    /// The host may fetch a new artifact and switch the pointer (T14).
    HostManaged,
    /// The host may report that a newer version exists, and nothing else.
    ReportedOnly,
}

impl InstallSource {
    pub fn update_policy(self) -> UpdatePolicy {
        match self {
            InstallSource::Bundled | InstallSource::Managed => UpdatePolicy::HostManaged,
            InstallSource::External => UpdatePolicy::ReportedOnly,
        }
    }

    /// The spelling the settings page receives, for the reason [`ConfigMode::id`] gives: one
    /// vocabulary for one value, so the renderer never maps a name this module invented.
    ///
    /// [`ConfigMode::id`]: super::super::profile::ConfigMode::id
    pub fn id(self) -> &'static str {
        match self {
            InstallSource::Bundled => "bundled",
            InstallSource::Managed => "managed",
            InstallSource::External => "external",
        }
    }
}

/// What an engine's environment is built from: the engine inherits this process's
/// environment (the SDK's `envs` adds to it; nothing clears it), so the policy is about
/// *roots*, which are what make an engine read and write the profile this app owns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvPolicy {
    /// `HOME` and the XDG roots point into §3.2's `agent-profiles/<profile-id>/`, so
    /// config, credentials and sessions stay in a profile this app owns — and a second
    /// engine gets a different one.
    ProfileIsolated,
    /// Nothing is injected: an external installation keeps its own credentials (§3.1).
    UserEnvironment,
}

impl EnvPolicy {
    /// The spelling the settings page receives — see [`InstallSource::id`].
    pub fn id(self) -> &'static str {
        match self {
            EnvPolicy::ProfileIsolated => "profile-isolated",
            EnvPolicy::UserEnvironment => "user-environment",
        }
    }
}

/// What a registration's program path is, as of the moment it was asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgramState {
    /// A file with an executable bit, at one instant.
    Launchable,
    /// A relative path, refused rather than resolved against this process's working
    /// directory — the app's, not the user's — where a bare `opencode` would resolve to
    /// something nobody intended, or to nothing.
    NotAbsolute,
    /// No file there now. It may have been there when the registration was written, which
    /// is why deletion is not the answer — the definition stands, the diagnostic reports.
    Missing,
    /// Something is there and it is not a file (a directory, a device).
    NotAFile,
    /// A file with no executable bit for anyone.
    NotExecutable,
}

impl ProgramState {
    /// The spelling the settings page receives — see [`InstallSource::id`]. The five states stay
    /// five answers on the wire for the reason they are five here: the user's next move differs for
    /// each, and a page given "not launchable" could not say which one to make.
    pub fn id(self) -> &'static str {
        match self {
            ProgramState::Launchable => "launchable",
            ProgramState::NotAbsolute => "not-absolute",
            ProgramState::Missing => "missing",
            ProgramState::NotAFile => "not-a-file",
            ProgramState::NotExecutable => "not-executable",
        }
    }
}
