//! The vault's history side table: the KEY that maps a vault-relative path to a
//! `.nekowite/history/<encoded>` directory, and the listing, reading and
//! restoring a caller asks that directory for.
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
//! What a version IS — the name one takes, the staging that lands it durably,
//! the eviction that keeps the directory to `max`, and what a failed save does
//! with the one it staged — is [`crate::storage::history_snapshot`]. That split
//! is not cosmetic: the eviction belongs to the version's lifecycle, and only
//! the caller that staged a version knows whether the save it belongs to
//! happened. This module re-exports the public surface of that one so the
//! callers below it keep a single import path.
//!
//! This module depends on [`crate::storage::atomic_write`] for the transport
//! (staging, fsync, the shared [`crate::storage::atomic_write::write_lock`]) and
//! on nothing above it.

use serde::Serialize;
use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::domain::path_policy::{
    encode_rel_path, find_vault_metadata_dir, resolve_within, resolve_within_rel,
};
use crate::errors::fs_error;
use crate::storage::atomic_write::{atomic_write, write_lock};
use crate::storage::destination_file;

pub use crate::storage::history_snapshot::snapshot_history;
pub(crate) use crate::storage::history_snapshot::DEFAULT_MAX_HISTORY;
pub(crate) use crate::storage::history_snapshot::{settle_failed_publish, stage_history};

#[derive(Serialize, Clone, Debug)]
pub struct HistoryEntry {
    pub id: String,
    pub size: u64,
    pub mtime: u64,
}

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
    // The same pre-flight `write_file` runs, for the same reason: without it a
    // refused restore still snapshots the content it is not going to replace,
    // and a retry loop spends the history it is being asked to restore from.
    destination_file::refuse_if_read_only(&resolved)?;
    let mut staged = None;
    if resolved.exists() {
        match std::fs::read_to_string(&resolved) {
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                // Same guard as write_file: never clobber a binary file.
                return Err("file is not valid UTF-8 text".into());
            }
            Ok(old) if !old.is_empty() && old != content => {
                // Staged before the publish and evicted after it, for the same
                // reason as in `write_file`: a restore that fails must not cost
                // the user a version either.
                staged = stage_history(vault_root, path, &old)?;
            }
            _ => {}
        }
    }
    if let Err(e) = atomic_write(&resolved, &content) {
        settle_failed_publish(&resolved, &content, staged, DEFAULT_MAX_HISTORY);
        return Err(e);
    }
    if let Some(snapshot) = staged {
        snapshot.commit(DEFAULT_MAX_HISTORY)?;
    }
    Ok(content)
}
