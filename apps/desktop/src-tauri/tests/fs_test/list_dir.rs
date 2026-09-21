//! Listing a vault directory: which entries are filtered out — hidden files, `.git`, the build
//! trees — and the one spelling of a path the frontend is allowed to receive.

use super::support::temp_vault;
use nekowite_lib::storage::file_store::{list_dir, list_dir_entries, read_file, write_file};

#[test]
fn list_dir_entries_filters_hidden_and_build_dirs() {
    let dir = std::env::temp_dir().join(format!("nkw_sandbox_list_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("note.md"), "x").unwrap();
    std::fs::write(dir.join("refs.bib"), "@x{y, z}").unwrap();
    std::fs::write(dir.join(".hidden.md"), "x").unwrap();
    std::fs::create_dir_all(dir.join("node_modules")).unwrap();
    std::fs::create_dir_all(dir.join("dist")).unwrap();
    std::fs::create_dir_all(dir.join("dist.md")).unwrap();
    std::fs::create_dir_all(dir.join("hello")).unwrap();

    let entries = list_dir_entries(&dir).unwrap();
    let names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
    assert!(!names.contains(&".hidden.md".into()));
    assert!(!names.contains(&"node_modules".into()));
    assert!(!names.contains(&"dist".into()));
    assert!(names.contains(&"dist.md".into()), "dist.md 目录保留");
    assert!(names.contains(&"note.md".into()));
    assert!(names.contains(&"hello".into()));
    // non-markdown files (references library etc.) must be listed too — the
    // references loader discovers .bib/.ris from this listing.
    assert!(names.contains(&"refs.bib".into()));
    assert!(!entries.iter().any(|e| e.name == "refs.bib" && e.is_mdx));

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn list_dir_paths_are_not_verbatim_on_windows() {
    // `list_dir` used to hand the frontend a verbatim (`\\?\C:\...`) path while
    // the vault root came from the folder dialog WITHOUT that prefix. The two
    // never compared equal, which broke the file tree's root lookup (renaming a
    // top-level file did nothing) and the fs-change/tab comparison. Every path
    // the frontend receives must use one spelling.
    let vault = temp_vault("ipc-path");
    let root = vault.to_str().unwrap().to_string();
    write_file(&root, "note.md", "x", Some(10)).unwrap();
    std::fs::create_dir_all(vault.join("sub")).unwrap();

    let listing = list_dir(&root, Some(".")).unwrap();
    for entry in &listing {
        assert!(
            !entry.path.starts_with(r"\\?\"),
            "verbatim prefix leaked to the frontend: {}",
            entry.path
        );
    }
    let note = listing
        .iter()
        .find(|e| e.name == "note.md")
        .expect("note listed");
    assert!(note.path.ends_with("note.md"));
    // The path must still resolve when handed straight back to the backend.
    assert_eq!(read_file(&root, &note.path).unwrap(), "x");

    std::fs::remove_dir_all(&vault).unwrap();
}
