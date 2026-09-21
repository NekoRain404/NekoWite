//! Creating and writing: the atomic replace and its failure path, the refusal to overwrite bytes
//! that are not UTF-8, the save that must survive a history snapshot that cannot be written, the
//! concurrent writers that share one vault, the stale-`.tmp` sweeper, directory creation, and the
//! create-new-note that must never replace a note already there.

use super::support::temp_vault;
use nekowite_lib::errors::ALREADY_EXISTS_PREFIX;
use nekowite_lib::storage::file_store::{
    atomic_write, cleanup_stale_tmp, create_dir, create_new_file, list_history, read_file,
    write_file,
};

#[test]
fn atomic_write_replaces_and_fails_safely() {
    let dir = std::env::temp_dir().join(format!("nkw_atomic_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let target = dir.join("note.md");

    atomic_write(&target, "v1").unwrap();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "v1");
    atomic_write(&target, "v2").unwrap();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "v2");

    // Failure path: renaming a file onto an existing directory fails, and the
    // temp sibling must be cleaned up so no `.tmp` litter is left behind.
    let dir_target = dir.join("adir");
    std::fs::create_dir_all(&dir_target).unwrap();
    assert!(atomic_write(&dir_target, "boom").is_err());
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "no .tmp files left behind");

    std::fs::remove_dir_all(&dir).unwrap();
}

/// Writing over a non-UTF-8 file is refused instead of destroying it without
/// a snapshot.
#[test]
fn write_file_refuses_non_utf8_overwrite() {
    let vault = temp_vault("binary");
    let root = vault.to_str().unwrap().to_string();
    let target = vault.join("blob.md");
    let original = vec![0xffu8, 0xfe, 0x00, 0x01];
    std::fs::write(&target, &original).unwrap();

    let err = write_file(&root, "blob.md", "text", None).unwrap_err();
    assert!(err.contains("not valid UTF-8"), "got: {err}");
    assert_eq!(std::fs::read(&target).unwrap(), original, "bytes untouched");

    std::fs::remove_dir_all(&vault).unwrap();
}

/// `create_dir` makes nested directories and reports canonical relative paths;
/// duplicates and traversal are rejected.
#[test]
fn create_dir_nests_and_guards() {
    let vault = temp_vault("create-dir");
    let root = vault.to_str().unwrap().to_string();

    let rel = create_dir(&root, "notes/sub").unwrap();
    assert_eq!(rel, "notes/sub");
    assert!(vault.join("notes/sub").is_dir());

    assert!(create_dir(&root, "notes/sub").is_err());
    assert!(create_dir(&root, "../escape").is_err());
    assert!(create_dir(&root, "").is_err());

    std::fs::remove_dir_all(&vault).unwrap();
}

/// A history-snapshot failure must never turn into "your note could not be
/// saved" — the snapshot is the optional part, the write is the point.
///
/// The snapshot directory is made uncreatable here by placing a FILE where the
/// history directory belongs, which is what a permissions problem, a full disk
/// or a quota error ultimately look like to `create_dir_all`. Before this, the
/// error propagated out of `write_file` and the note could not be edited at all
/// (the on-disk text stayed at the old revision, with a bare OS error shown to
/// the user) until an unrelated problem was fixed by hand.
#[test]
fn write_file_saves_even_when_history_cannot_be_written() {
    let vault = temp_vault("write-history-blocked");
    let root = vault.to_str().unwrap().to_string();
    let path = "note.md";

    write_file(&root, path, "v1", Some(10)).unwrap();

    // Occupy the history directory's path with a file.
    std::fs::create_dir_all(vault.join(".nekowite")).unwrap();
    std::fs::write(vault.join(".nekowite").join("history"), "not a dir").unwrap();

    let result = write_file(&root, path, "v2", Some(10));

    let warning = result.expect("the save must succeed even when history cannot be written");
    assert!(
        warning.is_some(),
        "a failed snapshot has to be reported, not swallowed"
    );
    let warning = warning.unwrap();
    assert!(
        warning.contains("Saved"),
        "the message must make clear the text WAS saved: {warning}"
    );
    assert_eq!(
        std::fs::read_to_string(vault.join(path)).unwrap(),
        "v2",
        "the note body is the newest text"
    );

    std::fs::remove_dir_all(&vault).unwrap();
}

/// The happy path reports nothing, so a warning always means something happened.
#[test]
fn write_file_reports_no_warning_on_a_normal_save() {
    let vault = temp_vault("write-no-warning");
    let root = vault.to_str().unwrap().to_string();
    write_file(&root, "a.md", "v1", Some(10)).unwrap();
    let warning = write_file(&root, "a.md", "v2", Some(10)).unwrap();
    assert_eq!(warning, None);
    assert!(
        !list_history(&root, "a.md").unwrap().is_empty(),
        "history was kept"
    );
    std::fs::remove_dir_all(&vault).unwrap();
}

/// Concurrent `write_file`s on the same vault never panic, leave no `.tmp`
/// litter, and never corrupt the file: the read-old -> snapshot -> write
/// sequence is serialized, and the final content is one written payload.
#[test]
fn write_file_concurrent_serializes() {
    let vault = temp_vault("write-concurrent");
    let root = vault.to_str().unwrap().to_string();
    let path = "note.md";

    write_file(&root, path, "seed", Some(10)).unwrap();

    let mut handles = Vec::new();
    for i in 0..16 {
        let root = root.clone();
        handles.push(std::thread::spawn(move || {
            let content = format!("payload-{i}");
            for _ in 0..50 {
                write_file(&root, "note.md", &content, Some(10)).unwrap();
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }

    let final_content = read_file(&root, path).unwrap();
    assert!(
        final_content.starts_with("payload-"),
        "final content is one of the written payloads, got {final_content:?}"
    );

    // No crash litter: every successful write renamed its temp into place.
    let tmp: Vec<_> = std::fs::read_dir(&vault)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(tmp.is_empty(), "no .tmp litter after concurrent writes");

    std::fs::remove_dir_all(&vault).unwrap();
}

/// `cleanup_stale_tmp` removes only `.tmp` siblings older than `max_age`,
/// leaving fresh temp files, directories, and unrelated files untouched.
#[test]
fn cleanup_stale_tmp_removes() {
    let dir = temp_vault("tmp-clean");
    let old_tmp = dir.join(".nekowite-111.tmp");
    let fresh_tmp = dir.join(".nekowite-222.tmp");
    std::fs::write(&old_tmp, "stale").unwrap();

    // Let the stale file age well past the threshold, then create the fresh
    // one so the two differ by far more than any mtime granularity.
    std::thread::sleep(std::time::Duration::from_millis(100));
    std::fs::write(&fresh_tmp, "fresh").unwrap();
    std::fs::write(dir.join("keep.md"), "keep").unwrap();
    let max_age = std::time::Duration::from_millis(20);

    let removed = cleanup_stale_tmp(&dir, max_age).unwrap();
    assert_eq!(removed, 1, "exactly the stale tmp is removed");
    assert!(!old_tmp.exists(), "stale tmp removed");
    assert!(fresh_tmp.exists(), "fresh tmp kept");
    assert!(dir.join("keep.md").exists(), "non-tmp file untouched");

    // A directory named `*.tmp` must never be deleted.
    std::fs::create_dir_all(dir.join(".nekowite-333.tmp")).unwrap();
    assert_eq!(cleanup_stale_tmp(&dir, max_age).unwrap(), 0);

    std::fs::remove_dir_all(&dir).unwrap();
}

/// A `.tmp` file that is not OURS must survive the sweeper.
///
/// The check used to be "does the name end in `.tmp`", which claimed every file
/// with that extension anywhere in the vault. A note's folder holding
/// `draft.tmp` (the user's own scratch file, or another tool's) had it deleted
/// by the next save in that folder — permanently: not to the trash, and with no
/// history snapshot, so there was nothing to restore.
#[test]
fn cleanup_stale_tmp_leaves_other_tmp_style_files_alone() {
    let dir = temp_vault("tmp-clean-foreign");
    let max_age = std::time::Duration::from_millis(20);
    // All old enough to be swept, none of them shaped like our staging files.
    // `.note.<digits>.tmp` is the shape the writer used BEFORE the fixed prefix,
    // and it is foreign for the same reason as the rest: nothing tells it apart
    // from a user's or a backup tool's `.photos.2024.tmp` except a guess, and
    // the two ways of being wrong do not compare — litter stays hidden and
    // harmless, a false positive deletes something the user still has.
    const FOREIGN: [&str; 5] = [
        "draft.tmp",
        "notes.tmp",
        ".hidden.tmp",
        ".x.notanonce.tmp",
        ".note.1757520000000000000.tmp",
    ];
    for name in FOREIGN {
        std::fs::write(dir.join(name), "user data").unwrap();
    }
    // Our own staging shape, written at the same time so it is equally stale:
    // it IS swept, so crash litter still gets reclaimed.
    std::fs::write(dir.join(".nekowite-1757520000000000000.tmp"), "ours").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(80));

    assert_eq!(
        cleanup_stale_tmp(&dir, max_age).unwrap(),
        1,
        "only our own staging file is reclaimed"
    );
    assert!(!dir.join(".nekowite-1757520000000000000.tmp").exists());
    for name in FOREIGN {
        assert!(dir.join(name).exists(), "{name} must survive");
    }

    std::fs::remove_dir_all(&dir).unwrap();
}

/// Creating a note must never replace one that is already there.
///
/// `ensureDailyNote` checked the folder, picked a free name and then wrote, so a
/// second writer (another instance of the app, a sync client, the user in
/// Explorer) could slip a file in between: the write then landed on top of it
/// and that file was gone. `create_new_file` makes the check and the creation one
/// atomic step, and reports a taken name with a marker the caller can retry on
/// instead of showing the user an OS error for something that is not one.
#[test]
fn create_new_file_never_replaces_an_existing_note() {
    let vault = temp_vault("create-new-file");
    let root = vault.to_str().unwrap().to_string();

    // The folder does not exist yet: creating the note creates it.
    create_new_file(&root, "daily/2026-01-05.md", "mine").unwrap();
    assert_eq!(
        std::fs::read(vault.join("daily").join("2026-01-05.md")).unwrap(),
        b"mine",
        "the template bytes land verbatim"
    );

    let err = create_new_file(&root, "daily/2026-01-05.md", "theirs").unwrap_err();
    assert!(
        err.starts_with(ALREADY_EXISTS_PREFIX),
        "the caller has to tell 'taken' from 'broken': {err}"
    );
    assert_eq!(
        read_file(&root, "daily/2026-01-05.md").unwrap(),
        "mine",
        "the existing note was left untouched"
    );

    // A free name is still created, and the refused attempt left no litter
    // behind: a staging file next to the note would be a file the user sees.
    create_new_file(&root, "daily/2026-01-06.md", "next").unwrap();
    let leftovers: Vec<String> = std::fs::read_dir(vault.join("daily"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with('.'))
        .collect();
    assert!(
        leftovers.is_empty(),
        "staging litter left behind: {leftovers:?}"
    );

    std::fs::remove_dir_all(&vault).unwrap();
}
