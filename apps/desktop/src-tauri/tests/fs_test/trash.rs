//! Deleting into the trash and getting the file back: what deliberately skips the trash (internal
//! bookkeeping and the staging area), the list/restore/clear semantics for files and folders, the
//! report a partial or total failure of a clear has to carry, and the actionable message a blocked
//! restore has to produce.

use super::support::{rel, temp_vault};
use nekowite_lib::storage::file_store::{list_dir, read_file, write_file};
use nekowite_lib::storage::trash_store::{
    clear_trash, delete_file, list_trash, restore_from_trash,
};
use std::path::{Path, PathBuf};

#[test]
fn deleting_internal_bookkeeping_skips_the_trash() {
    // The index is written atomically through `.nekowite/index/*.tmp` staging
    // files, and each write removes its temp afterwards. That removal goes
    // through `delete_file`, so routing it to the trash deposited
    // `%2Enekowite%2Findex%2Fshard-*.json.tmp` junk in the user's 回收站 on
    // every rebuild — entries no user gesture could ever have created.
    let vault = temp_vault("internal-trash");
    let root = vault.to_str().unwrap().to_string();

    std::fs::create_dir_all(vault.join(".nekowite/index")).unwrap();
    std::fs::write(vault.join(".nekowite/index/shard-1.json.tmp"), "{}").unwrap();
    std::fs::write(vault.join(".nekowite/index/manifest.json"), "{}").unwrap();

    let returned = delete_file(&root, ".nekowite/index/shard-1.json.tmp").unwrap();
    // Permanently gone, and nothing was moved into the trash.
    assert!(!vault.join(".nekowite/index/shard-1.json.tmp").exists());
    assert_eq!(returned, "");
    assert!(list_trash(&root).unwrap().is_empty());
    let trash_dir = vault.join(".nekowite-trash");
    let depositted = if trash_dir.exists() {
        std::fs::read_dir(&trash_dir).unwrap().count()
    } else {
        0
    };
    assert_eq!(depositted, 0, "internal delete must not populate the trash");

    // A user note still goes to the trash (the recoverable path is unchanged).
    write_file(&root, "note.md", "keep me", Some(10)).unwrap();
    let trashed = delete_file(&root, "note.md").unwrap();
    assert!(trashed.contains(".nekowite-trash"));
    assert_eq!(list_trash(&root).unwrap().len(), 1);

    std::fs::remove_dir_all(&vault).unwrap();
}

#[test]
fn list_trash_purges_legacy_internal_entries() {
    // Vaults that already ran the leaking build carry those entries; listing
    // must not keep offering them (they can never be a deleted note).
    let vault = temp_vault("legacy-trash");
    let root = vault.to_str().unwrap().to_string();
    let trash_dir = vault.join(".nekowite-trash");
    std::fs::create_dir_all(&trash_dir).unwrap();

    let legacy = trash_dir.join("%2Enekowite%2Findex%2Fshard-3.json.tmp");
    std::fs::write(&legacy, "{}").unwrap();
    // Same for the `.tmp` staging area: staged assets are not user notes.
    let staged = trash_dir.join("%2Etmp%2Fpaste-2.png");
    std::fs::write(&staged, "img").unwrap();
    // A real deleted note stays listed.
    write_file(&root, "keep.md", "content", Some(10)).unwrap();
    let real = delete_file(&root, "keep.md").unwrap();

    let listed = list_trash(&root).unwrap();
    assert_eq!(listed.len(), 1);
    assert!(listed[0].trash_path == real);
    assert!(!legacy.exists(), "legacy internal entry should be purged");
    assert!(!staged.exists(), "legacy .tmp entry should be purged");

    std::fs::remove_dir_all(&vault).unwrap();
}

#[test]
fn trash_delete_and_restore_roundtrip() {
    let vault = temp_vault("trash");
    let root = vault.to_str().unwrap().to_string();

    write_file(&root, "docs/a.md", "hello", Some(10)).unwrap();
    let trash_path = delete_file(&root, "docs/a.md").unwrap();
    assert!(trash_path.contains(".nekowite-trash"));
    assert!(!vault.join("docs/a.md").exists());

    let trash = list_trash(&root).unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].original_path, "docs/a.md");
    assert_eq!(trash[0].trash_path, trash_path);

    // The trash dir itself is hidden from listings.
    let listing = list_dir(&root, Some(".")).unwrap();
    let names: Vec<String> = listing.iter().map(|e| e.name.clone()).collect();
    assert!(!names.contains(&".nekowite-trash".into()));
    assert!(!names.contains(&".nekowite".into()));

    let restored = restore_from_trash(&root, &trash_path).unwrap();
    assert!(rel(&restored).ends_with("docs/a.md"));
    assert_eq!(read_file(&root, "docs/a.md").unwrap(), "hello");
    assert!(list_trash(&root).unwrap().is_empty());

    // Original occupied → restore lands on a `-restored-<ts>` suffix.
    write_file(&root, "docs/a.md", "new content", Some(10)).unwrap();
    write_file(&root, "docs/a.md", "second", Some(10)).unwrap();
    let trash2 = delete_file(&root, "docs/a.md").unwrap();
    write_file(&root, "docs/a.md", "occupied", Some(10)).unwrap();
    let restored2 = restore_from_trash(&root, &trash2).unwrap();
    assert!(restored2.contains("-restored-"));
    assert_eq!(read_file(&root, &restored2).unwrap(), "second");

    std::fs::remove_dir_all(&vault).unwrap();
}

/// `clear_trash` removes every trash entry, reports the count, and is a no-op
/// (an empty report) when the trash directory does not exist.
#[test]
fn clear_trash_empties_the_trash() {
    let vault = temp_vault("clear-trash");
    let root = vault.to_str().unwrap().to_string();

    // A missing trash dir is not an error.
    let empty = clear_trash(&root).unwrap();
    assert_eq!(empty.removed, 0);
    assert!(empty.failed.is_empty());

    write_file(&root, "docs/a.md", "hello", Some(10)).unwrap();
    write_file(&root, "notes/b.md", "world", Some(10)).unwrap();
    delete_file(&root, "docs/a.md").unwrap();
    delete_file(&root, "notes/b.md").unwrap();
    assert_eq!(list_trash(&root).unwrap().len(), 2);

    let report = clear_trash(&root).unwrap();
    assert_eq!(report.removed, 2, "every entry is reported as removed");
    assert!(report.failed.is_empty(), "and none is reported as failed");
    assert!(list_trash(&root).unwrap().is_empty());
    assert!(!vault.join(".nekowite-trash/docs%2Fa.md").exists());
    assert!(!vault.join(".nekowite-trash/notes%2Fb.md").exists());
    // Clearing again is a no-op (the directory persists but is empty).
    assert_eq!(clear_trash(&root).unwrap().removed, 0);

    std::fs::remove_dir_all(&vault).unwrap();
}

/// Deleting a folder moves the whole tree into the trash like a file: it must
/// be LISTED (`is_dir: true`) so the UI offers it back, restore must put the
/// contents back, and `clear_trash` must still remove it recursively as one
/// entry. Previously the listing skipped every non-file entry, so a deleted
/// folder showed as "trash empty" with no way to recover it.
#[test]
fn deleted_directory_is_listed_and_restored_with_contents() {
    let vault = temp_vault("trash-dir");
    let root = vault.to_str().unwrap().to_string();
    std::fs::create_dir_all(vault.join("fld/sub")).unwrap();
    std::fs::write(vault.join("fld/sub/n.md"), "x").unwrap();
    let trash_path = delete_file(&root, "fld").unwrap();
    assert!(!vault.join("fld").exists());

    let listed = list_trash(&root).unwrap();
    assert_eq!(listed.len(), 1, "a deleted folder must be listed");
    assert!(listed[0].is_dir, "the folder entry reports is_dir");
    assert_eq!(listed[0].original_path, "fld");
    assert_eq!(listed[0].display_name, "fld");
    assert_eq!(listed[0].trash_path, trash_path);

    let restored = restore_from_trash(&root, &listed[0].trash_path).unwrap();
    assert!(rel(&restored).ends_with("fld"));
    assert_eq!(
        std::fs::read_to_string(vault.join("fld/sub/n.md")).unwrap(),
        "x",
        "restoring a folder restores its contents"
    );

    delete_file(&root, "fld").unwrap();
    assert_eq!(clear_trash(&root).unwrap().removed, 1);
    let rd = std::fs::read_dir(vault.join(".nekowite-trash")).unwrap();
    assert_eq!(rd.flatten().count(), 0, "no leftover trash entries");

    std::fs::remove_dir_all(&vault).unwrap();
}

/// The original folder can be gone by the time the user restores (`docs/` was
/// deleted after `docs/a.md`). `rename` cannot create it, so restore must —
/// mirroring `file_store::rename_entry`. The raw OS error it used to surface
/// could only be answered with "retry", which could never work.
#[test]
fn restore_creates_a_missing_parent_folder() {
    let vault = temp_vault("restore-missing-parent");
    let root = vault.to_str().unwrap().to_string();
    write_file(&root, "docs/a.md", "hello", Some(10)).unwrap();
    let trash_path = delete_file(&root, "docs/a.md").unwrap();
    std::fs::remove_dir_all(vault.join("docs")).unwrap();
    assert!(!vault.join("docs").exists());

    let restored = restore_from_trash(&root, &trash_path).unwrap();
    assert!(rel(&restored).ends_with("docs/a.md"));
    assert_eq!(read_file(&root, "docs/a.md").unwrap(), "hello");

    std::fs::remove_dir_all(&vault).unwrap();
}

/// When the target's folder cannot be created (here a file occupies `docs`),
/// restore still fails — but with a message naming the target and the remedy
/// instead of a bare OS error.
#[test]
fn restore_failure_is_actionable() {
    let vault = temp_vault("restore-blocked-parent");
    let root = vault.to_str().unwrap().to_string();
    write_file(&root, "docs/a.md", "hello", Some(10)).unwrap();
    let trash_path = delete_file(&root, "docs/a.md").unwrap();
    std::fs::remove_dir_all(vault.join("docs")).unwrap();
    std::fs::write(vault.join("docs"), "blocker").unwrap();

    let err = restore_from_trash(&root, &trash_path).unwrap_err();
    assert!(err.contains("restore"), "says what failed: {err}");
    assert!(rel(&err).contains("docs/a.md"), "names the target: {err}");

    std::fs::remove_dir_all(&vault).unwrap();
}

/// The `.tmp` staging area (paste/drop assets of an unsaved tab) is hidden
/// from the file tree like `.nekowite/`, so no user gesture can delete into it.
/// The recovery loop's GC does delete through `delete_file`; trashing those
/// files only moved crash litter into a second hidden directory without
/// reclaiming the disk, and left `%2Etmp%2F…` keys in the trash.
#[test]
fn deleting_staged_tmp_assets_skips_the_trash() {
    let vault = temp_vault("tmp-trash");
    let root = vault.to_str().unwrap().to_string();
    std::fs::create_dir_all(vault.join(".tmp/nested")).unwrap();
    std::fs::write(vault.join(".tmp/paste-1.png"), "img").unwrap();
    std::fs::write(vault.join(".tmp/nested/a.md"), "x").unwrap();

    assert_eq!(delete_file(&root, ".tmp/paste-1.png").unwrap(), "");
    assert!(!vault.join(".tmp/paste-1.png").exists());
    // An internal DIRECTORY goes the same way, recursively.
    assert_eq!(delete_file(&root, ".tmp/nested").unwrap(), "");
    assert!(!vault.join(".tmp/nested").exists());
    assert!(list_trash(&root).unwrap().is_empty());

    std::fs::remove_dir_all(&vault).unwrap();
}

/// Make one direct child of the trash impossible to remove, returning a guard
/// that must stay alive while `clear_trash` runs.
///
/// Windows: hold the file open with sharing disabled - std shares
/// read/write/delete by default, which lets a delete through as
/// delete-pending, so the sharing mode is the whole point.
#[cfg(windows)]
fn make_undeletable(entry: &Path) -> std::fs::File {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(entry)
        .expect("hold the trash entry open")
}

/// Unix: deletion needs write permission on the PARENT, so an entry that is a
/// directory holding an unlistable/unremovable inner directory cannot be
/// removed. The guard restores the mode on drop so cleanup can finish.
#[cfg(unix)]
struct UnreadableDir(PathBuf);

#[cfg(unix)]
impl Drop for UnreadableDir {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
    }
}

#[cfg(unix)]
fn make_undeletable(entry: &Path) -> UnreadableDir {
    use std::os::unix::fs::PermissionsExt;
    // A trashed FILE cannot be frozen on its own here: removing it needs write
    // permission on the trash directory, and taking that away would freeze the
    // sibling entry the partial-pass test needs to stay deletable. Replace it
    // with a directory of the SAME name (so the reported entry name is
    // unchanged) holding an unremovable inner directory, which is what
    // clear_trash trips over.
    if entry.is_file() {
        std::fs::remove_file(entry).unwrap();
    }
    let inner = entry.join("inner");
    std::fs::create_dir_all(&inner).unwrap();
    std::fs::write(inner.join("file"), "x").unwrap();
    std::fs::set_permissions(&inner, std::fs::Permissions::from_mode(0o500)).unwrap();
    UnreadableDir(inner)
}

/// One stuck entry must not turn the whole pass into "failed": the window has
/// to be able to say how many entries WERE removed and which ones are still
/// there.
#[test]
fn clear_trash_reports_a_partial_pass() {
    let vault = temp_vault("trash-partial");
    let root = vault.to_str().unwrap().to_string();
    for name in ["a.md", "b.md"] {
        write_file(&root, name, "x", Some(10)).unwrap();
        delete_file(&root, name).unwrap();
    }
    assert_eq!(list_trash(&root).unwrap().len(), 2);

    let trash_root = vault.join(".nekowite-trash");
    let stuck_name = std::fs::read_dir(&trash_root)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .find(|n| !n.is_empty())
        .unwrap();
    let guard = make_undeletable(&trash_root.join(&stuck_name));

    let report = clear_trash(&root).unwrap();
    drop(guard);

    assert_eq!(
        report.removed + report.failed.len(),
        2,
        "every entry is accounted for exactly once: {report:?}"
    );
    assert_eq!(report.removed, 1, "the free entry was removed: {report:?}");
    assert_eq!(
        report.failed.len(),
        1,
        "the stuck entry was not: {report:?}"
    );
    assert_eq!(
        report.failed[0].name, stuck_name,
        "the stuck entry is named, not just counted"
    );
    assert!(
        !report.failed[0].error.is_empty(),
        "and the reason is carried for the report"
    );
    assert_eq!(
        list_trash(&root).unwrap().len(),
        1,
        "the stuck entry is what is left"
    );

    std::fs::remove_dir_all(&vault).unwrap();
}

/// Nothing removed is still a report, not an error: the caller can say "none
/// of the 2 entries could be deleted, here they are" instead of dropping the
/// count on the floor.
#[test]
fn clear_trash_reports_a_total_failure() {
    let vault = temp_vault("trash-all-stuck");
    let root = vault.to_str().unwrap().to_string();
    for name in ["a.md", "b.md"] {
        write_file(&root, name, "x", Some(10)).unwrap();
        delete_file(&root, name).unwrap();
    }

    let trash_root = vault.join(".nekowite-trash");
    let names: Vec<String> = std::fs::read_dir(&trash_root)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    let guards: Vec<_> = names
        .iter()
        .map(|name| make_undeletable(&trash_root.join(name)))
        .collect();

    let report = clear_trash(&root).unwrap();
    drop(guards);

    assert_eq!(report.removed, 0, "nothing was removed: {report:?}");
    assert_eq!(report.failed.len(), 2, "both entries report a failure");
    let failed_names: Vec<&str> = report.failed.iter().map(|f| f.name.as_str()).collect();
    for name in &names {
        assert!(
            failed_names.contains(&name.as_str()),
            "every stuck entry is named: {report:?}"
        );
    }
    assert_eq!(
        list_trash(&root).unwrap().len(),
        2,
        "both entries are still recoverable"
    );

    std::fs::remove_dir_all(&vault).unwrap();
}
