//! `binary_registry`'s child: what a release is, and how two of them order.
//!
//! Split out of `binary_registry.rs` when it passed §13.1's 600-line default (docs/dev.md §5.4.2:
//! 超过 600 行应默认进入拆分 backlog). The seam is "changes when what a release *is*, or how two
//! versions compare, changes": the pointer's record, the program the settings page reports, the
//! order `1.18.10` and `1.18.9` are put in, and the retained-tree operations a rollback runs —
//! including the one rule they exist for, that a tree is recreated link by link and never followed.
//!
//! Where those trees live is `layout.rs`'s; whether a candidate may replace one is `update`'s.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::super::registry::InstallSource;

use super::layout::PROGRAM_NAME;
use super::platform::SUPPORTED_TARGET;

/// Which release is active — §3.2's `active.json`, field for field.
///
/// `previous` is kept because a rollback is a normal operation (§3.3) rather than a recovery: it
/// names where the pointer was, so returning to it is a decision about a version the app knows
/// rather than a guess at the file system's contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveRelease {
    pub version: String,
    pub target: String,
    #[serde(default)]
    pub previous: Option<String>,
}

/// One program this app could start, as the settings page reports it (§3.1.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Program {
    pub path: PathBuf,
    /// The version the app's own record names for it. `None` for the bundled sidecar, whose version
    /// is the release manifest's fact (`update::shipped`) rather than a directory name.
    pub version: Option<String>,
    pub source: InstallSource,
}

/// The packaged engine, from the directory the host resolved for the app's own executable.
///
/// §3.2 resolves the sidecar through Tauri rather than through a development path, and Tauri has two
/// spellings for what it produced: the installed bundle carries the bare name (`copy_binaries`
/// strips the `-<target>` suffix the build input needs, which is why the artifact on disk ends in
/// `-x86_64-unknown-linux-gnu` and the one in the package does not), and a build tree can still have
/// the suffixed one beside the binary. Both are checked here; neither is searched for on `PATH`,
/// because §3.1.1 is that the user has this engine whether or not they have one of their own.
pub fn bundled_program(directory: &Path) -> Option<Program> {
    let candidates = [
        directory.join(PROGRAM_NAME),
        directory.join(format!("{PROGRAM_NAME}-{SUPPORTED_TARGET}")),
    ];
    candidates
        .into_iter()
        .find(|path| is_launchable(path))
        .map(|path| Program {
            path,
            version: None,
            source: InstallSource::Bundled,
        })
}

/// Whether a path is a file someone could run. `fs::metadata` follows symlinks, so a link to an
/// executable counts — which is what a distribution that ships one under `/usr/bin` looks like.
///
/// `pub(super)`, and it was private before the split: a child module's private item is not reachable
/// from the module it was split out of (E0603), and the callers are `bundled_program` here plus
/// `BinaryRegistry::installed`, `::set_active` and `::active_program` — so `pub(super)` is
/// `binary_registry` and its descendants, the reach this had as a private item, and nothing outside
/// the module decides for itself whether a path could run.
pub(super) fn is_launchable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

// ---------------------------------------------------------------------------
// The layout's own file operations
// ---------------------------------------------------------------------------
//
// These belong here rather than with the update policy that calls them for the same reason the paths
// do: they are statements about §3.2's directories — a profile tree, the recovery area beside it —
// and the rules they keep (links are recreated and never followed, a tree that cannot be read is not
// a tree, the replaced tree is kept) are rules about where this app is allowed to write. *When* one
// of them may run is the update path's decision; *what it does to the filesystem* is this module's.

/// Whether `candidate` is a later version than `base`.
///
/// Component-wise and numeric, because the comparison decides whether a rollback crosses a data
/// migration: `1.18.10` is newer than `1.18.9`, which string comparison gets backwards. A component
/// that is not a number reads as zero, which treats an unparseable version as the oldest rather than
/// as a newer one — the direction that asks for confirmation instead of assuming it is safe.
pub fn is_newer(candidate: &str, base: &str) -> bool {
    version_key(candidate).cmp(&version_key(base)) == std::cmp::Ordering::Greater
}

/// A version as its numeric components.
///
/// The key everything that orders versions compares, so `is_newer` and `installed` can never
/// disagree about which of two versions is the later one.
///
/// `pub(super)` for the reason [`is_launchable`] gives above: `is_newer` and `BinaryRegistry::installed`
/// are the two callers, and one key for both is what keeps them from disagreeing.
pub(super) fn version_key(version: &str) -> Vec<u64> {
    version
        .split(['.', '-', '+'])
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

/// Whether a directory holds something that can be put back in place of a profile.
///
/// Deliberately shallow. This host does not know the engine's own store format — §3.3's 报告限制 is
/// exactly about that — so what it can answer is "there is a tree here to restore", not "this backup
/// is a valid engine store". The stronger claim is left unsaid rather than implied.
pub fn is_restorable(path: &Path) -> bool {
    fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_some())
}

/// Copies a tree, keeping modes and links.
///
/// Symlinks are recreated rather than followed: a link inside a profile that points out of it would
/// otherwise make the copy write outside the managed roots this module is confined to.
pub fn retain_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(from).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            let link = fs::read_link(&source).map_err(|error| error.to_string())?;
            std::os::unix::fs::symlink(link, &target).map_err(|error| error.to_string())?;
        } else if metadata.is_dir() {
            retain_tree(&source, &target)?;
        } else {
            // `fs::copy` carries the mode across, which matters for a profile whose files include
            // anything the user made read-only.
            fs::copy(&source, &target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Puts `backup` in place of `root`, in the order that cannot lose the old one.
///
/// The backup is copied into a staging directory beside the profile first, so a copy that fails
/// partway leaves the profile alone; only then is the live profile moved aside and the staged copy
/// moved in. If that last move fails, the first move is undone and the caller is told. What was moved
/// aside ends up under `recovery` rather than being deleted: the retained copy beside it is the same
/// data, and keeping both costs disk while deleting either could cost a session.
pub fn restore_tree(root: &Path, backup: &Path, recovery: &Path) -> Result<(), String> {
    let parent = root.parent().ok_or("the profile root has no parent")?;
    let staging = parent.join(format!(".restore-{}", stamp()));
    let moved_aside = recovery.join(format!("{}-replaced", stamp()));
    let outcome = (|| -> Result<(), String> {
        retain_tree(backup, &staging)?;
        if root.exists() {
            fs::create_dir_all(recovery).map_err(|error| error.to_string())?;
            fs::rename(root, &moved_aside).map_err(|error| error.to_string())?;
        }
        match fs::rename(&staging, root) {
            Ok(()) => Ok(()),
            Err(error) => {
                if moved_aside.exists() {
                    let _ = fs::rename(&moved_aside, root);
                }
                Err(error.to_string())
            }
        }
    })();
    if outcome.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    outcome
}

/// A name for one retained copy, unique per process and per moment.
///
/// `pub(super)` for the reason [`is_launchable`] gives above: `restore_tree` here and
/// `BinaryRegistry::retained_path` both name a retained copy with it, and nothing outside
/// `binary_registry` may mint a name this process could collide with.
pub(super) fn stamp() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default();
    format!(
        "{millis}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}
