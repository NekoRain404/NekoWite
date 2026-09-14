//! Putting ONE trashed entry back where it came from.
//!
//! Split out of [`super::trash_store`], which is the trash as a place things go
//! (delete, list, follow a rename). This is the one operation that reads an
//! entry's name back into a vault path and then has to CLAIM a destination that
//! may already be taken — a policy with its own failure modes, its own naming
//! rule and its own loop, none of which the rest of the store shares.
//!
//! [`super::trash_store`] re-exports [`restore_from_trash`], so
//! `commands::recovery` and the integration tests keep the import they had.
//!
//! The entry-name vocabulary (`decode_trash_key`, `strip_collision_suffix`)
//! stays in `trash_store`: three of that module's operations speak it, so it
//! belongs with the store rather than with any one verb.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::path_policy::{find_vault_metadata_dir, ipc_path, is_safe_rel, resolve_within};
use crate::errors::fs_error;
use crate::storage::file_store;

use super::trash_store::decode_trash_key;

/// Insert `suffix` before the extension (`a.md` -> `a-restored-1.md`) so a
/// name-collision restore keeps a recognised extension. Appending after it
/// produced `a.md-restored-1`, which no note loader can open.
fn name_with_suffix(name: &str, suffix: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem}{suffix}.{ext}"),
        _ => format!("{name}{suffix}"),
    }
}

/// How many `-restored-<stamp>` names a restore may try before it gives up, so
/// a folder that holds every candidate cannot make the loop spin forever.
const RESTORE_NAME_ATTEMPTS: u32 = 64;

/// Move a trash entry back to its original vault path. If that path is taken,
/// insert `-restored-<ts>` before the extension and return the new path. A
/// missing parent folder (the original directory was deleted too) is created on
/// the way.
///
/// The destination is claimed by the move itself rather than by an `exists()`
/// probe. Two restores of entries that share one original path run in the same
/// millisecond, compute the SAME `-restored-<ts>` name, and the second
/// `fs::rename` then replaced the file the first had just restored: a deleted
/// note was destroyed by restoring another one, and both callers were told they
/// had succeeded with the same path. A taken name now pushes the attempt to the
/// next stamp instead.
pub fn restore_from_trash(vault_root: &str, trash_path: &str) -> Result<String, String> {
    let resolved_trash = resolve_within(vault_root, trash_path)?;
    // The containment check below can only mean something if the trash root
    // itself is known to be inside the vault: a symlinked `.nekowite-trash`
    // would put both paths outside it, where they would agree with each other.
    let trash_root = find_vault_metadata_dir(vault_root, &[".nekowite-trash"])?
        .ok_or_else(|| "there is nothing to restore: the trash is empty".to_string())?;
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
    if let Some(parent) = original_abs.parent() {
        // The original folder may itself be gone by restore time (`docs/` was
        // deleted after `docs/a.md`). `rename` cannot create it — mirror
        // `file_store::rename_entry`, which already does.
        std::fs::create_dir_all(parent).map_err(|e| {
            format!(
                "cannot restore: the folder for {} could not be created ({e}); \
                 remove whatever occupies that path and try again",
                ipc_path(&original_abs)
            )
        })?;
    }
    let fname = original_abs
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let parent = original_abs
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    let mut ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let mut target = original_abs;
    for attempt in 0..=RESTORE_NAME_ATTEMPTS {
        match file_store::move_no_clobber(&resolved_trash, &target) {
            Ok(()) => return Ok(ipc_path(&target)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if attempt == RESTORE_NAME_ATTEMPTS {
                    break;
                }
                // Bump rather than stack a second stamp, so the name keeps the
                // single `-restored-<ms>` shape the frontend shows.
                ts = ts.saturating_add(1);
                target = parent.join(name_with_suffix(&fname, &format!("-restored-{ts}")));
            }
            Err(e) => {
                return Err(format!(
                    "cannot restore to {}: {e}; check that the location is writable and try again",
                    ipc_path(&target)
                ))
            }
        }
    }
    Err(format!(
        "cannot restore to {}: every restored name is taken; rename or remove one of them and try again",
        ipc_path(&target)
    ))
}
