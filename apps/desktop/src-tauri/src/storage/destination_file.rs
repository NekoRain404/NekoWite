//! The file a publish replaces: the identity its replacement has to carry over
//! (the permission bits, and the owner and group where the platform allows), and
//! whether it may be replaced at all.
//!
//! A publish is a `rename` of a staged temp sibling, and a rename needs write
//! permission on the DIRECTORY and none at all on the file. That is why this
//! module exists: without it the file that appears under the user's name is the
//! STAGED temp file, which carries the temp file's mode, so a note the user had
//! set to `0444` (or `0600`, or `0640`) came back as the process default — and a
//! file they had deliberately made read-only was replaced without a word.
//!
//! Two separate answers, because they are two separate things:
//!
//!   * the mode always survives the publish. "the note the user set to 0600 is
//!     still 0600 after an edit" holds under any policy, and those bits belong
//!     to the file, not to the name it had. A name that was free is the one
//!     exception, and it legitimately gets the default every new file gets.
//!   * a read-only destination is NOT replaced. The bit is a deliberate act — an
//!     archive, a sync tool's marker, a permission the user chose — and the
//!     rename would walk straight past it, because the permission it needs is
//!     the directory's. The caller gets a refusal instead, which is the shape
//!     the read-only *directory* case already has: there the staged `create_new`
//!     fails and the save is reported as failed.
//!
//! Leaf module: paths, modes and filesystems, no vaults and no history keys.

use std::io;
use std::path::Path;

use crate::errors::fs_error;

/// A file a publish is about to replace: what has to survive it, read BEFORE the
/// rename — afterwards the file it describes is gone.
pub(crate) struct DestinationFile {
    /// Directories are not the read-only case. The rename already refuses them
    /// on its own terms ("that is a folder, not a file"), and reporting that as
    /// a read-only file would name it wrongly.
    is_file: bool,
    /// The permission bits as the user set them. Masked of the file-type bits
    /// `mode()` carries, which are not ours to re-apply.
    #[cfg(unix)]
    mode: u32,
    #[cfg(unix)]
    uid: u32,
    #[cfg(unix)]
    gid: u32,
    /// Everywhere else: the attributes the platform has, the read-only one
    /// among them.
    #[cfg(not(unix))]
    permissions: std::fs::Permissions,
}

/// Read what a publish would be replacing, or `None` when the name is free.
///
/// A failing stat is an error rather than a shrug. The alternative — "no
/// identity, publish anyway" — would replace the file with the staged temp
/// file's mode, which is the defect this module exists to prevent, and the
/// permission needed to stat a file is weaker than the one needed to rename over
/// it, so the case is not the unreachable one it looks like. A failed save with
/// the original untouched is the honest outcome.
pub(crate) fn inspect(path: &Path) -> Result<Option<DestinationFile>, String> {
    match std::fs::metadata(path) {
        Ok(meta) => Ok(Some(from_metadata(&meta))),
        // A free name has no mode to carry over: nothing is invented for it.
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(fs_error("inspect the file being replaced", path, e)),
    }
}

/// Refuse `path` if a publish would replace a file the user made read-only.
///
/// [`crate::storage::atomic_write`] enforces this at the publish and remains the
/// authority. The save pipelines call it EARLIER as well, because everything they
/// do before the publish is done for a write that is not going to happen: a
/// refused save would otherwise still read the old content and still spend a
/// history slot on it.
pub(crate) fn refuse_if_read_only(path: &Path) -> Result<(), String> {
    match inspect(path)? {
        Some(file) if file.is_read_only_file() => Err(file.refusal(path)),
        _ => Ok(()),
    }
}

#[cfg(unix)]
fn from_metadata(meta: &std::fs::Metadata) -> DestinationFile {
    use std::os::unix::fs::MetadataExt as _;
    DestinationFile {
        is_file: meta.is_file(),
        mode: meta.mode() & 0o7777,
        uid: meta.uid(),
        gid: meta.gid(),
    }
}

#[cfg(not(unix))]
fn from_metadata(meta: &std::fs::Metadata) -> DestinationFile {
    DestinationFile {
        is_file: meta.is_file(),
        permissions: meta.permissions(),
    }
}

impl DestinationFile {
    /// Whether the user (or a tool acting for them) said no: this file is not
    /// replaced, and the caller is told so.
    pub(crate) fn is_read_only_file(&self) -> bool {
        self.is_file && self.denies_writing()
    }

    /// No write bit at all, for anyone. A file that denies the OWNER but grants
    /// the group is deliberately not covered: that is a shared note, not a
    /// protected one, and every ordinary vault file (`0644`, `0664`, `0600`) —
    /// and a `0000` file, which the app cannot even read — has to keep behaving
    /// as it does for the first two.
    #[cfg(unix)]
    fn denies_writing(&self) -> bool {
        self.mode & 0o222 == 0
    }

    #[cfg(not(unix))]
    fn denies_writing(&self) -> bool {
        self.permissions.readonly()
    }

    /// Give the staged file this file's identity, BEFORE the rename.
    ///
    /// Before, not after: a failure after the rename could not be undone, and
    /// the window between the two would expose the real name carrying the temp
    /// file's mode — the very thing being fixed. Applied to the staged file, the
    /// publish either lands with the right mode or does not land at all, and the
    /// original is left byte for byte and mode for mode.
    pub(crate) fn carry_over_to(&self, staged: &Path) -> Result<(), String> {
        #[cfg(unix)]
        self.carry_over_unix(staged)?;
        #[cfg(not(unix))]
        self.carry_over_default(staged)?;
        Ok(())
    }

    #[cfg(unix)]
    fn carry_over_unix(&self, staged: &Path) -> Result<(), String> {
        // Ownership FIRST: `chown` clears the set-user/group-ID bits, so a mode
        // applied before it would be undone by it. Best-effort, because handing
        // a file to another user is a privileged act and a save that is
        // otherwise complete must not fail over one. It is worth the call all
        // the same: an editor running as root, or a write into a shared folder,
        // would otherwise silently re-own every note it touched.
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::os::unix::fs::chown(staged, Some(self.uid), Some(self.gid));
        std::fs::set_permissions(staged, std::fs::Permissions::from_mode(self.mode))
            .map_err(|e| fs_error("set the permissions on", staged, e))
    }

    #[cfg(not(unix))]
    fn carry_over_default(&self, staged: &Path) -> Result<(), String> {
        // The read-only attribute is the whole of the mode `Permissions` carries
        // on this platform, and the same call copies it.
        std::fs::set_permissions(staged, self.permissions.clone())
            .map_err(|e| fs_error("set the permissions on", staged, e))
    }

    /// The refusal, phrased for the user: what was refused, that their file is
    /// still there, and the one thing that unblocks the save.
    pub(crate) fn refusal(&self, path: &Path) -> String {
        format!(
            "could not replace {}: the file is read-only{}, so it was left untouched; \
             clear the read-only permission to save over it, or save it under a different name",
            crate::domain::path_policy::ipc_path(path),
            self.mode_detail(),
        )
    }

    /// The bits themselves, which are the actionable part of the refusal on a
    /// platform whose modes the user can be looking at in another window.
    #[cfg(unix)]
    fn mode_detail(&self) -> String {
        format!(" (mode {:04o})", self.mode)
    }

    #[cfg(not(unix))]
    fn mode_detail(&self) -> String {
        String::new()
    }
}
