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
use crate::errors::fs_error;

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
fn decode_trash_key(name: &str) -> String {
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

/// Insert `suffix` before the extension (`a.md` -> `a-restored-1.md`) so a
/// name-collision restore keeps a recognised extension. Appending after it
/// produced `a.md-restored-1`, which no note loader can open.
fn name_with_suffix(name: &str, suffix: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem}{suffix}.{ext}"),
        _ => format!("{name}{suffix}"),
    }
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
    let trash_root = Path::new(vault_root).join(".nekowite-trash");
    std::fs::create_dir_all(&trash_root)
        .map_err(|e| fs_error("create the trash folder", &trash_root, e))?;
    let encoded = encode_rel_path(&relative);
    let mut target = trash_root.join(&encoded);
    if target.exists() {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        target = trash_root.join(format!("{encoded}-{ts}"));
    }
    std::fs::rename(&resolved, &target).map_err(|e| fs_error("delete", &resolved, e))?;
    Ok(crate::domain::path_policy::ipc_path(&target))
}

/// List `.nekowite-trash/` — files and folders alike — decoding each entry back
/// to its original vault path where the encoding permits, plus the display
/// name and folder flag the UI shows.
pub fn list_trash(vault_root: &str) -> Result<Vec<TrashEntry>, String> {
    let trash_root = Path::new(vault_root).join(".nekowite-trash");
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(&trash_root) {
        Ok(rd) => rd,
        // No trash directory means nothing was ever deleted — an empty list is
        // the truth. A directory that exists but cannot be read is not the same
        // thing: showing "the trash is empty" would tell the user their deleted
        // notes are gone when they are only unreadable.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(fs_error("read the trash folder", &trash_root, e)),
    };
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

/// One trash entry `clear_trash` could not remove.
///
/// `name` is the on-disk key the trash lists (what `restore_from_trash` takes),
/// and `error` is already a user-facing sentence naming the reason.
#[derive(Serialize, Clone, Debug)]
pub struct ClearTrashFailure {
    pub name: String,
    pub error: String,
}

/// What one emptying pass of the trash actually did.
///
/// A partial pass is an ordinary outcome (one file still held open by another
/// program), not a failed command: reporting it as an error lost the count of
/// everything that WAS removed, so the window could only say "failed" over a
/// half-empty trash. `removed` is always the truth and `failed` names what is
/// still there, so the caller can report both honestly.
#[derive(Serialize, Clone, Debug)]
pub struct ClearTrashReport {
    pub removed: usize,
    pub failed: Vec<ClearTrashFailure>,
}

/// Permanently delete every entry under `.nekowite-trash/`, reporting how many
/// were removed and which ones could not be. A missing trash directory is not
/// an error - it returns an empty report.
///
/// Only direct children of the trash directory are touched (each is the single
/// encoded, safe component [`delete_file`] wrote), so traversal is impossible;
/// the defensive `.`/`..`/empty-name guard is belt and braces rather than a
/// requirement.
pub fn clear_trash(vault_root: &str) -> Result<ClearTrashReport, String> {
    let trash_root = Path::new(vault_root).join(".nekowite-trash");
    if !trash_root.exists() {
        return Ok(ClearTrashReport {
            removed: 0,
            failed: Vec::new(),
        });
    }
    let rd = std::fs::read_dir(&trash_root)
        .map_err(|e| fs_error("read the trash folder", &trash_root, e))?;
    let mut removed = 0usize;
    let mut failed: Vec<ClearTrashFailure> = Vec::new();
    for entry in rd {
        // An iteration failure means we cannot know which entries we never saw,
        // so refuse the pass instead of reporting a clean sweep over a trash
        // the process could not enumerate.
        let entry = entry.map_err(|e| fs_error("read the trash folder", &trash_root, e))?;
        let p = entry.path();
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        // Keep going after a failure: one locked file (another program holding
        // it, a permission problem) used to abort the whole clear and report a
        // bare error - while everything already deleted stayed deleted, so the
        // user saw a failed clear over a half-empty trash with no way to tell
        // which half had actually gone.
        let result = if p.is_dir() {
            std::fs::remove_dir_all(&p)
        } else {
            std::fs::remove_file(&p)
        };
        match result {
            Ok(()) => removed += 1,
            Err(e) => failed.push(ClearTrashFailure {
                name,
                error: fs_error("delete", &p, e),
            }),
        }
    }
    Ok(ClearTrashReport { removed, failed })
}

/// Move a trash entry back to its original vault path. If that path is now
/// occupied, insert `-restored-<ts>` before the extension and return the new
/// path. A missing parent folder (the original directory was deleted too) is
/// created on the way.
pub fn restore_from_trash(vault_root: &str, trash_path: &str) -> Result<String, String> {
    let resolved_trash = resolve_within(vault_root, trash_path)?;
    let trash_root = Path::new(vault_root).join(".nekowite-trash");
    let canonical_trash = trash_root
        .canonicalize()
        .map_err(|e| fs_error("open the trash folder", &trash_root, e))?;
    if !resolved_trash.starts_with(&canonical_trash) {
        return Err("trash path outside .nekowite-trash".into());
    }
    let name = resolved_trash
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let original_rel = decode_trash_key(&name);
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
        let parent = target.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let fname = target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        target = parent.join(name_with_suffix(&fname, &format!("-restored-{ts}")));
    }
    if let Some(parent) = target.parent() {
        // The original folder may itself be gone by restore time (`docs/` was
        // deleted after `docs/a.md`). `rename` cannot create it — mirror
        // `file_store::rename_entry`, which already does.
        std::fs::create_dir_all(parent).map_err(|e| {
            format!(
                "cannot restore: the folder for {} could not be created ({e}); \
                 remove whatever occupies that path and try again",
                crate::domain::path_policy::ipc_path(&target)
            )
        })?;
    }
    std::fs::rename(&resolved_trash, &target).map_err(|e| {
        format!(
            "cannot restore to {}: {e}; check that the location is writable and try again",
            crate::domain::path_policy::ipc_path(&target)
        )
    })?;
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
        let new_name = format!("{to_key}{stamp}");
        let mut target = trash_root.join(&new_name);
        // A collision stamp has to stay exactly 13 digits — that shape is how
        // `strip_collision_suffix` tells a disambiguating stamp from a name that
        // legitimately ends in digits — so bump the stamp instead of appending to
        // it. Bumping also guarantees a free name: `fs::rename` REPLACES an
        // existing file on Windows, so reusing the first candidate would destroy
        // the entry already sitting there.
        let mut ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        while target.exists() {
            ts = ts.saturating_add(1);
            target = trash_root.join(format!("{new_name}-{ts}"));
        }
        let _ = std::fs::rename(&p, &target);
    }
}
