//! Trash store: moving entries into `.nekowite-trash/` and restoring or
//! clearing them.
//!
//! The trash key is the canonical vault-relative path (encoded via
//! [`crate::domain::path_policy::encode_rel_path`]), so the frontend's absolute
//! spellings (what `list_dir` entries carry) decode back to the same vault path
//! regardless of how the path was spelled. Every entry is confined to the vault
//! through [`crate::domain::path_policy`].
//!
//! Two of the four verbs are their own modules, because each is a policy the
//! rest of the store does not share: [`super::trash_restore`] claims a
//! destination that may already be taken, and [`super::trash_clear`] destroys
//! and can half-succeed. Both are re-exported below, so
//! `commands::recovery` and the integration tests keep their imports.
//! The entry-name vocabulary stays here — three of the operations speak it.

use serde::Serialize;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::path_policy::{
    create_vault_metadata_dir, decode_rel_path, encode_rel_path, find_vault_metadata_dir,
    is_safe_rel, resolve_within, resolve_within_rel,
};
use crate::errors::fs_error;

// The two verbs the split moved out, kept reachable from this module path
// because it is the one `commands::recovery` names them from. The direction of
// USE is `trash_clear`/`trash_restore` → this file, never the reverse: both are
// handed nothing but a vault root.
pub use super::trash_clear::{clear_trash, ClearTrashFailure, ClearTrashReport};
pub use super::trash_restore::restore_from_trash;

#[derive(Serialize, Clone, Debug)]
pub struct TrashEntry {
    /// The encoded trash key (the entry's on-disk name), kept verbatim for
    /// callers that key off it — `docs%2Fa.md`, or `docs%2Fa.md-<ms>` after a
    /// collision. `display_name` is what a user should see.
    pub name: String,
    /// What the user deleted, named the way they saw it: the decoded path's
    /// last segment, so `docs%2Fa.md` reads `a.md`. Falls back to the key when
    /// the entry cannot be decoded.
    pub display_name: String,
    pub trash_path: String,
    pub original_path: String,
    /// A folder is trashed and restored exactly like a file; the flag only
    /// lets the UI label it.
    pub is_dir: bool,
}

/// Internal bookkeeping trees whose contents are never the user's documents.
///
/// The vault's own metadata (`.nekowite/…`), the trash itself and the `.tmp`
/// staging area for paste/drop assets of unsaved tabs are all invisible to the
/// file tree ([`crate::domain::vault::should_skip_entry`] hides dot-prefixed
/// names), so a delete aimed at one of them can only come from the app's own
/// housekeeping — never from a user gesture. Routing it through the trash
/// deposited `%2Enekowite%2Findex%2F…` and `%2Etmp%2F…` entries nobody could
/// act on, and made the recovery loop's GC move crash litter from one hidden
/// directory into another without reclaiming the disk.
fn is_internal_rel_path(relative: &str) -> bool {
    matches!(
        relative.split('/').next().unwrap_or(""),
        ".nekowite" | ".nekowite-trash" | ".tmp"
    )
}

/// Strip the `-<ms>` stamp [`delete_file`] appends when the trash already holds
/// an entry for the same path.
///
/// The stamp disambiguates the KEY only. Decoding it as part of the name made
/// the restored target `a.md-1757520000000`, whose `Path::extension()` reads
/// `md-1757…` — no longer Markdown, so the restored note would not open. Only a
/// full millisecond epoch stamp (13 digits) is stripped, so a file legitimately
/// named `report-2024.md` keeps its name.
fn strip_collision_suffix(name: &str) -> &str {
    match name.rsplit_once('-') {
        Some((head, tail)) if tail.len() == 13 && tail.bytes().all(|b| b.is_ascii_digit()) => head,
        _ => name,
    }
}

/// Decode a trash entry's on-disk key back to the vault-relative path it stands
/// for, collision suffix included in the key but never in the path.
///
/// `pub(crate)` because `super::trash_restore` reads a key the same way this
/// module's listing and rename-migration do — one reading of a key, in one
/// place, so a change to the suffix rule cannot apply to two of the three.
pub(crate) fn decode_trash_key(name: &str) -> String {
    decode_rel_path(strip_collision_suffix(name))
}

/// Best-effort removal of one trash entry, recursing for a deleted folder.
fn purge_trash_entry(p: &Path, is_dir: bool) {
    let _ = if is_dir {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    };
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
            std::fs::remove_dir_all(&resolved).map_err(|e| fs_error("delete", &resolved, e))?;
        } else {
            std::fs::remove_file(&resolved).map_err(|e| fs_error("delete", &resolved, e))?;
        }
        return Ok(String::new());
    }
    let trash_root = create_vault_metadata_dir(vault_root, &[".nekowite-trash"])?;
    let encoded = encode_rel_path(&relative);
    let mut target = trash_root.join(&encoded);
    if target.exists() {
        let mut ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        target = trash_root.join(format!("{encoded}-{ts}"));
        // A stamp that is itself taken has to move on, not be renamed over:
        // `fs::rename` REPLACES its destination on unix, so two deletes of the
        // same path inside one millisecond computed the same stamped name, the
        // second destroyed the copy the first had just moved in, and both
        // callers were told they had succeeded. `move_trash_key` guards the same
        // hazard the same way — the name stays a single 13-digit stamp, so
        // `strip_collision_suffix` still recognises it.
        while target.exists() {
            ts = ts.saturating_add(1);
            target = trash_root.join(format!("{encoded}-{ts}"));
        }
    }
    std::fs::rename(&resolved, &target).map_err(|e| fs_error("delete", &resolved, e))?;
    Ok(crate::domain::path_policy::ipc_path(&target))
}

/// List `.nekowite-trash/` — files and folders alike — decoding each entry back
/// to its original vault path where the encoding permits, plus the display
/// name and folder flag the UI shows.
pub fn list_trash(vault_root: &str) -> Result<Vec<TrashEntry>, String> {
    // No trash directory means nothing was ever deleted — an empty list is the
    // truth, and merely looking must not create one. A directory that exists
    // but cannot be read (or one that has been replaced by a symlink) is not
    // the same thing: showing "the trash is empty" would tell the user their
    // deleted notes are gone when they are only unreadable.
    let Some(trash_root) = find_vault_metadata_dir(vault_root, &[".nekowite-trash"])? else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    let rd = std::fs::read_dir(&trash_root)
        .map_err(|e| fs_error("read the trash folder", &trash_root, e))?;
    for entry in rd {
        // Same rule as the history listing: an entry we cannot read is not
        // "no entry". Skipping it used to make a partially readable trash look
        // shorter than it is, which the panel cannot tell apart from an empty
        // one - and a deleted note appearing to be gone for good is the one
        // thing the trash exists to prevent.
        let entry = entry.map_err(|e| fs_error("read the trash folder", &trash_root, e))?;
        let p = entry.path();
        let meta = p
            .metadata()
            .map_err(|e| fs_error("read the trash entry", &p, e))?;
        // Folders are listed too. Deleting one moves the whole tree into the
        // trash, and skipping anything that was not a file left a deleted
        // folder invisible — no count, no way back.
        let is_dir = meta.is_dir();
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let decoded = decode_trash_key(&name);
        // Self-heal from the era when internal bookkeeping was trashed: an
        // entry that decodes back into an internal tree can never be a note
        // the user deleted, so drop it instead of listing junk forever.
        if is_internal_rel_path(&decoded) {
            purge_trash_entry(&p, is_dir);
            continue;
        }
        // Only surface a path that is a sane vault-relative form AND that we
        // could actually resolve inside the vault — the same rule
        // `restore_from_trash` applies, so the UI never offers a restore
        // that would be refused.
        let original_path = if is_safe_rel(&decoded) && resolve_within(vault_root, &decoded).is_ok()
        {
            decoded
        } else {
            String::new()
        };
        let display_name = if original_path.is_empty() {
            // Undecodable entry: the key is all there is to show.
            name.clone()
        } else {
            original_path
                .rsplit('/')
                .next()
                .unwrap_or(&original_path)
                .to_string()
        };
        out.push(TrashEntry {
            name,
            display_name,
            trash_path: crate::domain::path_policy::ipc_path(&p),
            original_path,
            is_dir,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Migrate the trash entry for a renamed file from the key for `from_rel` to
/// the key for `to_rel`. Handles both the exact key a [`delete_file`] wrote and
/// any `-<ts>` collision-suffixed variants. Best-effort, like
/// `move_history_key`.
pub fn move_trash_key(vault_root: &str, from_rel: &str, to_rel: &str) {
    let Ok(Some(trash_root)) = find_vault_metadata_dir(vault_root, &[".nekowite-trash"]) else {
        return;
    };
    let to_key = encode_rel_path(to_rel);
    let Ok(rd) = std::fs::read_dir(&trash_root) else {
        return;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        // Match on the DECODED path rather than on an encoded-key prefix.
        //
        // The previous prefix test read `name.strip_prefix(&from_key).unwrap_or("")`
        // and then treated an empty suffix as a match. `strip_prefix` returns
        // `None` when the prefix does not match at all, so `unwrap_or("")` turned
        // "unrelated to this rename" into "exact match" — every entry in the trash
        // matched every rename. Renaming one live file then rewrote the name of
        // every unrelated trashed item to the new key, and two of them landing in
        // the same millisecond made `fs::rename` overwrite one with the other:
        // the contents of a deleted note were destroyed by renaming something
        // else entirely. Decoding also makes legacy (`__`-encoded) entries follow
        // a rename, which the encoded-prefix comparison could never do.
        let matched = decode_trash_key(name) == from_rel;
        if !matched {
            continue;
        }
        // Keep the original collision stamp, if this entry had one, so several
        // trashed versions of the same path stay distinguishable and in order.
        let stamp = &name[strip_collision_suffix(name).len()..];
        let mut ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        let mut target = trash_root.join(format!("{to_key}{stamp}"));
        // A collision stamp has to stay exactly 13 digits — that shape is how
        // `strip_collision_suffix` tells a disambiguating stamp from a name that
        // legitimately ends in digits — so a taken name gets a REPLACEMENT stamp
        // rather than a second one appended.
        //
        // Appending used to produce `{to_key}{old_stamp}-{new_stamp}`, and only
        // the LAST stamp is ever stripped: the entry then decoded to a path
        // ending in the old stamp, which is to say a path that never existed, so
        // it could never be restored and stopped matching `from_rel` on any
        // later rename. Bumping also guarantees a free name — `fs::rename`
        // REPLACES an existing file on Windows, so reusing the first candidate
        // would destroy the entry already sitting there.
        while target.exists() {
            ts = ts.saturating_add(1);
            target = trash_root.join(format!("{to_key}-{ts}"));
        }
        let _ = std::fs::rename(&p, &target);
    }
}
