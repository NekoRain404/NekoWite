//! The version history: what a save snapshots, the prune cap, restoring a version (including the
//! snapshot of the content the restore itself replaces), collision-free snapshot names, and the
//! guard on the id the panel hands back.

use super::support::{temp_vault, tick};
use nekowite_lib::domain::path_policy::encode_rel_path;
use nekowite_lib::storage::file_store::{
    list_history, read_file, read_history, restore_history, snapshot_history, write_file,
};

#[test]
fn history_snapshot_and_max_prune() {
    let vault = temp_vault("history");
    let root = vault.to_str().unwrap().to_string();
    let path = "docs/note.md".to_string();

    write_file(&root, &path, "v1", Some(2)).unwrap();
    tick();
    write_file(&root, &path, "v2", Some(2)).unwrap();
    tick();
    write_file(&root, &path, "v3", Some(2)).unwrap();
    tick();
    write_file(&root, &path, "v4", Some(2)).unwrap();

    assert_eq!(read_file(&root, &path).unwrap(), "v4");

    let history = list_history(&root, &path).unwrap();
    assert_eq!(history.len(), 2, "history pruned to max 2");
    assert!(history.iter().all(|h| h.id.ends_with(".md")));

    // Newest snapshot holds v3 (the content replaced by the latest save);
    // the oldest surviving snapshot holds v2; the v1 snapshot was pruned.
    let newest = history.first().unwrap();
    assert_eq!(read_history(&root, &path, &newest.id).unwrap(), "v3");
    let oldest = history.last().unwrap();
    assert_eq!(read_history(&root, &path, &oldest.id).unwrap(), "v2");

    // restore_history writes the snapshot back onto the main file.
    let restored = restore_history(&root, &path, &newest.id).unwrap();
    assert_eq!(restored, "v3");
    assert_eq!(read_file(&root, &path).unwrap(), "v3");

    // A subsequent write snapshots the current (non-empty) content, then the
    // directory is pruned back to the max — it never grows past the cap.
    write_file(&root, &path, "", Some(2)).unwrap();
    assert_eq!(list_history(&root, &path).unwrap().len(), 2);

    std::fs::remove_dir_all(&vault).unwrap();
}

/// History keys are built from the canonical vault-relative path, so snapshots
/// taken for a file written via an absolute path (the frontend's spelling) are
/// listed and readable under the relative spelling too.
#[test]
fn history_key_is_spelling_independent() {
    let vault = temp_vault("history-abs");
    let root = vault.to_str().unwrap().to_string();
    std::fs::create_dir_all(vault.join("docs")).unwrap();
    let abs = vault.join("docs/note.md").to_str().unwrap().to_string();

    write_file(&root, &abs, "v1", Some(5)).unwrap();
    write_file(&root, &abs, "v2", Some(5)).unwrap();

    let hist_abs = list_history(&root, &abs).unwrap();
    let hist_rel = list_history(&root, "docs/note.md").unwrap();
    assert_eq!(
        hist_abs.len(),
        1,
        "snapshot taken for the absolute spelling"
    );
    assert_eq!(hist_rel.len(), 1, "same key for the relative spelling");
    assert_eq!(hist_abs[0].id, hist_rel[0].id);
    assert_eq!(
        read_history(&root, "docs/note.md", &hist_rel[0].id).unwrap(),
        "v1"
    );

    // Restoring through the other spelling works as well.
    let restored = restore_history(&root, &abs, &hist_rel[0].id).unwrap();
    assert_eq!(restored, "v1");
    assert_eq!(read_file(&root, "docs/note.md").unwrap(), "v1");

    std::fs::remove_dir_all(&vault).unwrap();
}

/// Restoring a version must first snapshot the content it replaces, so a
/// restore can itself be undone. (New behavior: previously the replaced
/// content was lost irrecoverably.)
#[test]
fn restore_history_snapshots_replaced_content() {
    let vault = temp_vault("restore-snap");
    let root = vault.to_str().unwrap().to_string();
    let path = "docs/note.md";

    write_file(&root, path, "v1", Some(5)).unwrap();
    tick();
    write_file(&root, path, "v2", Some(5)).unwrap();
    let oldest = list_history(&root, path).unwrap().pop().unwrap();
    assert_eq!(read_history(&root, path, &oldest.id).unwrap(), "v1");

    let restored = restore_history(&root, path, &oldest.id).unwrap();
    assert_eq!(restored, "v1");
    assert_eq!(read_file(&root, path).unwrap(), "v1");

    let history = list_history(&root, path).unwrap();
    let contents: Vec<String> = history
        .iter()
        .map(|h| read_history(&root, path, &h.id).unwrap())
        .collect();
    assert!(
        contents.contains(&"v2".to_string()),
        "replaced v2 kept as a snapshot, got {contents:?}"
    );

    // And the restore can be undone from the panel.
    let v2_id = history
        .iter()
        .find(|h| read_history(&root, path, &h.id).unwrap() == "v2")
        .map(|h| h.id.clone())
        .expect("v2 snapshot present");
    assert_eq!(restore_history(&root, path, &v2_id).unwrap(), "v2");
    assert_eq!(read_file(&root, path).unwrap(), "v2");

    std::fs::remove_dir_all(&vault).unwrap();
}

/// A snapshot must never overwrite an existing snapshot that claimed the same
/// millisecond name: the writer adds a numeric suffix instead.
#[test]
fn snapshot_collisions_get_a_numeric_suffix() {
    let vault = temp_vault("snapshot-suffix");
    let root = vault.to_str().unwrap().to_string();
    write_file(&root, "note.md", "seed", Some(5)).unwrap();

    let history_dir = vault.join(".nekowite").join("history").join("note.md");
    std::fs::create_dir_all(&history_dir).unwrap();
    // Plant a snapshot named with the current millisecond so the next
    // snapshot_history call collides with it.
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    std::fs::write(history_dir.join(format!("{ms}.md")), "planted").unwrap();

    snapshot_history(&root, "note.md", "fresh snapshot", 5).unwrap();

    let planted = std::fs::read_to_string(history_dir.join(format!("{ms}.md"))).unwrap();
    assert_eq!(planted, "planted", "existing snapshot not overwritten");
    let snapshots: Vec<(String, String)> = std::fs::read_dir(&history_dir)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".md"))
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let content = std::fs::read_to_string(e.path()).unwrap();
            (name, content)
        })
        .collect();
    assert_eq!(snapshots.len(), 2, "a second snapshot file exists");
    assert!(snapshots.iter().any(|(_, c)| c == "fresh snapshot"));

    std::fs::remove_dir_all(&vault).unwrap();
}

/// The history id is joined onto a directory path, so anything that is not a
/// plain file name must be rejected.
#[test]
fn read_history_rejects_unsafe_ids() {
    let vault = temp_vault("id-guard");
    let root = vault.to_str().unwrap().to_string();
    write_file(&root, "note.md", "v1", Some(5)).unwrap();
    write_file(&root, "note.md", "v2", Some(5)).unwrap();
    let good = list_history(&root, "note.md").unwrap().remove(0).id;

    for bad in [
        "../escape.md",
        "a/b.md",
        "a\\b.md",
        "a:b.md",
        "/abs.md",
        "C:\\abs.md",
        ".",
        "..",
        ".hidden",
    ] {
        assert!(
            read_history(&root, "note.md", bad).is_err(),
            "id {bad:?} must be rejected"
        );
    }
    assert_eq!(
        read_history(&root, "note.md", &good).unwrap(),
        "v1",
        "a valid id still reads (the snapshot holds the replaced v1)"
    );

    std::fs::remove_dir_all(&vault).unwrap();
}

/// "There is no history" and "the history is unreadable" are different answers.
///
/// The list used to swallow every error in the read and return an empty list,
/// which the panel renders as "no versions for this note" — telling the user
/// their snapshots are gone when they are only unreadable (a permission change,
/// a file where the directory should be).
#[test]
fn list_history_distinguishes_missing_from_unreadable() {
    let vault = temp_vault("history-unreadable");
    let root = vault.to_str().unwrap().to_string();
    let path = "a.md";
    write_file(&root, path, "v1", Some(10)).unwrap();

    // No history directory yet: an empty list is the truth.
    assert!(list_history(&root, path).unwrap().is_empty());

    let encoded = encode_rel_path(path);
    let history_dir = vault.join(".nekowite").join("history");
    std::fs::create_dir_all(history_dir.join(&encoded)).unwrap();
    snapshot_history(&root, path, "old", 10).unwrap();
    assert!(!list_history(&root, path).unwrap().is_empty());

    // Replace the per-note directory with a file of the same name.
    std::fs::remove_dir_all(history_dir.join(&encoded)).unwrap();
    std::fs::write(history_dir.join(&encoded), "not a directory").unwrap();

    let result = list_history(&root, path);
    assert!(result.is_err(), "unreadable history must not read as empty");

    std::fs::remove_dir_all(&vault).unwrap();
}
