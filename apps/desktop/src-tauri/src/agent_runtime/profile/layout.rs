//! Where a profile's files are: the directory every root sits under, the files this host keeps
//! inside one, and the rule that decides whether a string may name a place inside it at all.
//!
//! **Why it is a file of its own.** `docs/dev.md:286` puts the budget for a business source file at
//! 600 lines, and [`super`] was 1027. The split is by *reason to change*, which is the criterion
//! that section states rather than the line count: this module moves when the *layout* moves — a
//! file this host keeps in a profile root, the mode a root is created with, the question of whether
//! an id or a relative path is one path component — while [`super`] moves when the profile's record,
//! its store or its readout does. Nothing here reads a record, a credential or the engine's own
//! configuration, so none of the reasons the other children of [`super`] change can reach it.
//!
//! **The security boundary lives here, in both of its halves.** A profile id arrives from the
//! renderer and becomes a directory name ([`ProfileStore::root_of`]); a document path arrives from
//! the settings editor and becomes a path under that directory ([`Profile::document_path`]). Both
//! are answered by asking the path parser rather than by normalizing, and both refuse rather than
//! repair: a value that could leave the managed root is a defect in the caller, and a path rule that
//! changes shape is a defect rather than a refactor. Keeping both answers in one file is what makes
//! that visible — they are one question asked at two entry points.
//!
//! Every name a caller outside this directory reached as `profile::X` before the split still does:
//! [`super`] re-exports the constants, and the two methods stay inherent methods on their types.

use std::fs;
use std::path::{Component, Path, PathBuf};

use super::{Profile, ProfileError, ProfileStore};

/// The directory every profile root sits under, inside the app's managed directory (§3.2).
pub const PROFILES_DIR: &str = "agent-profiles";

/// The record this host keeps about a profile, inside the profile's own root.
pub const RECORD_FILE: &str = "profile.json";

/// The credentials this host injects, inside the profile's own root.
pub const CREDENTIALS_FILE: &str = "credentials.json";

/// The mode a profile root is created with: owner only, since the engine's own files land in it.
pub const PROFILE_ROOT_MODE: u32 = 0o700;

impl ProfileStore {
    /// Where one profile's files are, whether or not the profile exists yet.
    pub fn root_of(&self, profile_id: &str) -> Result<PathBuf, ProfileError> {
        if !is_single_component(profile_id) {
            return Err(ProfileError::Id {
                profile_id: profile_id.to_string(),
            });
        }
        Ok(self.managed.join(PROFILES_DIR).join(profile_id))
    }
}

impl Profile {
    /// The directory to hand `AgentRegistry::start` as its managed root.
    ///
    /// It is exactly what §8.1's profile-isolated mode points `HOME` and the XDG roots into, so the
    /// engine's configuration, credentials and sessions land in this profile and in no other.
    pub fn root(&self) -> &Path {
        &self.root
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
}

/// The directory a profile root sits in, made with [`PROFILE_ROOT_MODE`].
///
/// The mode is set when the root is *created*; a root that already exists keeps what it has, which
/// is safe because what protects a credential is the file's own 0600 — a readable directory does
/// not make an unreadable file readable.
pub(super) fn create_root(root: &Path) -> Result<(), ProfileError> {
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

/// Whether an id can be one path component and nothing else.
///
/// Deliberately *not* the charset `registry.rs` applies to an identity: what matters here is only
/// that the value cannot leave the managed root or name something other than itself, and
/// `Component::Normal` is that question asked of the path parser instead of a list of letters.
pub(super) fn is_single_component(id: &str) -> bool {
    let mut parts = Path::new(id).components();
    matches!(parts.next(), Some(Component::Normal(_))) && parts.next().is_none()
}
