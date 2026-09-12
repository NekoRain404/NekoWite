//! Trash store: moving entries into `.nekowite-trash/` and restoring or
//! clearing them.
//!
//! The trash key is the canonical vault-relative path (encoded via
//! [`crate::domain::path_policy::encode_rel_path`]), so the frontend's absolute
//! spellings (what `list_dir` entries carry) decode back to the same vault path
//! regardless of how the path was spelled. Every entry is confined to the vault
//! through [`crate::domain::path_policy`], and `restore_from_trash` refuses to
//! move anything outside the trash directory.

use serde::Serialize;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::path_policy::{
    decode_rel_path, encode_rel_path, is_safe_rel, resolve_within, resolve_within_rel,
};

#[derive(Serialize, Clone)]
pub struct TrashEntry {
    pub name: String,
    pub trash_path: String,
    pub original_path: String,
}

/// Internal bookkeeping trees whose contents are never the user's documents.
///
/// The vault's own metadata (`.nekowite/…`) and the trash itself are
/// invisible to the file tree ([`crate::domain::vault::should_skip_entry`]
/// hides dot-prefixed names), so a delete aimed at one of them can only come
/// from the app's own housekeeping — never from a user gesture.
fn is_internal_rel_path(relative: &str) -> bool {
    matches!(
        relative.split('/').next().unwrap_or(""),
        ".nekowite" | ".nekowite-trash"
    )
}

/// Move `path` into `.nekowite-trash/<encode(path)>`, appending `-<ts>` if a
/// same-named entry already sits in the trash. Returns the trash path.
///
/// The key is built from the CANONICAL vault-relative path, not the argument
/// as given: the frontend hands us absolute paths (as returned by
/// `list_dir`), and encoding those directly produced keys
/// [`decode_rel_path`] could never turn back into a usable vault path.
///
/// A path inside an internal tree is PERMANENTLY removed instead, and the
/// returned string is empty. The trash exists so a user can recover a deleted
/// note; routing the app's own bookkeeping through it filled the回收站 with
/// junk — every atomic index write stages `.nekowite/index/*.tmp` and then
/// removes it, so each rebuild deposited four+ `%2Enekowite%2Findex%2F…`
/// entries that no user could act on.
pub fn delete_file(vault_root: &str, path: &str) -> Result<String, String> {
    let (resolved, relative) = resolve_within_rel(vault_root, path)?;
    if relative.is_empty() {
        return Err("cannot delete the vault root".into());
    }
    if is_internal_rel_path(&relative) {
        if resolved.is_dir() {
            std::fs::remove_dir_all(&resolved).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(&resolved).map_err(|e| e.to_string())?;
        }
        return Ok(String::new());
    }
    let trash_root = Path::new(vault_root).join(".nekowite-trash");
    std::fs::create_dir_all(&trash_root).map_err(|e| e.to_string())?;
    let encoded = encode_rel_path(&relative);
    let mut target = trash_root.join(&encoded);
    if target.exists() {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        target = trash_root.join(format!("{encoded}-{ts}"));
    }
    std::fs::rename(&resolved, &target).map_err(|e| e.to_string())?;
    Ok(crate::domain::path_policy::ipc_path(&target))
}

/// List `.nekowite-trash/`, decoding each entry back to its original vault
/// path where the encoding permits.
pub fn list_trash(vault_root: &str) -> Result<Vec<TrashEntry>, String> {
    let trash_root = Path::new(vault_root).join(".nekowite-trash");
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(&trash_root) {
        Ok(rd) => rd,
        Err(_) => return Ok(out),
    };
    for entry in rd.flatten() {
        let p = entry.path();
        let Ok(meta) = p.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let decoded = decode_rel_path(&name);
        // Self-heal from the era when internal bookkeeping was trashed: an
        // entry that decodes back into an internal tree can never be a note
        // the user deleted, so drop it instead of listing junk forever.
        if is_internal_rel_path(&decoded) {
            let _ = std::fs::remove_file(&p);
            continue;
        }
        // Only surface a path that is a sane vault-relative form AND that we
        // could actually resolve inside the vault — the same rule
        // `restore_from_trash` applies, so the UI never offers a restore
        // that would be refused.
        let original_path = if is_safe_rel(&decoded)
            && resolve_within(vault_root, &decoded).is_ok()
        {
            decoded
        } else {
            String::new()
        };
        out.push(TrashEntry {
            name,
            trash_path: crate::domain::path_policy::ipc_path(&p),
            original_path,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Permanently delete every entry under `.nekowite-trash/`, returning how many
/// were removed. A missing trash directory is not an error — it returns 0.
///
/// Only direct children of the trash directory are touched (each is the single
/// encoded, safe component [`delete_file`] wrote), so traversal is impossible;
/// the defensive `.`/`..`/empty-name guard is belt and braces rather than a
/// requirement.
pub fn clear_trash(vault_root: &str) -> Result<usize, String> {
    let trash_root = Path::new(vault_root).join(".nekowite-trash");
    if !trash_root.exists() {
        return Ok(0);
    }
    let rd = std::fs::read_dir(&trash_root).map_err(|e| e.to_string())?;
    let mut removed = 0usize;
    for entry in rd.flatten() {
        let p = entry.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        if p.is_dir() {
            std::fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
        removed += 1;
    }
    Ok(removed)
}

/// Move a trash entry back to its original vault path. If that path is now
/// occupied, append `-restored-<ts>` and return the new path.
pub fn restore_from_trash(vault_root: &str, trash_path: &str) -> Result<String, String> {
    let resolved_trash = resolve_within(vault_root, trash_path)?;
    let trash_root = Path::new(vault_root).join(".nekowite-trash");
    let canonical_trash = trash_root
        .canonicalize()
        .map_err(|e| format!("cannot resolve trash directory: {e}"))?;
    if !resolved_trash.starts_with(&canonical_trash) {
        return Err("trash path outside .nekowite-trash".into());
    }
    let name = resolved_trash
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let original_rel = decode_rel_path(&name);
    if !is_safe_rel(&original_rel) {
        return Err("cannot restore: invalid trash entry name".into());
    }
    let original_abs = resolve_within(vault_root, &original_rel)?;
    let mut target = original_abs;
    if target.exists() {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        let parent = target
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_default();
        let fname = target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        target = parent.join(format!("{fname}-restored-{ts}"));
    }
    std::fs::rename(&resolved_trash, &target).map_err(|e| e.to_string())?;
    Ok(crate::domain::path_policy::ipc_path(&target))
}

/// Migrate the trash entry for a renamed file from the key for `from_rel` to
/// the key for `to_rel`. Handles both the exact key a [`delete_file`] wrote and
/// any `-<ts>` collision-suffixed variants. Best-effort, like
/// `move_history_key`.
pub fn move_trash_key(vault_root: &str, from_rel: &str, to_rel: &str) {
    let trash_root = Path::new(vault_root).join(".nekowite-trash");
    if !trash_root.is_dir() {
        return;
    }
    let from_key = encode_rel_path(from_rel);
    let to_key = encode_rel_path(to_rel);
    let Ok(rd) = std::fs::read_dir(&trash_root) else { return };
    for entry in rd.flatten() {
        let p = entry.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let suffix = name.strip_prefix(&from_key).unwrap_or("");
        // Only the exact key or a `-<digits>` collision variant matches; a
        // longer path that merely starts with the same text never does.
        let matched = suffix.is_empty()
            || (suffix.len() > 1
                && suffix.starts_with('-')
                && suffix[1..].chars().all(|c| c.is_ascii_digit()));
        if !matched {
            continue;
        }
        let new_name = if suffix.is_empty() {
            to_key.clone()
        } else {
            format!("{to_key}{suffix}")
        };
        let mut target = trash_root.join(&new_name);
        if target.exists() {
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default();
            target = trash_root.join(format!("{new_name}-{ts}"));
        }
        let _ = std::fs::rename(&p, &target);
    }
}
