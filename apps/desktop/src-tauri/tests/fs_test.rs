use nekowite_lib::fs::{
    atomic_write, delete_file, encode_rel_path, is_mdx_path, list_dir, list_dir_entries,
    list_history, list_trash, read_file, read_history, resolve_within, restore_from_trash,
    restore_history, sanitize_path, should_skip_entry, stat_file, write_file,
};
use std::path::PathBuf;

#[cfg(unix)]
use std::os::unix::fs::symlink;

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

#[test]
fn list_dir_entries_filters_hidden_and_build_dirs() {
    let dir = std::env::temp_dir().join(format!("nkw_sandbox_list_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("note.md"), "x").unwrap();
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

    std::fs::remove_dir_all(&dir).unwrap();
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
    write_file(&vault_root, "docs/hello.mdx", "# Hello", None)
        .expect("write under absolute root");
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
    write_file(&vault_root, abs_doc.as_str(), "# Changed", None).unwrap();
    assert_eq!(read_file(&vault_root, "docs/hello.mdx").unwrap(), "# Changed");

    // list_dir with no path (None) defaults to the vault root
    assert!(list_dir(&vault_root, None).is_ok());

    // escaping paths are rejected
    assert!(read_file(&vault_root, "/etc/passwd").is_err(), "absolute outside vault rejected");
    assert!(read_file(&vault_root, "../outside.md").is_err(), ".. escape rejected");
    assert!(write_file(&vault_root, "../outside.md", "x", None).is_err());

    std::fs::remove_dir_all(&vault).unwrap();
}

#[test]
fn atomic_write_replaces_and_fails_safely() {
    let dir = std::env::temp_dir().join(format!("nkw_atomic_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let target = dir.join("note.md");

    atomic_write(&target, "v1").unwrap();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "v1");
    atomic_write(&target, "v2").unwrap();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "v2");

    // Failure path: renaming a file onto an existing directory fails, and the
    // temp sibling must be cleaned up so no `.tmp` litter is left behind.
    let dir_target = dir.join("adir");
    std::fs::create_dir_all(&dir_target).unwrap();
    assert!(atomic_write(&dir_target, "boom").is_err());
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "no .tmp files left behind");

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn encode_rel_path_is_safe() {
    assert_eq!(encode_rel_path("docs/a.md"), "docs__a.md");
    assert_eq!(encode_rel_path("a.md"), "a.md");
    assert!(!encode_rel_path("../etc").contains('/'));
    assert!(!encode_rel_path("../etc").contains(".."));
    assert!(!encode_rel_path("..").contains(".."));
    assert!(!encode_rel_path(".hidden.md").starts_with('.'));
    assert!(!encode_rel_path(".").is_empty());
    assert!(!encode_rel_path("a/../b").contains(".."));
}

#[test]
fn stat_file_returns_size_and_mtime() {
    let vault = temp_vault("stat");
    let root = vault.to_str().unwrap().to_string();
    write_file(&root, "docs/note.md", "hello world", Some(10)).unwrap();
    let stat = stat_file(&root, "docs/note.md").expect("stat a created file");
    assert_eq!(stat.size, 11, "size matches the known byte count");
    assert!(stat.mtime > 0, "mtime is a positive unix-millisecond timestamp");
    std::fs::remove_dir_all(&vault).unwrap();
}

#[test]
fn stat_file_missing_file_errors() {
    let vault = temp_vault("stat-missing");
    let root = vault.to_str().unwrap().to_string();
    assert!(stat_file(&root, "nope.md").is_err());
    std::fs::remove_dir_all(&vault).unwrap();
}

#[test]
fn history_snapshot_and_max_prune() {
    let vault = temp_vault("history");
    let root = vault.to_str().unwrap().to_string();
    let path = "docs/note.md".to_string();

    write_file(&root, &path, "v1", Some(2)).unwrap();
    write_file(&root, &path, "v2", Some(2)).unwrap();
    write_file(&root, &path, "v3", Some(2)).unwrap();
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

#[test]
fn trash_delete_and_restore_roundtrip() {
    let vault = temp_vault("trash");
    let root = vault.to_str().unwrap().to_string();

    write_file(&root, "docs/a.md", "hello", Some(10)).unwrap();
    let trash_path = delete_file(&root, "docs/a.md").unwrap();
    assert!(trash_path.contains(".nekowite-trash"));
    assert!(!vault.join("docs/a.md").exists());

    let trash = list_trash(&root).unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].original_path, "docs/a.md");
    assert_eq!(trash[0].trash_path, trash_path);

    // The trash dir itself is hidden from listings.
    let listing = list_dir(&root, Some(".")).unwrap();
    let names: Vec<String> = listing.iter().map(|e| e.name.clone()).collect();
    assert!(!names.contains(&".nekowite-trash".into()));
    assert!(!names.contains(&".nekowite".into()));

    let restored = restore_from_trash(&root, &trash_path).unwrap();
    assert!(restored.ends_with("docs/a.md"));
    assert_eq!(read_file(&root, "docs/a.md").unwrap(), "hello");
    assert!(list_trash(&root).unwrap().is_empty());

    // Original occupied → restore lands on a `-restored-<ts>` suffix.
    write_file(&root, "docs/a.md", "new content", Some(10)).unwrap();
    write_file(&root, "docs/a.md", "second", Some(10)).unwrap();
    let trash2 = delete_file(&root, "docs/a.md").unwrap();
    write_file(&root, "docs/a.md", "occupied", Some(10)).unwrap();
    let restored2 = restore_from_trash(&root, &trash2).unwrap();
    assert!(restored2.contains("-restored-"));
    assert_eq!(read_file(&root, &restored2).unwrap(), "second");

    std::fs::remove_dir_all(&vault).unwrap();
}
