//! Emptying the trash: permanently removing every entry under
//! `.nekowite-trash/`, and reporting honestly what that did.
//!
//! Split out of [`super::trash_store`], which is the trash as a place things go
//! and come back from. This is the one operation that DESTROYS rather than
//! moves, and it is the only one that can half-succeed — a file held open by
//! another program leaves the pass partially done — so its report types and its
//! keep-going policy are a unit of their own rather than a fourth verb in the
//! store.
//!
//! [`super::trash_store`] re-exports these names, so `commands::recovery` keeps
//! the import it had.

use serde::Serialize;

use crate::domain::path_policy::find_vault_metadata_dir;
use crate::errors::fs_error;

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
/// encoded, safe component [`super::trash_store::delete_file`] wrote), so
/// traversal is impossible; the defensive `.`/`..`/empty-name guard is belt and
/// braces rather than a requirement.
pub fn clear_trash(vault_root: &str) -> Result<ClearTrashReport, String> {
    let Some(trash_root) = find_vault_metadata_dir(vault_root, &[".nekowite-trash"])? else {
        return Ok(ClearTrashReport {
            removed: 0,
            failed: Vec::new(),
        });
    };
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
