//! The path policy the storage layer sits on: which names are refused, which extensions the vault
//! treats as notes, how a vault-relative path becomes one filesystem-safe key, and the two escape
//! shapes — a symlink out of the vault, and a dangling one that would only resolve later — that
//! have to be refused before a read or a write reaches the disk.

use nekowite_lib::domain::path_policy::{encode_rel_path, resolve_within, sanitize_path};
use nekowite_lib::domain::vault::{is_mdx_path, should_skip_entry};
use nekowite_lib::storage::file_store::{list_dir_entries, read_file, write_file};
#[cfg(unix)]
use std::os::unix::fs::symlink;

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

#[test]
fn skips_hidden_and_build_dirs() {
    assert!(should_skip_entry(".git", false));
    assert!(should_skip_entry(".nekowite", false));
    assert!(should_skip_entry(".nekowite-trash", false));
    assert!(should_skip_entry("node_modules", false));
    assert!(should_skip_entry("dist", false));
    assert!(should_skip_entry("target", false));
    assert!(should_skip_entry("build", false));
    assert!(should_skip_entry("out", false));
    assert!(should_skip_entry(".DS_Store", false));
    assert!(!should_skip_entry("dist.md", false)); // 文件保留
    assert!(!should_skip_entry("hello.md", false));
    assert!(!should_skip_entry("build.rs", false));
    assert!(should_skip_entry("link", true));
}

#[cfg(unix)]
#[test]
fn rejects_symlink_escape_in_read_path() {
    let dir = std::env::temp_dir().join(format!("nkw_sandbox_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("note.md"), "x").unwrap();
    symlink("/etc", dir.join("escape")).unwrap(); // symlink 指向 vault 外
    symlink(dir.join("note.md"), dir.join("alias.md")).unwrap(); // vault 内 symlink
                                                                 // 读取逃逸 symlink 下的文件 → 拒绝
    assert!(resolve_within(dir.to_str().unwrap(), "escape/passwd").is_err());
    // 读取 vault 内 symlink 指向的文件 → 允许
    assert!(resolve_within(dir.to_str().unwrap(), "alias.md").is_ok());
    // 列出目录时不出现 escape（symlink）与隐藏/构建
    let entries = list_dir_entries(&dir).unwrap();
    let names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
    assert!(!names.contains(&"escape".into()));
    assert!(!names.contains(&"alias.md".into()));
    assert!(!names.contains(&".git".into()));
    assert!(names.contains(&"note.md".into()));
    std::fs::remove_dir_all(&dir).unwrap();
}

/// C1 regression: a *dangling* symlink (target currently absent) is not
/// resolved by `canonicalize_loose`, so it gets re-appended literally to the
/// canonicalized ancestor and passes the lexical `starts_with` check. If the
/// attacker materializes the target later, the OS resolves the symlink at use
/// time and the write/read lands outside the vault. Must be rejected.
#[cfg(unix)]
#[test]
fn rejects_dangling_symlink_escape_in_write_path() {
    let dir = std::env::temp_dir().join(format!("nkw_dangle_{}", std::process::id()));
    let outside = std::env::temp_dir().join(format!("nkw_outside_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&outside);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("note.md"), "x").unwrap();
    // 目标此刻不存在 → dangling symlink
    symlink(&outside, dir.join("dangle")).unwrap();
    let root = dir.to_str().unwrap();

    // 目标尚未 materialize 时就必须拒绝（此即漏洞触发点）
    assert!(resolve_within(root, "dangle/new.md").is_err());
    assert!(read_file(root, "dangle/new.md").is_err());

    // attacker 事后 materialize 目标目录 → 仍必须拒绝
    std::fs::create_dir_all(&outside).unwrap();
    assert!(resolve_within(root, "dangle/new.md").is_err());
    assert!(write_file(root, "dangle/new.md", "x", None).is_err());
    assert!(read_file(root, "dangle/new.md").is_err());
    // 未逃逸到 vault 外
    assert!(!outside.join("new.md").exists());

    std::fs::remove_dir_all(&dir).unwrap();
    std::fs::remove_dir_all(&outside).unwrap();
}

// Updated for the percent-style encoding: the old `__` scheme collapsed
// `docs/a.md` and a literal `docs__a.md` (and `.a/b` with `a/b`) onto the
// same key, so those expectations encoded the buggy behavior.
#[test]
fn encode_rel_path_is_safe() {
    assert_eq!(encode_rel_path("docs/a.md"), "docs%2Fa.md");
    assert_eq!(encode_rel_path("a.md"), "a.md");
    assert_eq!(encode_rel_path(".hidden.md"), "%2Ehidden.md");
    assert_eq!(encode_rel_path("my_note.md"), "my%5Fnote.md");
    assert_eq!(encode_rel_path("100%.md"), "100%25.md");
    // Distinct paths never share a key.
    assert_ne!(encode_rel_path("docs/a.md"), encode_rel_path("docs__a.md"));
    assert_ne!(encode_rel_path(".a/b"), encode_rel_path("a/b"));
    // Every encoded name is exactly one safe filesystem component: no
    // separator, never hidden, never a special `.`/`..` name. (A `..` run
    // inside the name is fine — it is part of one component, not traversal.)
    for p in ["../etc", "..", ".", "a/../b", "", "docs__a.md", "100%.md"] {
        let e = encode_rel_path(p);
        assert!(!e.contains('/'), "{p:?} -> {e:?}");
        assert!(!e.starts_with('.'), "{p:?} -> {e:?}");
        assert!(e != "." && e != "..", "{p:?} -> {e:?}");
    }
}
