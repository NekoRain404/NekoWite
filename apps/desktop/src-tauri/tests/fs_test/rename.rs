//! Rename inside the vault: the move and its guards (missing source, taken target, traversal, a
//! case-only rename), and the history and trash keys that have to follow the file so neither
//! becomes unreachable — without touching the entries of any other file.

use super::support::{temp_vault, tick};
use nekowite_lib::domain::path_policy::encode_rel_path;
use nekowite_lib::storage::file_store::{list_history, rename_entry, write_file};
use nekowite_lib::storage::trash_store::{delete_file, list_trash};
use std::path::Path;

/// `rename_entry` moves files and directories within the vault, refuses
/// missing sources, existing targets, and traversal.
#[test]
fn rename_entry_moves_and_guards() {
    let vault = temp_vault("rename-entry");
    let root = vault.to_str().unwrap().to_string();
    std::fs::create_dir_all(vault.join("docs")).unwrap();
    std::fs::write(vault.join("docs/a.md"), "# hi").unwrap();

    let rel = rename_entry(&root, "docs/a.md", "docs/b.md").unwrap();
    assert_eq!(rel, "docs/b.md");
    assert!(!vault.join("docs/a.md").exists());
    assert_eq!(
        std::fs::read_to_string(vault.join("docs/b.md")).unwrap(),
        "# hi"
    );

    // Directory rename with contents.
    let rel_dir = rename_entry(&root, "docs", "archive").unwrap();
    assert_eq!(rel_dir, "archive");
    assert_eq!(
        std::fs::read_to_string(vault.join("archive/b.md")).unwrap(),
        "# hi"
    );

    // Missing source / existing target / traversal are all errors.
    assert!(rename_entry(&root, "docs/a.md", "docs/c.md").is_err());
    assert!(rename_entry(&root, "archive/b.md", "archive/b.md").is_err());
    assert!(rename_entry(&root, "../outside", "inside.md").is_err());
    assert!(rename_entry(&root, "archive/b.md", "../outside.md").is_err());

    // A case-only rename must go through. `exists()` is case-insensitive on
    // Windows, so `archive/b.md` -> `archive/B.md` hit the file itself and was
    // rejected with "target already exists: archive/B.md" — a message naming the
    // name the user just asked for, which reads as nonsense.
    let cased = rename_entry(&root, "archive/b.md", "archive/B.md").unwrap();
    assert_eq!(cased, "archive/B.md", "the caller is told the new spelling");
    assert_eq!(
        std::fs::read_to_string(vault.join("archive/B.md")).unwrap(),
        "# hi"
    );
    // The on-disk NAME must carry the new casing, not just resolve to the file:
    // a case-insensitive `exists()`/read passes either way, so this is the only
    // assertion that catches a rename Windows silently ignored.
    let on_disk: Vec<String> = std::fs::read_dir(vault.join("archive"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert!(
        on_disk.iter().any(|n| n == "B.md"),
        "the directory entry is B.md, got {on_disk:?}"
    );

    std::fs::remove_dir_all(&vault).unwrap();
}

/// A renamed single file carries its history snapshots and its trash entry to
/// the new vault-relative key, so neither becomes unreachable / lost.
#[test]
fn rename_entry_moves_history_and_trash() {
    let vault = temp_vault("rename-history-trash");
    let root = vault.to_str().unwrap().to_string();
    let path = "docs/a.md";

    // Give it history: save twice so the first write is snapshotted.
    write_file(&root, path, "v1", Some(10)).unwrap();
    tick();
    write_file(&root, path, "v2", Some(10)).unwrap();
    assert!(
        !list_history(&root, path).unwrap().is_empty(),
        "history exists"
    );

    // Move the current file into the trash, then recreate a file at the same
    // path so a trash entry AND a live file coexist under the same encoded key.
    let trash_path = delete_file(&root, path).unwrap();
    assert!(Path::new(&trash_path)
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .contains("a.md"));
    write_file(&root, path, "v3", Some(10)).unwrap();
    assert_eq!(list_trash(&root).unwrap().len(), 1);

    // Rename the live file; history + trash must follow to the new key.
    let rel = rename_entry(&root, path, "docs/b.md").unwrap();
    assert_eq!(rel, "docs/b.md");

    let hist_new = list_history(&root, "docs/b.md").unwrap();
    let hist_old = list_history(&root, "docs/a.md").unwrap();
    assert!(!hist_new.is_empty(), "history migrated to the new path");
    assert!(hist_old.is_empty(), "history no longer under the old path");

    let trash = list_trash(&root).unwrap();
    assert_eq!(trash.len(), 1, "single trash entry follows the rename");
    assert_eq!(trash[0].original_path, "docs/b.md");

    std::fs::remove_dir_all(&vault).unwrap();
}

/// Renaming one file must leave the trash entries of OTHER files alone.
///
/// The key migration used to ask `name.strip_prefix(&from_key).unwrap_or("")`
/// and then accept an empty suffix as "exact match". `strip_prefix` returns
/// `None` for a key that does not start with `from_key`, so unrelated entries
/// were treated as matches, renamed to the new key, and — when several landed in
/// the same millisecond — overwritten by each other through `fs::rename`
/// (which replaces an existing target on Windows). Renaming any file could
/// therefore destroy the contents of an unrelated deleted note.
#[test]
fn rename_entry_leaves_unrelated_trash_entries_untouched() {
    let vault = temp_vault("rename-trash-unrelated");
    let root = vault.to_str().unwrap().to_string();

    for name in ["a.md", "b.md", "c.md"] {
        write_file(&root, name, &format!("CONTENT-{name}"), Some(10)).unwrap();
        delete_file(&root, name).unwrap();
    }
    std::fs::write(vault.join("keep.md"), "keep").unwrap();
    assert_eq!(list_trash(&root).unwrap().len(), 3, "three entries trashed");

    rename_entry(&root, "keep.md", "keep2.md").unwrap();

    let trash = list_trash(&root).unwrap();
    let mut originals: Vec<String> = trash.iter().map(|t| t.original_path.clone()).collect();
    originals.sort();
    assert_eq!(
        originals,
        vec!["a.md", "b.md", "c.md"],
        "unrelated trash entries keep their own paths"
    );

    // And the contents are all still there — an overwrite would have lost one.
    let mut bodies: Vec<String> = trash
        .iter()
        .map(|t| std::fs::read_to_string(&t.trash_path).unwrap())
        .collect();
    bodies.sort();
    assert_eq!(bodies, vec!["CONTENT-a.md", "CONTENT-b.md", "CONTENT-c.md"]);

    std::fs::remove_dir_all(&vault).unwrap();
}

/// A trash entry that DOES belong to the renamed path follows it, including the
/// legacy `__`-encoded spelling the old encoder wrote, which the encoded-prefix
/// comparison could never match.
#[test]
fn rename_entry_migrates_its_own_trash_entry_including_legacy_keys() {
    let vault = temp_vault("rename-trash-legacy");
    let root = vault.to_str().unwrap().to_string();
    let trash_dir = vault.join(".nekowite-trash");
    std::fs::create_dir_all(&trash_dir).unwrap();

    // Hand-write a legacy (`__`-encoded) entry for docs/sub.md, plus the live
    // file that is about to be renamed.
    std::fs::create_dir_all(vault.join("docs")).unwrap();
    std::fs::write(trash_dir.join("docs__sub.md"), "legacy body").unwrap();
    std::fs::write(vault.join("docs").join("sub.md"), "live").unwrap();

    rename_entry(&root, "docs/sub.md", "docs/renamed.md").unwrap();

    let entries = list_trash(&root).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].original_path, "docs/renamed.md");
    assert_eq!(
        std::fs::read_to_string(&entries[0].trash_path).unwrap(),
        "legacy body"
    );

    std::fs::remove_dir_all(&vault).unwrap();
}

/// A renamed trash entry that already carried a collision stamp must get that
/// stamp REPLACED, never a second one appended.
///
/// `strip_collision_suffix` removes exactly one 13-digit stamp, so a name like
/// `key-<old>-<new>` decodes to a path ending in `-<old>` — a path that never
/// existed. The entry could then never be restored to the right place, and it
/// would stop matching its own file on any later rename.
#[test]
fn rename_replaces_a_collision_stamp_instead_of_stacking_a_second_one() {
    let vault = temp_vault("rename-trash-stamp");
    let root = vault.to_str().unwrap().to_string();
    let trash_dir = vault.join(".nekowite-trash");
    std::fs::create_dir_all(&trash_dir).unwrap();
    std::fs::create_dir_all(vault.join("docs")).unwrap();

    const STAMP: &str = "-1700000000000";
    let from_key = encode_rel_path("docs/a.md");
    let to_key = encode_rel_path("docs/b.md");
    // The trashed copy of the file about to be renamed, already disambiguated
    // once, plus a name occupying the first candidate for the new key so the
    // bump path actually runs.
    std::fs::write(trash_dir.join(format!("{from_key}{STAMP}")), "trashed body").unwrap();
    std::fs::write(trash_dir.join(format!("{to_key}{STAMP}")), "unrelated").unwrap();

    std::fs::write(vault.join("docs").join("a.md"), "live").unwrap();
    rename_entry(&root, "docs/a.md", "docs/b.md").unwrap();

    let names: Vec<String> = std::fs::read_dir(&trash_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(names.len(), 2, "the from-key entry moved, not duplicated");
    for name in &names {
        let suffix = name
            .strip_prefix(&format!("{to_key}-"))
            .unwrap_or_else(|| panic!("every entry should sit under the new key: {name}"));
        assert!(
            suffix.len() == 13 && suffix.bytes().all(|b| b.is_ascii_digit()),
            "exactly one 13-digit stamp, never a stacked pair: {name}"
        );
    }
    // The renamed entry kept its contents.
    let moved = names
        .iter()
        .find(|n| std::fs::read_to_string(trash_dir.join(n)).unwrap() == "trashed body")
        .expect("the trashed body survived the rename");
    assert!(moved.starts_with(&format!("{to_key}-")));

    std::fs::remove_dir_all(&vault).unwrap();
}
