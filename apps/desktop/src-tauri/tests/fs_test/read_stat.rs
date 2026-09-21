//! Reading a note and asking for its size and mtime: the end-to-end round trip over an absolute
//! vault root (the spelling the folder dialog hands the backend), and what `stat_file` reports for
//! a file that exists and for one that does not.

use super::support::temp_vault;
use nekowite_lib::storage::file_store::{list_dir, read_file, stat_file, write_file};

/// End-to-end over a REAL temp dir, mirroring the dialog flow:
/// absolute vault root -> list_dir -> read_file -> write_file, including a
/// `.`-relative listing and rejection of escaping paths.
#[test]
fn vault_roundtrip_with_absolute_root() {
    let vault = temp_vault("roundtrip");
    std::fs::create_dir_all(vault.join("docs")).unwrap();
    let vault_root = vault.to_str().unwrap().to_string();

    // dialog-style absolute vault root works for write + list + read
    write_file(&vault_root, "docs/hello.mdx", "# Hello", None).expect("write under absolute root");
    let listing = list_dir(&vault_root, Some(".")).expect("list with .-relative root");
    assert!(
        listing.iter().any(|e| e.name == "docs"),
        "root listing contains docs"
    );
    let docs = listing
        .iter()
        .find(|e| e.name == "docs")
        .expect("docs entry");
    assert!(docs.is_dir);

    let abs_doc = vault.join("docs/hello.mdx").to_str().unwrap().to_string();
    assert_eq!(read_file(&vault_root, &abs_doc).unwrap(), "# Hello");
    assert_eq!(read_file(&vault_root, "docs/hello.mdx").unwrap(), "# Hello");

    // editing an existing file round-trips
    write_file(&vault_root, abs_doc.as_str(), "# Changed", None).unwrap();
    assert_eq!(
        read_file(&vault_root, "docs/hello.mdx").unwrap(),
        "# Changed"
    );

    // list_dir with no path (None) defaults to the vault root
    assert!(list_dir(&vault_root, None).is_ok());

    // escaping paths are rejected
    assert!(
        read_file(&vault_root, "/etc/passwd").is_err(),
        "absolute outside vault rejected"
    );
    assert!(
        read_file(&vault_root, "../outside.md").is_err(),
        ".. escape rejected"
    );
    assert!(write_file(&vault_root, "../outside.md", "x", None).is_err());

    std::fs::remove_dir_all(&vault).unwrap();
}

#[test]
fn stat_file_returns_size_and_mtime() {
    let vault = temp_vault("stat");
    let root = vault.to_str().unwrap().to_string();
    write_file(&root, "docs/note.md", "hello world", Some(10)).unwrap();
    let stat = stat_file(&root, "docs/note.md").expect("stat a created file");
    assert_eq!(stat.size, 11, "size matches the known byte count");
    assert!(
        stat.mtime > 0,
        "mtime is a positive unix-millisecond timestamp"
    );
    std::fs::remove_dir_all(&vault).unwrap();
}

#[test]
fn stat_file_missing_file_errors() {
    let vault = temp_vault("stat-missing");
    let root = vault.to_str().unwrap().to_string();
    assert!(stat_file(&root, "nope.md").is_err());
    std::fs::remove_dir_all(&vault).unwrap();
}
