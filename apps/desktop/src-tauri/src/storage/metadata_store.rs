//! The vault's history side table: the key scheme that maps a vault-relative
//! path to a `.nekowite/history/<encoded>` directory, the snapshots written
//! into it, and the listing/reading/restoring of those snapshots.
//!
//! Centralising the side key here (roadmap 10.4 step 3) is what keeps every
//! caller landing on the same directory for the same file: all spellings of a
//! path are resolved and encoded by [`encoded_history_key`], and the trash side
//! table's mirror of that work lives next door in
//! [`crate::storage::trash_store`]. The metadata trees are reached through
//! [`crate::domain::path_policy`], so a symlinked `.nekowite` is refused rather
//! than followed outside the vault. Moving a key when its file is renamed is
//! [`crate::storage::rename_store`]'s job, which is what keeps this module
//! free of the rename transaction.
//!
//! This module depends on [`crate::storage::atomic_write`] for the transport
//! (staging, fsync, the shared [`crate::storage::atomic_write::write_lock`]) and
//! on nothing above it.

use serde::Serialize;
use std::io;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::path_policy::{
    create_vault_metadata_dir, encode_rel_path, find_vault_metadata_dir, resolve_within,
    resolve_within_rel,
};
use crate::errors::fs_error;
use crate::storage::atomic_write::{
    atomic_write, copy_new, is_link_unsupported, sync_parent_dir, time_nonce, write_lock,
};

#[derive(Serialize, Clone, Debug)]
pub struct HistoryEntry {
    pub id: String,
    pub size: u64,
    pub mtime: u64,
}

/// Snapshot cap used when the caller does not pass `max_history`.
pub(crate) const DEFAULT_MAX_HISTORY: usize = 10;

/// Resolve `path` inside the vault and encode the canonical vault-relative
/// form as a history key. Every history caller goes through this so all
/// spellings of a file land on the same key. The vault root itself has no
/// meaningful relative form and is rejected.
fn encoded_history_key(vault_root: &str, path: &str) -> Result<String, String> {
    let (_, relative) = resolve_within_rel(vault_root, path)?;
    if relative.is_empty() {
        return Err("path is the vault root".into());
    }
    Ok(encode_rel_path(&relative))
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
pub fn snapshot_history(
    vault_root: &str,
    path: &str,
    old_content: &str,
    max: usize,
) -> Result<(), String> {
    if old_content.is_empty() {
        return Ok(());
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
    let tmp = history_dir.join(format!(".{ms}.{}.tmp", time_nonce()));
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
            prune_history(&history_dir, max)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Creation order within one shared mtime: [`snapshot_history`] writes
/// `{ms}.{ext}` first, then `{ms}-1.{ext}`, `{ms}-2.{ext}`, … so the collision
/// suffix IS the age order, lower meaning older.
///
/// Sorting these names alphabetically gets that backwards — `-` sorts before
/// `.`, so `<ms>-1.md` compares LESS than `<ms>.md` even though it was written
/// later. That is what made the newest snapshot of a same-millisecond group
/// sort as the oldest and be pruned while an older sibling survived.
fn snapshot_collision_suffix(name: &str) -> u64 {
    let Some((stem, _ext)) = name.rsplit_once('.') else {
        return 0;
    };
    match stem.rsplit_once('-') {
        Some((_, n)) => n.parse().unwrap_or(0),
        None => 0,
    }
}

/// Keep only the `max` newest snapshot files (by modified time) in `dir`.
fn prune_history(dir: &Path, max: usize) -> Result<(), String> {
    let mut entries: Vec<(PathBuf, u128)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            // Never count temp litter from an interrupted snapshot write.
            if p.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .starts_with('.')
            {
                continue;
            }
            if let Ok(meta) = p.metadata() {
                if meta.is_file() {
                    let mtime = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_nanos())
                        .unwrap_or(0);
                    entries.push((p, mtime));
                }
            }
        }
    }
    if entries.len() > max {
        // Newest first. File mtimes are only jiffy-coarse, so snapshots written
        // in quick succession can share one timestamp; break ties by the
        // COLLISION SUFFIX, not by name. Plain name order gets this backwards —
        // `-` sorts before `.`, so `<ms>-1.md` compares less than `<ms>.md`
        // even though it was written later — which made the newest snapshot of
        // a same-millisecond group sort as the oldest one and be deleted first
        // while an older sibling survived.
        entries.sort_by(|a, b| {
            let an = a.0.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let bn = b.0.file_name().and_then(|n| n.to_str()).unwrap_or("");
            b.1.cmp(&a.1)
                .then(snapshot_collision_suffix(bn).cmp(&snapshot_collision_suffix(an)))
                .then(an.cmp(bn))
        });
        for (p, _) in entries.into_iter().skip(max) {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(())
}

/// List the history snapshots for `path`, newest first.
pub fn list_history(vault_root: &str, path: &str) -> Result<Vec<HistoryEntry>, String> {
    // Validate the path resolves inside the vault (C-round sandbox) before we
    // trust it as a history key.
    let encoded = encoded_history_key(vault_root, path)?;
    // `None` is the ordinary "this note has no history yet" — an empty list is
    // the truth, and merely looking must not create anything. Any OTHER failure
    // (permissions, a symlinked metadata tree, a file where the directory
    // should be) is a hole, and reporting it as "no history" tells the user
    // their versions are gone when they are merely unreadable.
    let Some(history_dir) =
        find_vault_metadata_dir(vault_root, &[".nekowite", "history", &encoded])?
    else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    let rd = std::fs::read_dir(&history_dir)
        .map_err(|e| fs_error("read the history of", Path::new(path), e))?;
    for entry in rd {
        // A single unreadable entry is a hole too: skipping it silently turned
        // a partially readable history into a shorter list, which the panel
        // cannot tell apart from "this is all there is". Name the entry and
        // fail instead - the caller already shows an unreadable history as an
        // error, and an error is at least the truth.
        let entry = entry.map_err(|e| fs_error("read the history of", Path::new(path), e))?;
        let p = entry.path();
        let id = entry.file_name().to_string_lossy().to_string();
        // Temp litter from an interrupted snapshot write is not a snapshot, and
        // stat-ing the litter of a crashed write is exactly what could fail.
        if id.starts_with('.') {
            continue;
        }
        let meta = p
            .metadata()
            .map_err(|e| fs_error("read the history entry", &p, e))?;
        if !meta.is_file() {
            continue;
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(HistoryEntry {
            id,
            size: meta.len(),
            mtime,
        });
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime).then(b.id.cmp(&a.id)));
    Ok(out)
}

/// Read a single history snapshot by id.
pub fn read_history(vault_root: &str, path: &str, id: &str) -> Result<String, String> {
    let encoded = encoded_history_key(vault_root, path)?;
    // The id is joined onto a directory path, so treat it as untrusted input:
    // it must be a plain single file name.
    let valid_id = !id.is_empty()
        && !id.starts_with('.')
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains(':')
        && !id.contains("..")
        && Path::new(id).file_name().and_then(|n| n.to_str()) == Some(id);
    if !valid_id {
        return Err("invalid history id".into());
    }
    // Resolved through the metadata walk, which refuses a symlinked
    // `.nekowite`/`history`/key: without it the containment check below would
    // still pass for a history tree that had been redirected outside the vault
    // (both paths would agree — on the outside).
    let history_dir = find_vault_metadata_dir(vault_root, &[".nekowite", "history", &encoded])?
        .ok_or_else(|| "history is not available for this note".to_string())?;
    let snapshot = history_dir.join(id);
    // Belt and braces: even if the lexical checks above missed something, the
    // resolved snapshot path must stay inside this history directory.
    let canonical_dir = history_dir
        .canonicalize()
        .map_err(|e| fs_error("open the history folder", &history_dir, e))?;
    let canonical_snapshot = snapshot
        .canonicalize()
        .map_err(|e| fs_error("find the history version", &snapshot, e))?;
    if !canonical_snapshot.starts_with(&canonical_dir) {
        return Err("invalid history id".into());
    }
    std::fs::read_to_string(&canonical_snapshot)
        .map_err(|e| fs_error("read the history version", &canonical_snapshot, e))
}

/// Restore a history snapshot onto the main file atomically; returns the
/// restored content. The content being replaced is snapshotted first (same
/// pipeline and pruning as [`crate::storage::file_store::write_file`]), so a
/// restore can itself be undone from the history panel.
pub fn restore_history(vault_root: &str, path: &str, id: &str) -> Result<String, String> {
    let content = read_history(vault_root, path, id)?;
    let _guard = write_lock().lock().map_err(|e| e.to_string())?;
    let resolved = resolve_within(vault_root, path)?;
    if resolved.exists() {
        match std::fs::read_to_string(&resolved) {
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                // Same guard as write_file: never clobber a binary file.
                return Err("file is not valid UTF-8 text".into());
            }
            Ok(old) if !old.is_empty() && old != content => {
                snapshot_history(vault_root, path, &old, DEFAULT_MAX_HISTORY)?;
            }
            _ => {}
        }
    }
    atomic_write(&resolved, &content)?;
    Ok(content)
}

#[cfg(test)]
mod snapshot_pruning_tests {
    use super::{prune_history, snapshot_collision_suffix};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[test]
    fn the_collision_suffix_is_the_age_order() {
        assert_eq!(snapshot_collision_suffix("1700.md"), 0);
        assert_eq!(snapshot_collision_suffix("1700-1.md"), 1);
        assert_eq!(snapshot_collision_suffix("1700-12.markdown"), 12);
        // Anything that is not `<stem>-<n>.<ext>` belongs to no collision group.
        assert_eq!(snapshot_collision_suffix("notes.md"), 0);
        assert_eq!(snapshot_collision_suffix("no-extension"), 0);
    }

    #[test]
    fn pruning_a_same_millisecond_group_keeps_the_newest_snapshot() {
        let dir = std::env::temp_dir().join(format!(
            "nekowite-prune-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();

        // `snapshot_history` writes `<ms>.md` first, then `-1`, then `-2`, so
        // `1700-2.md` is the NEWEST of the group.
        let names = ["1700.md", "1700-1.md", "1700-2.md"];
        for name in names {
            std::fs::write(dir.join(name), name).unwrap();
        }
        // Pin one shared mtime: that is what a jiffy-coarse clock produces for
        // snapshots written in quick succession, and without it the tie-break
        // this test is about never runs.
        let shared = SystemTime::now() - Duration::from_secs(60);
        for name in names {
            std::fs::OpenOptions::new()
                .write(true)
                .open(dir.join(name))
                .unwrap()
                .set_modified(shared)
                .unwrap();
        }

        prune_history(&dir, 1).unwrap();

        let kept: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            kept,
            vec!["1700-2.md".to_string()],
            "pruning must drop the OLDEST of the group, not the newest"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
