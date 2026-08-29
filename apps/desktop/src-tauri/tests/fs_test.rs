use nekowite_lib::fs::{sanitize_path, is_mdx_path};

#[test]
fn detects_mdx_extensions() {
    assert!(is_mdx_path("a/b/c.mdx"));
    assert!(is_mdx_path("x.md"));
    assert!(!is_mdx_path("notes.txt"));
    assert!(!is_mdx_path("node_modules/index.mdx"));
}

#[test]
fn sanitize_rejects_absolute_escape() {
    assert_eq!(sanitize_path("../etc/passwd").is_err(), true);
    assert_eq!(sanitize_path("vault/a.md").is_ok(), true);
}
