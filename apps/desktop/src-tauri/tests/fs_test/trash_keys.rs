//! The trash key. A trashed entry's on-disk name is an encoded vault-relative path, and everything
//! the user sees has to decode back to the path they deleted: the display name rather than the key,
//! the entries the previous encoder wrote, and the collision stamp that must never leak into the
//! decoded target.

use super::support::{rel, temp_vault};
use nekowite_lib::domain::path_policy::encode_rel_path;
use nekowite_lib::storage::file_store::{read_file, write_file};
use nekowite_lib::storage::trash_store::{delete_file, list_trash, restore_from_trash};

/// The list is keyed by the encoded on-disk name; that key must not be what
/// the user reads. Deleting `docs/a.md` used to list `docs%2Fa.md`.
#[test]
fn trash_reports_the_deleted_file_name_not_the_key() {
    let vault = temp_vault("trash-display");
    let root = vault.to_str().unwrap().to_string();
    write_file(&root, "docs/a.md", "hello", Some(10)).unwrap();
    delete_file(&root, "docs/a.md").unwrap();

    let listed = list_trash(&root).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "docs%2Fa.md", "the key stays available");
    assert_eq!(listed[0].display_name, "a.md");
    assert_eq!(listed[0].original_path, "docs/a.md");
    assert!(!listed[0].is_dir);

    std::fs::remove_dir_all(&vault).unwrap();
}

/// Trashing the same path twice appends `-<ms>` to the KEY (the first entry
/// still holds the plain key). That stamp must never leak into the decoded
/// target: `a.md-1757520000000` has extension `md-1757…`, so the restored note
/// would not open.
#[test]
fn collided_trash_key_restores_the_original_name() {
    let vault = temp_vault("trash-collision");
    let root = vault.to_str().unwrap().to_string();

    write_file(&root, "docs/a.md", "one", Some(10)).unwrap();
    let first = delete_file(&root, "docs/a.md").unwrap();
    write_file(&root, "docs/a.md", "two", Some(10)).unwrap();
    let second = delete_file(&root, "docs/a.md").unwrap();
    assert_ne!(
        first, second,
        "the second delete must not clobber the first"
    );

    let listed = list_trash(&root).unwrap();
    assert_eq!(listed.len(), 2);
    let plain = listed.iter().find(|e| e.trash_path == first).unwrap();
    let collided = listed.iter().find(|e| e.trash_path == second).unwrap();
    assert!(
        collided.name.starts_with("docs%2Fa.md-"),
        "only the key carries the collision stamp: {}",
        collided.name
    );
    for entry in [plain, collided] {
        assert_eq!(entry.original_path, "docs/a.md", "the stamp is key-only");
        assert_eq!(entry.display_name, "a.md");
    }

    // The collided entry restores onto the ORIGINAL path, not `a.md-<ts>`.
    let restored = restore_from_trash(&root, &collided.trash_path).unwrap();
    assert!(rel(&restored).ends_with("docs/a.md"), "got {restored}");
    assert_eq!(read_file(&root, "docs/a.md").unwrap(), "two");

    // The occupied target gets a suffix that preserves the extension, so the
    // restored note is still openable Markdown.
    let restored2 = restore_from_trash(&root, &plain.trash_path).unwrap();
    assert!(restored2.contains("-restored-"), "got {restored2}");
    assert!(
        restored2.ends_with(".md"),
        "restored note stays markdown: {restored2}"
    );
    assert_eq!(read_file(&root, &restored2).unwrap(), "one");

    std::fs::remove_dir_all(&vault).unwrap();
}

/// Deleting via an ABSOLUTE path — the spelling `list_dir` entries carry, and
/// therefore what the frontend always sends — must produce a trash key that
/// decodes back to the vault-relative path: list_trash reports the original
/// location and restore puts the file back exactly there. (Regression for the
/// old behavior, which encoded the absolute path and could never decode it.)
#[test]
fn trash_roundtrip_with_absolute_path() {
    let vault = temp_vault("trash-abs");
    let root = vault.to_str().unwrap().to_string();
    std::fs::create_dir_all(vault.join("docs/nested")).unwrap();
    write_file(&root, "docs/nested/note.md", "payload", Some(10)).unwrap();

    let abs = vault
        .join("docs/nested/note.md")
        .to_str()
        .unwrap()
        .to_string();
    let trash_path = delete_file(&root, &abs).unwrap();
    assert!(!vault.join("docs/nested/note.md").exists());

    let trash = list_trash(&root).unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!(
        trash[0].original_path, "docs/nested/note.md",
        "original_path is vault-relative"
    );
    assert_eq!(trash[0].trash_path, trash_path);

    let restored = restore_from_trash(&root, &trash_path).unwrap();
    assert!(rel(&restored).ends_with("docs/nested/note.md"));
    assert_eq!(read_file(&root, "docs/nested/note.md").unwrap(), "payload");
    assert!(list_trash(&root).unwrap().is_empty());

    std::fs::remove_dir_all(&vault).unwrap();
}

/// decode(encode(p)) == p for every valid relative path, exercised through
/// the public trash API (the decode itself is private): a trash entry named
/// encode(p) must surface p as its original path.
#[test]
fn trash_keys_round_trip_through_list() {
    let vault = temp_vault("trash-keys");
    let root = vault.to_str().unwrap().to_string();
    let trash = vault.join(".nekowite-trash");
    std::fs::create_dir_all(&trash).unwrap();
    let paths = [
        "a.md",
        "docs/a.md",
        "docs__a.md", // literal `__` must not collapse onto docs/a.md
        ".hidden/x.md",
        "my_note.md",
        "100%.md",
    ];
    for p in paths {
        std::fs::write(trash.join(encode_rel_path(p)), "x").unwrap();
    }
    let originals: Vec<String> = list_trash(&root)
        .unwrap()
        .into_iter()
        .map(|e| e.original_path)
        .collect();
    let mut expected: Vec<String> = paths.iter().map(|p| p.to_string()).collect();
    expected.sort();
    assert_eq!(originals.len(), expected.len(), "got {originals:?}");
    for e in originals {
        assert!(expected.contains(&e), "unexpected original_path {e:?}");
    }

    std::fs::remove_dir_all(&vault).unwrap();
}

/// Entries written by the previous `__` encoder still decode to a sane
/// original path and restore to the right place.
#[test]
fn legacy_trash_entry_still_restores() {
    let vault = temp_vault("trash-legacy");
    let root = vault.to_str().unwrap().to_string();
    std::fs::create_dir_all(vault.join("docs")).unwrap();
    let trash = vault.join(".nekowite-trash");
    std::fs::create_dir_all(&trash).unwrap();
    // Old encoder: `docs/legacy.md` -> `docs__legacy.md`.
    std::fs::write(trash.join("docs__legacy.md"), "old trash").unwrap();

    let entries = list_trash(&root).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].original_path, "docs/legacy.md");

    let restored = restore_from_trash(&root, &entries[0].trash_path).unwrap();
    assert!(rel(&restored).ends_with("docs/legacy.md"));
    assert_eq!(read_file(&root, "docs/legacy.md").unwrap(), "old trash");

    std::fs::remove_dir_all(&vault).unwrap();
}
