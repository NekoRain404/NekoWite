//! The vault metadata tree (`.nekowite/…`, `.nekowite-trash/…`): creating a
//! missing level, refusing to create one when merely looking, and refusing a
//! level that has been replaced by a symlink.
//!
//! Moved here from `domain/path_policy.rs`'s `metadata_dir_tests` module. It is
//! the same behaviour and the same assertions; what changed is where they run.
//! The tests need a real directory tree on a real filesystem, which is the one
//! thing a unit test beside a pure-policy module cannot pretend to have, and the
//! split that took the codec out of that file took its test budget with it. Only
//! public API is touched — `resolve_vault_metadata_dir` and both of its wrappers
//! are `pub` — so nothing about the module's surface had to widen to let this
//! move.

use nekowite_lib::domain::path_policy::{
    create_vault_metadata_dir, find_vault_metadata_dir, resolve_vault_metadata_dir,
};
use std::path::{Path, PathBuf};

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "nekowite-policy-{}-{}-{tag}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn root(vault: &Path) -> String {
    vault.to_string_lossy().to_string()
}

#[test]
fn creates_each_missing_level_under_the_vault() {
    let vault = temp_dir("create");
    let dir = create_vault_metadata_dir(&root(&vault), &[".nekowite", "history", "a%2Fb.md"])
        .expect("creates the whole chain");
    assert!(dir.is_dir());
    assert!(dir.starts_with(vault.canonicalize().unwrap()));
    let _ = std::fs::remove_dir_all(&vault);
}

#[test]
fn a_missing_level_is_none_for_a_reader_and_creates_nothing() {
    let vault = temp_dir("find");
    let found = find_vault_metadata_dir(&root(&vault), &[".nekowite", "history"]).unwrap();
    assert!(found.is_none());
    assert!(
        !vault.join(".nekowite").exists(),
        "merely looking must not create the metadata tree"
    );
    let _ = std::fs::remove_dir_all(&vault);
}

#[test]
fn an_existing_directory_is_returned_to_a_reader() {
    let vault = temp_dir("found");
    create_vault_metadata_dir(&root(&vault), &[".nekowite", "history"]).unwrap();
    let found = find_vault_metadata_dir(&root(&vault), &[".nekowite", "history"])
        .unwrap()
        .expect("it exists");
    assert!(found.is_dir());
    let _ = std::fs::remove_dir_all(&vault);
}

#[test]
fn traversal_and_empty_components_are_refused() {
    let vault = temp_dir("traversal");
    for bad in [
        &["..", "escape"][..],
        &["", "x"][..],
        &["."][..],
        &["a/b"][..],
    ] {
        assert!(
            resolve_vault_metadata_dir(&root(&vault), bad, true).is_err(),
            "must refuse {bad:?}"
        );
    }
    let _ = std::fs::remove_dir_all(&vault);
}

/// The reason this function exists: a metadata tree that has been replaced
/// by a symlink must be refused, never followed. Unix-only, because
/// creating a symlink is not a portable operation (and Windows needs a
/// privilege for it).
#[cfg(unix)]
#[test]
fn a_symlinked_metadata_directory_is_refused_and_nothing_is_written_through_it() {
    let vault = temp_dir("symlink");
    let outside = temp_dir("symlink-outside");
    std::os::unix::fs::symlink(&outside, vault.join(".nekowite")).unwrap();

    assert!(
        create_vault_metadata_dir(&root(&vault), &[".nekowite", "history"]).is_err(),
        "a symlinked .nekowite must be refused, not followed"
    );
    assert!(
        !outside.join("history").exists(),
        "nothing may be created through the symlink"
    );
    // A reader refuses it too, rather than reporting an empty history.
    assert!(find_vault_metadata_dir(&root(&vault), &[".nekowite", "history"]).is_err());

    let _ = std::fs::remove_dir_all(&vault);
    let _ = std::fs::remove_dir_all(&outside);
}

#[cfg(unix)]
#[test]
fn a_symlink_deeper_in_the_metadata_tree_is_refused_too() {
    let vault = temp_dir("deep-symlink");
    let outside = temp_dir("deep-symlink-outside");
    std::fs::create_dir_all(vault.join(".nekowite")).unwrap();
    std::os::unix::fs::symlink(&outside, vault.join(".nekowite").join("history")).unwrap();

    assert!(create_vault_metadata_dir(&root(&vault), &[".nekowite", "history", "key"]).is_err());
    assert!(!outside.join("key").exists());
    let _ = std::fs::remove_dir_all(&vault);
    let _ = std::fs::remove_dir_all(&outside);
}
