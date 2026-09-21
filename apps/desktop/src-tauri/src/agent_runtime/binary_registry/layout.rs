//! `binary_registry`'s child: where the app's engine files live, and which roots are refused.
//!
//! Split out of `binary_registry.rs` when it passed §13.1's 600-line default (docs/dev.md §5.4.2:
//! 超过 600 行应默认进入拆分 backlog). The seam is "changes when the layout, or a place this app may
//! not write to, changes": the directory names §3.2 draws, the pointer file's name, the program's
//! name inside a release directory, the roots §3.3 forbids, and the write that holds a staged
//! candidate at 0o600 until verification makes it a program.
//!
//! What is *at* one of these paths — an execute bit, a digest, an ELF header — is `elf.rs`'s and
//! `releases.rs`'s. *When* a retained tree may be put back is the update path's decision. This file
//! answers only where the paths are and which of them this host is allowed to name.

use std::fs;
use std::path::{Path, PathBuf};

/// The directory §3.2 puts the runtime's own files in, under the app's data directory.
pub const RUNTIME_DIR: &str = "agent-runtime";
/// One directory per verified version.
pub const RELEASES_DIR: &str = "releases";
/// Where a download waits until it has passed (§3.2: 未验证文件不得执行).
pub const DOWNLOADS_DIR: &str = "downloads";
/// Where the managed roots of profiles live (T12 owns what goes in them).
pub const PROFILES_DIR: &str = "agent-profiles";
/// Where retained material lives, scoped and stamped.
pub const RECOVERY_DIR: &str = "agent-recovery";
/// The pointer file's name, as §3.2 draws it.
pub const POINTER_FILE: &str = "active.json";

/// The program's name inside a release directory, and beside the app's own executable.
///
/// One name for both because that is what the bundler produces: Tauri's `copy_binaries` strips the
/// `-<target>` suffix it added at build time, so the installed sidecar is `usr/bin/opencode` next
/// to `usr/bin/nekowite` — the same bare name this module installs a verified version under.
pub const PROGRAM_NAME: &str = "opencode";

/// Where a managed root may not be (§3.3: 不执行 `sudo`，不写 AppImage 挂载目录或系统包目录).
///
/// Held as paths rather than as a rule about permissions: the app's own data directory is what
/// `BinaryRegistry::new` is for, and a root inside any of these is a request to write where the
/// distribution or the mounted image owns the files.
const SYSTEM_PREFIXES: [&str; 9] = [
    "/usr", "/etc", "/opt", "/var", "/bin", "/sbin", "/lib", "/lib64", "/boot",
];

/// Where an AppImage mounts itself. Matching the prefix rather than the exact spelling keeps this
/// from depending on the image's name; the mount is read-only anyway, so anything under it is a
/// path the app could never write to and must never try (`sudo` is not a fallback, §3.3).
const APPIMAGE_MOUNT_PREFIX: &str = "/tmp/.mount_";

/// Why a path in the managed layout was refused. Data only — the wording a user reads belongs to
/// the frontend, which maps these to sentences the same way it maps `registry::RegistryError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LayoutError {
    /// A root that is not absolute would resolve against this process's working directory — the
    /// app's, not the user's — so it names nothing that can be reasoned about.
    Relative { root: PathBuf },
    /// A root the app does not own (§3.3): a system directory, or an AppImage mount point.
    OutsideManagedScope { root: PathBuf, reason: &'static str },
    /// A version or target this release does not install for.
    UnsupportedTarget { target: String },
    /// A name that cannot be a path component: empty, `.`, `..`, or carrying a separator. §3.2 puts
    /// profile ids and versions into directory names, so this is a path traversal dressed as
    /// configuration.
    InvalidName { field: &'static str, value: String },
    /// The version named is not on disk, so there is nothing to point at.
    NotInstalled { version: String, program: PathBuf },
    /// The pointer file is there and unreadable as a pointer.
    MalformedPointer { path: PathBuf, detail: String },
    /// The filesystem said no.
    Io { path: PathBuf, detail: String },
}

/// Refuses a root the app does not own (§3.3).
///
/// `pub(super)`, and it was private before the split: a child module's private item is not reachable
/// from the module it was split out of (E0603), and `BinaryRegistry::new` is the one caller — so
/// `pub(super)` is `binary_registry` and its descendants, the reach this had as a private item of
/// `binary_registry.rs`, and the narrowest scope that compiles.
pub(super) fn assert_scope(root: &Path) -> Result<(), LayoutError> {
    if !root.is_absolute() {
        return Err(LayoutError::Relative {
            root: root.to_path_buf(),
        });
    }
    for prefix in SYSTEM_PREFIXES {
        if root.starts_with(prefix) {
            return Err(LayoutError::OutsideManagedScope {
                root: root.to_path_buf(),
                reason:
                    "the distribution owns this directory, and this host never installs into a \
                         system package directory",
            });
        }
    }
    // A string comparison rather than `Path::starts_with`, which compares whole components: an
    // AppImage's mount directory is named `.mount_<something random>`, so the component after `/tmp`
    // is exactly the part that varies.
    if root.to_string_lossy().starts_with(APPIMAGE_MOUNT_PREFIX) {
        return Err(LayoutError::OutsideManagedScope {
            root: root.to_path_buf(),
            reason: "this is an AppImage mount point, which is a read-only location for the image \
                     and not a place to write",
        });
    }
    // The app's data directory is what Tauri resolves for it, and that is always below the user's
    // home, a corporate profile or a distribution's own data root — never a bare top-level
    // directory. A root one level under `/` is a configuration mistake that would scatter releases,
    // profiles and recovery material across the filesystem, so it is refused where an operator can
    // see the refusal rather than where the first write happens.
    if root.parent().is_none_or(|parent| parent == Path::new("/")) {
        return Err(LayoutError::OutsideManagedScope {
            root: root.to_path_buf(),
            reason: "the agent runtime's data belongs under the app's own data directory, not at \
                     the root of the filesystem",
        });
    }
    Ok(())
}

/// Whether a name can be a path component.
///
/// The same charset `registry.rs` uses for its ids, and duplicated rather than shared because the
/// two answer different questions about different namespaces — this one is about versions and
/// targets, which come from the release flow, and that one is about agent, profile and vault ids,
/// which come from a form.
///
/// `pub(super)` for the reason `assert_scope` gives above: `BinaryRegistry::set_active` and `::stage`
/// are the callers, and nothing outside `binary_registry` may turn a version string into a path
/// component.
pub(super) fn validate_component(field: &'static str, value: &str) -> Result<(), LayoutError> {
    let usable = !value.is_empty()
        && value.len() <= 64
        && value != "."
        && value != ".."
        && !value.starts_with('.')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if usable {
        Ok(())
    } else {
        Err(LayoutError::InvalidName {
            field,
            value: value.to_string(),
        })
    }
}

/// Writes bytes readable and writable by the user and executable by nobody.
///
/// `pub(super)` for the reason `assert_scope` gives above, and because the mode is a contract rather
/// than a preference: `BinaryRegistry::stage` is the one caller, and §3.2's 未验证文件不得执行 is what
/// the 0o600 and the absent execute bit enforce.
pub(super) fn write_private(path: &Path, bytes: &[u8]) -> Result<(), LayoutError> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut file = fs::OpenOptions::new()
        .write(true)
        // `create_new` rather than `create`: a staged candidate is never written over, so a name
        // that is already taken is a name this call did not produce, and the caller learns that
        // rather than getting a file it did not ask for.
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| LayoutError::Io {
            path: path.to_path_buf(),
            detail: error.to_string(),
        })?;
    file.write_all(bytes).map_err(|error| LayoutError::Io {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| LayoutError::Io {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })
}

/// A file's permission bits.
pub fn mode_of(path: &Path) -> Result<u32, LayoutError> {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|meta| meta.permissions().mode())
        .map_err(|error| LayoutError::Io {
            path: path.to_path_buf(),
            detail: error.to_string(),
        })
}
