use nekowite_lib::fs::{is_mdx_path, list_dir, read_file, sanitize_path, write_file};
use std::path::PathBuf;

fn temp_vault(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nekowite-test-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn detects_mdx_extensions() {
    assert!(is_mdx_path("a/b/c.mdx"));
    assert!(is_mdx_path("x.md"));
    assert!(!is_mdx_path("notes.txt"));
    assert!(!is_mdx_path("node_modules/index.mdx"));
}

#[test]
fn sanitize_rejects_relative_escape() {
    assert!(sanitize_path("../etc/passwd").is_err());
    assert!(sanitize_path("vault/a.md").is_ok());
}

/// End-to-end over a REAL temp dir, mirroring the dialog flow:
/// absolute vault root -> list_dir -> read_file -> write_file, including a
/// `.`-relative listing and rejection of escaping paths.
#[test]
fn vault_roundtrip_with_absolute_root() {
    let vault = temp_vault("roundtrip");
    std::fs::create_dir_all(vault.join("docs")).unwrap();
    let vault_root = vault.to_str().unwrap().to_string();

    // dialog-style absolute vault root works for write + list + read
    write_file(&vault_root, "docs/hello.mdx", "# Hello").expect("write under absolute root");
    let listing = list_dir(&vault_root, Some(".")).expect("list with .-relative root");
    assert!(listing.iter().any(|e| e.name == "docs"), "root listing contains docs");
    let docs = listing
        .iter()
        .find(|e| e.name == "docs")
        .expect("docs entry");
    assert!(docs.is_dir);

    let abs_doc = vault.join("docs/hello.mdx").to_str().unwrap().to_string();
    assert_eq!(read_file(&vault_root, &abs_doc).unwrap(), "# Hello");
    assert_eq!(read_file(&vault_root, "docs/hello.mdx").unwrap(), "# Hello");

    // editing an existing file round-trips
    write_file(&vault_root, abs_doc.as_str(), "# Changed").unwrap();
    assert_eq!(read_file(&vault_root, "docs/hello.mdx").unwrap(), "# Changed");

    // list_dir with no path (None) defaults to the vault root
    assert!(list_dir(&vault_root, None).is_ok());

    // escaping paths are rejected
    assert!(read_file(&vault_root, "/etc/passwd").is_err(), "absolute outside vault rejected");
    assert!(read_file(&vault_root, "../outside.md").is_err(), ".. escape rejected");
    assert!(write_file(&vault_root, "../outside.md", "x").is_err());

    std::fs::remove_dir_all(&vault).unwrap();
}
