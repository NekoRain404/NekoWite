//! One history version, end to end: the name it takes inside a note's history
//! directory, the staging that gets its bytes there durably, and what a save
//! that failed does with the version it staged.
//!
//! It is split out of [`crate::storage::metadata_store`] because those two are
//! different concerns: that module is the KEY (which directory a vault path
//! maps to, and the listing/reading/restoring a panel asks for), and this one
//! is the FILE (how a version is written and settled). The eviction is why the
//! seam has to be here rather than anywhere else — it is a consequence of the
//! save, and the caller that stages a version is the only one that knows
//! whether the save it belongs to happened.
//!
//! The RETENTION rule — which stored version is the oldest, and dropping the
//! ones past `max` — is [`super::history_prune`], split out so that the
//! ordering policy (where the same-millisecond bug was) is testable on its own.
//!
//! Leaf-ish: it depends on [`crate::storage::atomic_write`] for the transport,
//! on [`crate::storage::temp_files`] for the staged name and on
//! [`super::history_prune`] for the eviction, and on nothing above it. It knows
//! nothing about listing, reading back or restoring.

use std::io;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::path_policy::{create_vault_metadata_dir, encode_rel_path, resolve_within_rel};
use crate::errors::fs_error;
use crate::storage::atomic_write::{copy_new, is_link_unsupported, sync_parent_dir};
use crate::storage::history_prune::prune_history;
use crate::storage::temp_files::temp_sibling;

/// Snapshot cap used when the caller does not pass `max_history`.
pub(crate) const DEFAULT_MAX_HISTORY: usize = 10;

/// A history version that has been written into the note's history directory,
/// with the EVICTION it would cause still held back.
///
/// The two steps used to be one, and that is what made a save that failed cost
/// the user a version: the save of a note whose name overflowed `NAME_MAX`
/// staged this snapshot, pruned the directory to `max` — dropping the oldest
/// version the user still had — and only then discovered it could not write the
/// note at all. Every retry dropped one more, and the ten slots filled with
/// duplicates of a file that never changed. The eviction is a consequence of
/// the save, so it waits for the save: [`commit`](Self::commit) once the new
/// text is known to be in the file, [`discard`](Self::discard) when it is known
/// not to be.
pub(crate) struct StagedSnapshot {
    dir: PathBuf,
    path: PathBuf,
}

impl StagedSnapshot {
    /// The save this belongs to reached the file: keep the `max` newest
    /// versions and drop the rest.
    pub(crate) fn commit(self, max: usize) -> Result<(), String> {
        prune_history(&self.dir, max)
    }

    /// The save did not reach the file, so this version is a copy of what is
    /// still on disk and means nothing. Removed rather than left for a later
    /// prune: pruning keeps the NEWEST `max`, so a leftover duplicate evicts a
    /// real version exactly as the failed save used to, only later.
    pub(crate) fn discard(self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Snapshot `old_content` into `.nekowite/history/<encoded>/<unix_ms>.<ext>`
/// under `vault_root`, then prune the directory to the `max` newest snapshots.
/// Empty `old_content` is skipped (nothing to preserve).
///
/// The content is written to a unique temp sibling and fsynced first, then
/// hard-linked into place under the timestamped name: the link fails with
/// `AlreadyExists` when another writer claimed the same millisecond, so the
/// `-<n>` suffix loop below never silently overwrites an existing snapshot
/// (a plain rename would), and the newest snapshot can never be observed
/// truncated — the name only exists once the content is complete and durable.
///
/// The save pipelines do NOT call this: they cannot commit the eviction before
/// they know the save happened, so they use [`stage_history`] and commit or
/// discard the result themselves. This stays as the one-call form for the
/// callers that have no write to wait for (tests, and any future caller that
/// wants a snapshot with no save attached).
pub fn snapshot_history(
    vault_root: &str,
    path: &str,
    old_content: &str,
    max: usize,
) -> Result<(), String> {
    match stage_history(vault_root, path, old_content)? {
        Some(staged) => staged.commit(max),
        None => Ok(()),
    }
}

/// Write `old_content` into the note's history directory without touching what
/// is already there. `Ok(None)` means there was nothing to preserve.
pub(crate) fn stage_history(
    vault_root: &str,
    path: &str,
    old_content: &str,
) -> Result<Option<StagedSnapshot>, String> {
    if old_content.is_empty() {
        return Ok(None);
    }
    let (resolved, relative) = resolve_within_rel(vault_root, path)?;
    if relative.is_empty() {
        return Err("path is the vault root".into());
    }
    let encoded = encode_rel_path(&relative);
    let history_dir = create_vault_metadata_dir(vault_root, &[".nekowite", "history", &encoded])?;
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let ext = resolved
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("md");
    let tmp = temp_sibling(&history_dir);
    let result = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| fs_error("create the temporary file", &tmp, e))?;
        f.write_all(old_content.as_bytes())
            .map_err(|e| fs_error("write the temporary file", &tmp, e))?;
        f.sync_all()
            .map_err(|e| fs_error("flush the temporary file", &tmp, e))?;
        let mut n = 0u64;
        loop {
            let candidate = if n == 0 {
                history_dir.join(format!("{ms}.{ext}"))
            } else {
                history_dir.join(format!("{ms}-{n}.{ext}"))
            };
            match std::fs::hard_link(&tmp, &candidate) {
                Ok(()) => return Ok(candidate),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => n += 1,
                // Not every filesystem can hard-link: FAT32 and exFAT (USB
                // sticks, SD cards) return ERROR_INVALID_FUNCTION, and a vault on
                // such a volume would otherwise never be able to save an existing
                // note — the snapshot is what this link was for, not the write
                // itself. Copy the staged bytes to the same name instead: the
                // staging file already holds the complete snapshot, so the copy
                // only needs to land atomically, which `create_new` gives us.
                Err(e) if is_link_unsupported(&e) => match copy_new(&tmp, &candidate) {
                    Ok(()) => return Ok(candidate),
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => n += 1,
                    Err(e) => return Err(fs_error("save the history version", &candidate, e)),
                },
                Err(e) => return Err(fs_error("save the history version", &candidate, e)),
            }
        }
    })();
    match result {
        Ok(candidate) => {
            let _ = std::fs::remove_file(&tmp);
            sync_parent_dir(&candidate)?;
            Ok(Some(StagedSnapshot {
                dir: history_dir,
                path: candidate,
            }))
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// What a failed publish means for the version that was staged for it, and the
/// one thing that makes this more than bookkeeping: an error from
/// [`crate::storage::atomic_write::atomic_write`] does NOT prove the file was
/// left alone. Its last step is the directory fsync, so a failure there is
/// reported over a file that has already been replaced.
///
/// Which of the two happened is readable from the disk, and the two answers are
/// not interchangeable: when the new text IS in the file, that staged version
/// is the one to recover from and the eviction goes ahead; when it is not, the
/// staged version is a copy of what is still on disk and is removed, because a
/// copy left behind would evict a real version at the next successful save.
pub(crate) fn settle_failed_publish(
    resolved: &Path,
    content: &str,
    staged: Option<StagedSnapshot>,
    max: usize,
) {
    let Some(snapshot) = staged else {
        return;
    };
    let published = std::fs::read_to_string(resolved).is_ok_and(|on_disk| on_disk == content);
    if published {
        let _ = snapshot.commit(max);
    } else {
        snapshot.discard();
    }
}
