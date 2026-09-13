//! Atomic file primitives: the crate's write lock, temp-file staging, the
//! fsync-then-rename pipeline and the create-only / no-clobber publish
//! operations.
//!
//! This is the leaf of the storage split (roadmap 10.4 step 1): it knows about
//! paths and filesystems and nothing about vaults, history keys or attachment
//! names, so every other storage module may depend on it and it depends on none
//! of them.
//!
//! [`write_lock`] is the crate's ONLY write lock. Everything that must not
//! interleave with a save holds it - the saves themselves, the create-only
//! writes, the history restore and the rename - and it is handed out from here
//! rather than copied into each module. A second `Mutex` anywhere would look
//! self-consistent inside its own module and still let two writers snapshot
//! each other's predecessor, which is a silent data-loss failure no
//! single-module test can see.

use std::io;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::errors::fs_error;

/// Nanosecond clock reading used to make temp file names unique.
pub(crate) fn time_nonce() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
}

/// Serializes the read-old -> snapshot -> atomic-write sequence for every
/// `write_file`/`create_new_file` call in THIS PROCESS - across all vaults.
///
/// The guarantee it actually provides: while one save holds it, no other save
/// can be between its read-old and its atomic rename, so no writer can
/// snapshot a predecessor that another writer is in the middle of replacing.
/// Two things about the scope are easy to get wrong and are stated here on
/// purpose:
///
///   * It is process-wide, not per-vault, and stays that way until a narrower
///     scheme is proven safe. Vaults can nest (a folder inside another opened
///     folder is addressable through both roots), so two writes that look
///     like different vaults can target the same file; and a per-vault map
///     would need canonical key normalisation to agree on case and separator
///     spellings across platforms. Getting that wrong loses snapshot-chain
///     ordering - a silent data-loss failure - while cross-vault waiting is
///     unobservable (saves are user-paced and the critical section is a few
///     file operations).
///   * It covers `write_file`/`create_new_file`/`restore_history` and
///     `rename_entry`. Direct `snapshot_history` calls do not hold it, so the
///     snapshot chain is not protected against those paths; do not read this
///     as more than it is.
///   * `rename_entry` holds it because a save that resolved the old path just
///     before the move would otherwise publish its temp file at the path the
///     rename vacated — an untracked copy at the old name, after the history
///     and trash keys had already moved to the new one.
///
/// `write_lock_scope_tests` pins the process-wide scope, so narrowing it means
/// deliberately updating that test and the reasoning above.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// The crate's one write lock (see the comment on `WRITE_LOCK` above).
///
/// Handed out as a reference instead of being re-declared per module: the
/// guarantee is that the saves, the restores and the rename all wait on the
/// SAME mutex, so it must have exactly one definition. Callers phrase a
/// poisoned lock as `e.to_string()`; the scope tests recover the guard with
/// `unwrap_or_else(|e| e.into_inner())` because they hold it deliberately.
pub(crate) fn write_lock() -> &'static Mutex<()> {
    &WRITE_LOCK
}

/// How old a `.tmp` sibling must be before the next write in that directory
/// treats it as crash litter and cleans it up. Fresh temp files written by a
/// currently-running writer (unique nonce name, recent mtime) are never
/// touched, so cleaning cannot race a live write.
pub(crate) const STALE_TMP_MAX_AGE: Duration = Duration::from_secs(3600);

/// Write `content` to `resolved` atomically: write a temp sibling
/// (`.<name>.<nonce>.tmp`) in the same directory, fsync it, then rename over
/// the target, and fsync the parent directory so the rename itself survives
/// power loss. On any failure the temp file is removed so no partial file is
/// left behind. Mirrors Memoir's `atomic.rs`.
pub fn atomic_write(resolved: &Path, content: &str) -> Result<(), String> {
    atomic_write_bytes(resolved, content.as_bytes())
}

/// Byte-level twin of [`atomic_write`] for binary attachment payloads; the
/// temp-sibling, fsync and rename pipeline is identical.
pub fn atomic_write_bytes(resolved: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = resolved
        .parent()
        .ok_or_else(|| "target path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|e| fs_error("create the folder containing", parent, e))?;
    let name = resolved
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp = parent.join(format!(".{name}.{}.tmp", time_nonce()));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| fs_error("create the temporary file", &tmp, e))?;
        f.write_all(bytes)
            .map_err(|e| fs_error("write the temporary file", &tmp, e))?;
        f.sync_all()
            .map_err(|e| fs_error("flush the temporary file", &tmp, e))?;
        std::fs::rename(&tmp, resolved).map_err(|e| fs_error("replace", resolved, e))?;
        sync_parent_dir(resolved)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// fsync the directory containing `path` so a completed rename/link is
/// durable across power loss. Opening a directory read-only and syncing it
/// is the portable unix way to flush its entry list; the extra `O_DIRECTORY`
/// flag is only a fail-fast hint and would need a libc dependency, so it is
/// not set. On other platforms there is nothing to do.
#[cfg(unix)]
pub(crate) fn sync_parent_dir(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "target path has no parent directory".to_string())?;
    let dir = std::fs::File::open(parent)
        .map_err(|e| fs_error("open the folder containing", parent, e))?;
    dir.sync_all()
        .map_err(|e| fs_error("flush the folder containing", parent, e))
}

#[cfg(not(unix))]
pub(crate) fn sync_parent_dir(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// True when the error means "this filesystem cannot do that", the shape
/// Windows reports for `CreateHardLinkW` on FAT/exFAT (`ERROR_INVALID_FUNCTION`)
/// and the one Linux reports for filesystems that do not implement links.
pub(crate) fn is_link_unsupported(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::Unsupported | io::ErrorKind::InvalidInput
    ) || e.raw_os_error() == Some(1) // EPERM on some network shares
}

/// Copy `from` to `to`, refusing an existing `to` and never exposing a partial
/// file under the destination name.
pub(crate) fn copy_new(from: &Path, to: &Path) -> io::Result<()> {
    let mut src = std::fs::File::open(from)?;
    let mut dst = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)?;
    let copied = (|| {
        io::copy(&mut src, &mut dst)?;
        dst.sync_all()?;
        Ok(())
    })();
    if copied.is_err() {
        // Close before removing — Windows refuses to delete an open file — and
        // then drop the half-written snapshot. It was created under the real
        // `create_new` name, so leaving it behind would present a truncated
        // file as a valid version to every later list and restore (the same
        // reason `atomic_write` removes its temp file on failure).
        drop(dst);
        let _ = std::fs::remove_file(to);
    }
    copied
}

/// Whether `name` matches the temp-file shape this crate writes:
/// `.<original name>.<nanosecond nonce>.tmp`.
///
/// The leading dot keeps these out of the file tree and the numeric nonce
/// distinguishes them from a file a user or another tool named `*.tmp`. Both
/// parts matter: the dot alone would still claim `.gitignore.tmp`-style names
/// that are not ours, and the suffix alone (what this used to check) claimed
/// every `.tmp` file in the vault.
fn is_our_temp_file(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('.') else {
        return false;
    };
    let Some(rest) = rest.strip_suffix(".tmp") else {
        return false;
    };
    // `.<nonce>.tmp` (happens for a nameless source) or `.<name>.<nonce>.tmp`.
    match rest.rsplit_once('.') {
        Some((_, nonce)) => !nonce.is_empty() && nonce.bytes().all(|b| b.is_ascii_digit()),
        None => !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()),
    }
}

/// Remove `.tmp` siblings in `dir` whose modified time is older than
/// `max_age`, returning how many were removed. These are crash remnants of
/// [`atomic_write`]/[`crate::storage::metadata_store::snapshot_history`] (which
/// write a `.<name>.<nonce>.tmp` sibling then rename it into place); on a crash
/// the temp file survives. Cleaning is bounded to mtime so a temp file a live
/// writer just created (fresh mtime, unique nonce name) is never deleted
/// mid-write.
pub fn cleanup_stale_tmp(dir: &Path, max_age: Duration) -> Result<usize, String> {
    let now = SystemTime::now();
    let rd = std::fs::read_dir(dir).map_err(|e| fs_error("read the folder", dir, e))?;
    let mut removed = 0usize;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            continue;
        }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        // Only OUR temp files: `atomic_write` and `snapshot_history` stage
        // `.<original>.<nanosecond-nonce>.tmp` — hidden, with a numeric nonce as
        // the final stem segment. Matching any `.tmp` suffix instead deleted
        // whatever the user (or another program) happened to leave in the vault
        // with that extension: a `draft.tmp` in a note's folder was removed by
        // the next save in that folder, permanently — not to the trash, and with
        // no history snapshot to recover from. Vaults routinely hold project
        // files (that is why `node_modules`/`dist` are skipped), so this is a
        // real document, not litter.
        if !is_our_temp_file(name) {
            continue;
        }
        let stale = p
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|mt| now.duration_since(mt).ok())
            .map(|age| age > max_age)
            .unwrap_or(false);
        if stale && std::fs::remove_file(&p).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Why a create-only write failed.
pub(crate) enum CreateFileError {
    /// The destination name is taken. This is the ordinary outcome of a
    /// create-only write that raced another writer, which callers handle by
    /// choosing the next name rather than by reporting an OS error.
    AlreadyExists,
    /// Everything else, already phrased for the user.
    Failed(String),
}

/// Create `resolved` with `bytes`, refusing to replace anything already there,
/// and report a taken name as [`CreateFileError::AlreadyExists`].
///
/// The bytes are staged in a unique temp sibling and fsynced, then published
/// with a hard link, which either creates the name or fails with
/// `AlreadyExists`. That makes "is this name free?" and "write it" ONE step: a
/// file that appears in between (another instance of the app, a sync client,
/// the user) is never overwritten, and no reader sees a half-written file under
/// the real name. Filesystems without hard links (FAT32/exFAT) fall back to a
/// create-new copy, which refuses an existing destination just the same.
pub(crate) fn create_new_bytes(resolved: &Path, bytes: &[u8]) -> Result<(), CreateFileError> {
    let parent = resolved.parent().ok_or_else(|| {
        CreateFileError::Failed(format!(
            "cannot create {}: it has no parent folder",
            crate::domain::path_policy::ipc_path(resolved)
        ))
    })?;
    std::fs::create_dir_all(parent)
        .map_err(|e| CreateFileError::Failed(fs_error("create the folder", parent, e)))?;

    let name = resolved
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp = parent.join(format!(".{name}.{}.tmp", time_nonce()));
    let staged = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| fs_error("create the temporary file", &tmp, e))?;
        f.write_all(bytes)
            .map_err(|e| fs_error("write the temporary file", &tmp, e))?;
        f.sync_all()
            .map_err(|e| fs_error("flush the temporary file", &tmp, e))
    })();
    if let Err(message) = staged {
        let _ = std::fs::remove_file(&tmp);
        return Err(CreateFileError::Failed(message));
    }

    let published = match std::fs::hard_link(&tmp, resolved) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(CreateFileError::AlreadyExists),
        Err(e) if is_link_unsupported(&e) => copy_new(&tmp, resolved).map_err(|e| {
            if e.kind() == io::ErrorKind::AlreadyExists {
                CreateFileError::AlreadyExists
            } else {
                CreateFileError::Failed(fs_error("create", resolved, e))
            }
        }),
        Err(e) => Err(CreateFileError::Failed(fs_error("create", resolved, e))),
    };
    let _ = std::fs::remove_file(&tmp);
    published?;
    sync_parent_dir(resolved).map_err(CreateFileError::Failed)
}

/// Move `from` to `to` without ever replacing an existing `to`.
///
/// `fs::rename` REPLACES its destination, so a name claimed between "is it
/// free?" and the rename is silently destroyed. For a file the move is a hard
/// link — which either creates the name or fails with `AlreadyExists` — followed
/// by removing the source: the same inode, so the result is indistinguishable
/// from a rename. Filesystems without hard links fall back to a create-new copy,
/// which refuses an existing destination just the same.
pub(crate) fn move_no_clobber(from: &Path, to: &Path) -> io::Result<()> {
    if from.is_dir() {
        // A directory has no portable no-clobber move: `rename` replaces an
        // EMPTY destination directory on unix and fails on Windows, and claiming
        // the name with `create_dir` first would make the move non-atomic (a
        // crash in between strands an empty directory under the user's name).
        // The check stays best-effort and the move stays one atomic rename; a
        // FILE at the destination is still refused by the rename itself.
        if to.exists() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "the destination already exists",
            ));
        }
        return std::fs::rename(from, to);
    }
    match std::fs::hard_link(from, to) {
        Ok(()) => std::fs::remove_file(from),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(e),
        Err(e) if is_link_unsupported(&e) => {
            copy_new(from, to)?;
            std::fs::remove_file(from)
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod no_clobber_move_tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nekowite-attach-{label}-{}-{}",
            std::process::id(),
            time_nonce()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The same guarantee for the move: `fs::rename` replaces the destination,
    /// `move_no_clobber` must not.
    #[test]
    #[cfg(unix)]
    fn move_no_clobber_never_replaces_the_entry_at_the_destination() {
        let dir = scratch("move");
        let source = dir.join("from.md");
        let taken = dir.join("to.md");
        std::fs::write(&source, "source").unwrap();
        std::fs::write(&taken, "occupant").unwrap();

        assert!(
            move_no_clobber(&source, &taken).is_err(),
            "an existing file must not be replaced"
        );
        assert_eq!(std::fs::read_to_string(&taken).unwrap(), "occupant");
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "source");

        // An entry that only `exists()` can see through: a dangling symlink.
        let linked = dir.join("linked.md");
        std::os::unix::fs::symlink(dir.join("missing.md"), &linked).unwrap();
        assert!(
            move_no_clobber(&source, &linked).is_err(),
            "a dead symlink still holds the name"
        );
        assert!(std::fs::symlink_metadata(&linked)
            .unwrap()
            .file_type()
            .is_symlink());

        // A free destination still moves, and leaves nothing behind.
        let free = dir.join("free.md");
        move_no_clobber(&source, &free).unwrap();
        assert_eq!(std::fs::read_to_string(&free).unwrap(), "source");
        assert!(!source.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
