//! What a save that cannot complete must not cost.
//!
//! The audit found the write path correct and found two defects in what
//! surrounds it, both reached by one note: a file name long enough to overflow
//! `NAME_MAX` once the staged sibling is named after it. The staged name was
//! the defect (a staged file has no reason to carry its target's name), and the
//! history eviction that followed the failure was the damage.
//!
//! Both are pinned here against a real filesystem, under `/tmp`, because both
//! are about what the syscalls leave behind. The byte counts are exact: the
//! limit is in BYTES, so it arrives at roughly a 70-character Chinese title,
//! which is an ordinary note title rather than an exotic one.

use nekowite_lib::storage::file_store::{list_history, read_history, write_file};
use std::path::PathBuf;

fn temp_vault(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nekowite-failed-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A file name of EXACTLY `bytes` bytes, reading like a note title.
///
/// Chinese characters are three bytes each in UTF-8, which is what makes the
/// limit arrive at an ordinary title: `NAME_MAX` is 255 *bytes*, and the
/// staging suffix the writer adds is tens of bytes, so a 70-character Chinese
/// title is already past it. The helper asserts its own byte count, because a
/// helper that silently produced a shorter name would make every test below
/// pass for a reason that has nothing to do with the limit.
fn name_of_bytes(bytes: usize) -> String {
    let stem = bytes
        .checked_sub(3)
        .expect("the `.md` extension alone is three bytes");
    let mut name = "笔".repeat(stem / 3);
    name.push_str(&"a".repeat(stem % 3));
    name.push_str(".md");
    assert_eq!(name.len(), bytes, "the byte count is the whole point");
    name
}

/// The history versions of a note, by CONTENT: the ids are timestamps, so a
/// list that rotated would compare unequal for a reason that is not a version
/// being lost.
fn versions(vault_root: &str, path: &str) -> Vec<String> {
    let mut out: Vec<String> = list_history(vault_root, path)
        .unwrap()
        .iter()
        .map(|e| read_history(vault_root, path, &e.id).unwrap())
        .collect();
    out.sort();
    out
}

/// The name the audit measured: 212 bytes is one byte past the largest name a
/// staged sibling can carry today (211), so the save fails and the note is
/// unsaveable from then on.
#[test]
fn a_note_whose_name_is_212_bytes_can_still_be_saved() {
    let vault = temp_vault("long-name");
    let root = vault.to_str().unwrap().to_string();
    let name = name_of_bytes(212);
    // The note arrives from outside the save path — a sync client, another
    // editor, the user in their file manager — which is why it can exist at a
    // length this app's own writer cannot stage.
    std::fs::write(vault.join(&name), "on disk").unwrap();

    let result = write_file(&root, &name, "edited", Some(10));

    assert!(
        result.is_ok(),
        "a name the filesystem accepts must be a name this app can save: {result:?}"
    );
    assert_eq!(
        std::fs::read_to_string(vault.join(&name)).unwrap(),
        "edited"
    );
    let _ = std::fs::remove_dir_all(&vault);
}

/// A save that fails AFTER its version was staged must not evict anything.
///
/// This is the half of the audit's finding that outlives the name fix: the
/// name made the failure ordinary, but any failure that reaches the publish
/// costs a version when the eviction runs before it. A save that fails and then
/// quietly drops the version the user would need to recover from, while telling
/// them nothing they can act on, is the compounding kind of defect — and the
/// ten slots fill with duplicates of a file that never changed.
///
/// The failure is a directory that refuses new entries while the file inside it
/// stays writable, which is what makes this the interesting case: the read-only
/// FILE is refused earlier, before anything is staged, and is pinned in
/// `atomic_write_test.rs`. Here the version is staged, the publish is the step
/// that fails, and the version has to be given back.
///
/// Constructed under `/tmp` — a scratch vault of this test's own — never on a
/// real vault.
#[test]
#[cfg(unix)]
fn a_failed_save_keeps_the_history_it_would_have_evicted() {
    use std::os::unix::fs::PermissionsExt;

    let vault = temp_vault("failed-save-history");
    let root = vault.to_str().unwrap().to_string();
    let dir = vault.join("locked");
    std::fs::create_dir_all(&dir).unwrap();

    for i in 1..=11 {
        write_file(&root, "locked/note.md", &format!("v{i}"), Some(10)).unwrap();
    }
    let before = versions(&root, "locked/note.md");
    assert_eq!(
        before.len(),
        10,
        "the setup needs a full history to evict from"
    );

    // The note itself stays writable: only the directory refuses new names, so
    // the save gets all the way to staging its temp sibling before it fails.
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();

    for _ in 0..3 {
        let error = write_file(&root, "locked/note.md", "typed", Some(10))
            .expect_err("a directory that refuses the staged sibling must fail the save");
        assert!(
            error.contains("temporary file"),
            "the premise is a failure at the publish, not before it: {error}"
        );
    }

    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        versions(&root, "locked/note.md"),
        before,
        "three saves that never reached the file rewrote the history of a note that never changed"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("note.md")).unwrap(),
        "v11",
        "nothing reached the note either"
    );
    // The staged sibling of a failed publish is cleaned up, so the history
    // directory holds no litter a later prune would have to count.
    assert!(
        std::fs::read_dir(vault.join(".nekowite/history"))
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().ends_with(".tmp")),
        "a failed save left staged litter in the history tree"
    );
    let _ = std::fs::remove_dir_all(&vault);
}
