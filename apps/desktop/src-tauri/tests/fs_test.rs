use nekowite_lib::domain::path_policy::{
    encode_rel_path, has_hidden_component, resolve_within, sanitize_path,
};
use nekowite_lib::domain::vault::{is_mdx_path, should_skip_entry};
use nekowite_lib::storage::file_store::{
    atomic_write, cleanup_stale_tmp, create_dir, import_attachment, is_importable_image, list_dir,
    list_dir_entries, list_history, read_file, read_history, rename_entry, resolve_media_path,
    restore_history, sanitize_attachment_name, save_attachment, search_notes,
    search_notes_with_max, snapshot_history, stat_file, write_file, MAX_IMPORT_BYTES,
};
use nekowite_lib::storage::trash_store::{
    clear_trash, delete_file, list_trash, restore_from_trash,
};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::symlink;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

fn temp_vault(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nekowite-test-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Normalise a path's separators so a test can assert on its trailing
/// components regardless of platform: `restore_from_trash` returns an absolute
/// path, which uses `\` on Windows.
fn rel(path: &str) -> String {
    path.replace('\\', "/")
}

/// A directory that is absolute on the platform under test and outside any
/// vault.
///
/// `/etc/passwd` is *not* absolute on Windows (it has no drive prefix), so the
/// guard — which rejects absolute dirs — would treat it as a vault-relative
/// name and the assertion would fail for the wrong reason.
fn outside_absolute_dir() -> &'static str {
    if cfg!(windows) {
        "C:\\Windows\\System32"
    } else {
        "/etc/passwd"
    }
}

/// File mtime granularity is kernel-jiffy coarse, so rapid successive writes
/// can share one timestamp. Pacing the writes that ordering assertions depend
/// on keeps those tests deterministic (no expectation changes).
fn tick() {
    std::thread::sleep(std::time::Duration::from_millis(15));
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
    assert!(rel(&restored).ends_with("docs/a.md"));
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

/// `clear_trash` removes every trash entry, reports how many it removed, and
/// is a no-op (returning 0) when the trash directory does not exist.
#[test]
fn clear_trash_empties_the_trash() {
    let vault = temp_vault("clear-trash");
    let root = vault.to_str().unwrap().to_string();

    // A missing trash dir is not an error.
    assert_eq!(clear_trash(&root).unwrap(), 0);

    write_file(&root, "docs/a.md", "hello", Some(10)).unwrap();
    write_file(&root, "notes/b.md", "world", Some(10)).unwrap();
    delete_file(&root, "docs/a.md").unwrap();
    delete_file(&root, "notes/b.md").unwrap();
    assert_eq!(list_trash(&root).unwrap().len(), 2);

    assert_eq!(clear_trash(&root).unwrap(), 2);
    assert!(list_trash(&root).unwrap().is_empty());
    assert!(!vault.join(".nekowite-trash/docs%2Fa.md").exists());
    assert!(!vault.join(".nekowite-trash/notes%2Fb.md").exists());
    // Clearing again is a no-op (the directory persists but is empty).
    assert_eq!(clear_trash(&root).unwrap(), 0);

    std::fs::remove_dir_all(&vault).unwrap();
}

/// Trash may hold a *directory* (when a whole folder is deleted): `clear_trash`
/// must remove it recursively and count it as a single entry.
#[test]
fn clear_trash_removes_directory_entries() {
    let vault = temp_vault("clear-trash-dir");
    let root = vault.to_str().unwrap().to_string();
    std::fs::create_dir_all(vault.join("fld/sub")).unwrap();
    std::fs::write(vault.join("fld/sub/n.md"), "x").unwrap();
    delete_file(&root, "fld").unwrap();

    assert!(list_trash(&root).unwrap().is_empty(), "dirs are not listed");
    assert_eq!(clear_trash(&root).unwrap(), 1);
    let rd = std::fs::read_dir(vault.join(".nekowite-trash")).unwrap();
    assert_eq!(rd.flatten().count(), 0, "no leftover trash entries");

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
    assert_eq!(hist_abs.len(), 1, "snapshot taken for the absolute spelling");
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

/// Writing over a non-UTF-8 file is refused instead of destroying it without
/// a snapshot.
#[test]
fn write_file_refuses_non_utf8_overwrite() {
    let vault = temp_vault("binary");
    let root = vault.to_str().unwrap().to_string();
    let target = vault.join("blob.md");
    let original = vec![0xffu8, 0xfe, 0x00, 0x01];
    std::fs::write(&target, &original).unwrap();

    let err = write_file(&root, "blob.md", "text", None).unwrap_err();
    assert!(err.contains("not valid UTF-8"), "got: {err}");
    assert_eq!(std::fs::read(&target).unwrap(), original, "bytes untouched");

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

/// The watcher's fs-change filter drops paths under hidden components
/// (history, trash, .git) and hidden files.
#[test]
fn watcher_filter_skips_hidden_components() {
    use nekowite_lib::domain::path_policy::has_hidden_component;

    assert!(has_hidden_component(Path::new(
        "/vault/.nekowite/history/docs%2Fa.md/1.md"
    )));
    assert!(has_hidden_component(Path::new("/vault/.nekowite-trash/x.md")));
    assert!(has_hidden_component(Path::new("/vault/.git/index")));
    assert!(has_hidden_component(Path::new("/vault/.tmp.md")));
    assert!(!has_hidden_component(Path::new("/vault/docs/note.md")));
    assert!(!has_hidden_component(Path::new("/vault/a..b/note.md")));
}

/// Saving an attachment creates `attachments/{YYYY-MM}/`, writes the decoded
/// bytes, and returns a forward-slash vault-relative path that resolves back
/// to the file.
#[test]
fn save_attachment_writes_decoded_bytes() {
    let vault = temp_vault("attach-save");
    let root = vault.to_str().unwrap().to_string();
    let payload = [0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

    let rel = save_attachment(&root, "paste.png", &b64(&payload), "").unwrap();
    assert!(rel.starts_with("attachments/"), "got {rel:?}");
    assert!(!rel.contains('\\'), "forward slashes only: {rel:?}");
    let month = rel
        .split('/')
        .nth(1)
        .expect("month segment")
        .to_string();
    assert_eq!(month.len(), 7, "YYYY-MM month dir: {month:?}");
    assert!(month.starts_with("20"), "month looks like a year: {month:?}");
    assert!(rel.ends_with(".png"));

    let saved = std::fs::read(vault.join(&rel)).unwrap();
    assert_eq!(saved, payload, "bytes round-trip through base64");
    // The returned relative path resolves inside the vault.
    assert!(resolve_within(&root, &rel).is_ok());

    std::fs::remove_dir_all(&vault).unwrap();
}

/// A name collision inside the same month directory gets `-1`, `-2`
/// suffixes; the original file is never overwritten.
#[test]
fn save_attachment_dedupes_collisions() {
    let vault = temp_vault("attach-dedupe");
    let root = vault.to_str().unwrap().to_string();

    let first = save_attachment(&root, "shot.png", &b64(b"v1"), "").unwrap();
    let second = save_attachment(&root, "shot.png", &b64(b"v2"), "").unwrap();
    let third = save_attachment(&root, "shot.png", &b64(b"v3"), "").unwrap();
    assert_ne!(first, second);
    assert_ne!(second, third);
    assert!(second.starts_with("attachments/"), "still vault-relative");
    let stem = second.trim_end_matches(".png");
    assert!(
        stem.ends_with("-1") || stem.ends_with("-2"),
        "numeric suffix expected, got {second:?}"
    );
    assert!(std::fs::read(vault.join(&first)).unwrap() == b"v1", "original untouched");
    assert!(std::fs::read(vault.join(&second)).unwrap() == b"v2");

    std::fs::remove_dir_all(&vault).unwrap();
}

/// A name carrying path separators or `..` must be rejected outright — the
/// write must never land outside the attachments directory.
#[test]
fn save_attachment_rejects_unsafe_names() {
    let vault = temp_vault("attach-names");
    let root = vault.to_str().unwrap().to_string();

    for bad in [
        "../evil.png",
        "sub/dir.png",
        "back\\slash.png",
        "..",
        ".hidden",
        "noext",
        "",
    ] {
        assert!(
            save_attachment(&root, bad, &b64(b"x"), "").is_err(),
            "name {bad:?} must be rejected"
        );
    }
    assert!(!vault.join("evil.png").exists(), "no file escaped the vault");
    assert!(list_dir(&root, Some(".")).unwrap().iter().all(|e| e.name != "attachments"), "nothing written");

    std::fs::remove_dir_all(&vault).unwrap();
}

/// Invalid base64 payloads are refused before anything is written.
#[test]
fn save_attachment_rejects_bad_base64() {
    let vault = temp_vault("attach-b64");
    let root = vault.to_str().unwrap().to_string();
    assert!(save_attachment(&root, "ok.png", "not!base64!!", "").is_err());
    assert!(list_dir(&root, Some(".")).unwrap().iter().all(|e| e.name != "attachments"));
    std::fs::remove_dir_all(&vault).unwrap();
}

/// The asset-protocol grant in `commands::fs::allow_vault_media` allows the
/// WHOLE vault so pasted/unstaged images are servable via `asset://` no matter
/// where they live: the unsaved-tab `.tmp` staging dir and per-note
/// `<name>_assets/` directories included. This asserts the "allow" half of the
/// scope grant against the media resolver the frontend feeds those paths to.
#[test]
fn resolve_media_path_reaches_tmp_staging_and_note_assets() {
    let vault = temp_vault("media-scope-allow");
    let root = vault.to_str().unwrap().to_string();
    std::fs::create_dir_all(vault.join(".tmp")).unwrap();
    std::fs::write(vault.join(".tmp/paste.png"), "tmp-img").unwrap();
    std::fs::create_dir_all(vault.join("notes/note_assets")).unwrap();
    std::fs::write(vault.join("notes/note_assets/pic.png"), "pic-img").unwrap();

    let abs_tmp = resolve_media_path(&root, ".tmp/paste.png").expect("staged tmp image resolves");
    assert!(
        Path::new(&abs_tmp).is_absolute(),
        "absolute path expected, got {abs_tmp:?}"
    );
    assert_eq!(std::fs::read(&abs_tmp).unwrap(), b"tmp-img");

    let abs_assets =
        resolve_media_path(&root, "notes/note_assets/pic.png").expect("per-note asset resolves");
    assert_eq!(std::fs::read(&abs_assets).unwrap(), b"pic-img");

    std::fs::remove_dir_all(&vault).unwrap();
}

/// The command layer's media resolver is vault-confinement only: it serves ANY
/// file inside the vault root, the `.nekowite` metadata trees included. That is
/// why the actual deny for `.nekowite`, `.nekowite-trash` and `.git` lives at
/// the ASSET-PROTOCOL scope (`allow_vault_media`'s `forbid_directory`, which
/// takes precedence over `allow_directory`) rather than here: a content-
/// injection attack must not reach history snapshots/trash through `asset://`,
/// while the login-side commands stay a trusted boundary.
///
/// The forbid decision needs a live `tauri::AppHandle` (and the tauri `test`
/// feature, which the crate does not enable — Cargo.* is out of scope for this
/// suite), so this test asserts what IS assertable: the resolver serves the
/// vault-internal path (the allow half), and the domain predicate that flags
/// the hidden metadata trees (`has_hidden_component` — the same predicate the
/// fs-change watcher uses to drop history/trash churn) marks them.
#[test]
fn media_resolver_is_confinement_only_while_domain_policy_flags_metadata_trees() {
    let vault = temp_vault("media-scope-forbid");
    let root = vault.to_str().unwrap().to_string();
    std::fs::create_dir_all(vault.join(".nekowite/history")).unwrap();
    std::fs::write(vault.join(".nekowite/history/snap.md"), "snapshot").unwrap();

    // Command layer: a `.nekowite` path is vault-internal -> resolved.
    let snap = resolve_media_path(&root, ".nekowite/history/snap.md").expect("vault-internal");
    assert_eq!(std::fs::read(&snap).unwrap(), b"snapshot");

    // Domain policy flags the metadata trees the asset scope must forbid.
    assert!(has_hidden_component(Path::new(&vault.join(".nekowite/history/snap.md"))));
    assert!(has_hidden_component(Path::new(&vault.join(".nekowite-trash/key.md"))));
    assert!(has_hidden_component(Path::new(&vault.join(".git/index"))));
    assert!(!has_hidden_component(Path::new(&vault.join("notes/note_assets/pic.png"))));

    std::fs::remove_dir_all(&vault).unwrap();
}

/// `resolve_media_path` returns the absolute path for an existing file and
/// errors for missing files or traversal attempts.
#[test]
fn resolve_media_path_resolves_and_guards() {
    let vault = temp_vault("media-resolve");
    let root = vault.to_str().unwrap().to_string();
    std::fs::create_dir_all(vault.join("attachments/2026-09")).unwrap();
    std::fs::write(vault.join("attachments/2026-09/pic.png"), "img").unwrap();

    let abs = resolve_media_path(&root, "attachments/2026-09/pic.png").unwrap();
    assert!(
        Path::new(&abs).is_absolute(),
        "absolute path expected, got {abs:?}"
    );
    assert_eq!(std::fs::read(&abs).unwrap(), b"img");

    // Missing file -> Err, even though the path is vault-internal.
    assert!(resolve_media_path(&root, "attachments/2026-09/missing.png").is_err());
    // Traversal attempts are rejected, not resolved.
    assert!(resolve_media_path(&root, "../../etc/passwd").is_err());
    assert!(resolve_media_path(&root, "/etc/passwd").is_err());

    std::fs::remove_dir_all(&vault).unwrap();
}

/// The media resolver must not follow a symlink that points outside the vault.
#[cfg(unix)]
#[test]
fn resolve_media_path_rejects_symlink_escape() {
    let vault = temp_vault("media-symlink");
    let root = vault.to_str().unwrap().to_string();
    std::fs::create_dir_all(vault.join("attachments")).unwrap();
    symlink("/etc/passwd", vault.join("attachments/escape.png")).unwrap();

    assert!(resolve_media_path(&root, "attachments/escape.png").is_err());

    std::fs::remove_dir_all(&vault).unwrap();
}

/// Unit coverage for the attachment-name sanitizer.
#[test]
fn sanitize_attachment_name_rules() {
    assert_eq!(sanitize_attachment_name("a.png").unwrap(), "a.png");
    assert!(sanitize_attachment_name("a.png").is_ok());
    assert!(sanitize_attachment_name("sub/a.png").is_err());
    assert!(sanitize_attachment_name("a\\b.png").is_err());
    assert!(sanitize_attachment_name("../a.png").is_err());
    assert!(sanitize_attachment_name("a..png").is_err());
    assert!(sanitize_attachment_name("noext").is_err());
    assert!(sanitize_attachment_name("").is_err());
    assert!(sanitize_attachment_name(".hidden").is_err());
    assert!(sanitize_attachment_name("a.b.png").is_ok());
}

/// `create_dir` makes nested directories and reports canonical relative paths;
/// duplicates and traversal are rejected.
#[test]
fn create_dir_nests_and_guards() {
    let vault = temp_vault("create-dir");
    let root = vault.to_str().unwrap().to_string();

    let rel = create_dir(&root, "notes/sub").unwrap();
    assert_eq!(rel, "notes/sub");
    assert!(vault.join("notes/sub").is_dir());

    assert!(create_dir(&root, "notes/sub").is_err());
    assert!(create_dir(&root, "../escape").is_err());
    assert!(create_dir(&root, "").is_err());

    std::fs::remove_dir_all(&vault).unwrap();
}

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
    assert_eq!(std::fs::read_to_string(vault.join("docs/b.md")).unwrap(), "# hi");

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

    std::fs::remove_dir_all(&vault).unwrap();
}

/// `save_attachment` accepts a custom vault-relative target directory and
/// writes the file there, returning the matching vault-relative path.
#[test]
fn save_attachment_into_custom_dir() {
    let vault = temp_vault("attach-dir");
    let root = vault.to_str().unwrap().to_string();

    let rel = save_attachment(&root, "shot.png", &b64(b"v1"), "notes/foo_assets").unwrap();
    assert_eq!(rel, "notes/foo_assets/shot.png");
    assert!(vault.join("notes/foo_assets/shot.png").is_file());
    assert_eq!(std::fs::read(vault.join(&rel)).unwrap(), b"v1");

    // A leading-dot dir (the unsaved-tab `.tmp` staging directory) works too.
    let tmp = save_attachment(&root, "drop.png", &b64(b"v2"), ".tmp").unwrap();
    assert_eq!(tmp, ".tmp/drop.png");
    assert_eq!(std::fs::read(vault.join(&tmp)).unwrap(), b"v2");

    std::fs::remove_dir_all(&vault).unwrap();
}

/// A `dir` that would escape the vault (or point outside it) is rejected.
#[test]
fn save_attachment_rejects_escaping_dir() {
    let vault = temp_vault("attach-dir-guard");
    let root = vault.to_str().unwrap().to_string();

    assert!(save_attachment(&root, "shot.png", &b64(b"v1"), "../evil").is_err());
    assert!(save_attachment(&root, "shot.png", &b64(b"v1"), "sub/../../evil").is_err());
    // An absolute directory is rejected outright, whichever platform's notion
    // of "absolute" applies.
    assert!(save_attachment(&root, "shot.png", &b64(b"v1"), outside_absolute_dir()).is_err());
    // The invariant that actually matters: nothing landed outside the vault.
    assert!(!vault.join("evil.png").exists());
    assert!(!vault.join("evil").exists());

    std::fs::remove_dir_all(&vault).unwrap();
}

/// Name collisions are deduped inside a *custom* dir with the same `-<n>`
/// suffix scheme as the legacy attachments layout.
#[test]
fn save_attachment_dedupes_in_custom_dir() {
    let vault = temp_vault("attach-dir-dedupe");
    let root = vault.to_str().unwrap().to_string();

    let a = save_attachment(&root, "shot.png", &b64(b"v1"), "notes/a_assets").unwrap();
    let b = save_attachment(&root, "shot.png", &b64(b"v2"), "notes/a_assets").unwrap();
    let c = save_attachment(&root, "shot.png", &b64(b"v3"), "notes/a_assets").unwrap();
    assert_eq!(a, "notes/a_assets/shot.png");
    assert_eq!(b, "notes/a_assets/shot-1.png");
    assert_eq!(c, "notes/a_assets/shot-2.png");
    assert_eq!(std::fs::read(vault.join(&a)).unwrap(), b"v1", "original untouched");

    std::fs::remove_dir_all(&vault).unwrap();
}

/// An empty (or normalized-empty) `dir` falls back to the legacy
/// `attachments/{YYYY-MM}` layout.
#[test]
fn save_attachment_empty_dir_falls_back_to_attachments() {
    let vault = temp_vault("attach-dir-empty");
    let root = vault.to_str().unwrap().to_string();

    for dir in ["", " ", "."] {
        let rel = save_attachment(&root, "shot.png", &b64(b"v1"), dir).unwrap();
        assert!(
            rel.starts_with("attachments/"),
            "dir {dir:?} fell back to attachments, got {rel:?}"
        );
    }

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
    assert!(!list_history(&root, path).unwrap().is_empty(), "history exists");

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

/// Concurrent `write_file`s on the same vault never panic, leave no `.tmp`
/// litter, and never corrupt the file: the read-old -> snapshot -> write
/// sequence is serialized, and the final content is one written payload.
#[test]
fn write_file_concurrent_serializes() {
    let vault = temp_vault("write-concurrent");
    let root = vault.to_str().unwrap().to_string();
    let path = "note.md";

    write_file(&root, path, "seed", Some(10)).unwrap();

    let mut handles = Vec::new();
    for i in 0..16 {
        let root = root.clone();
        handles.push(std::thread::spawn(move || {
            let content = format!("payload-{i}");
            for _ in 0..50 {
                write_file(&root, "note.md", &content, Some(10)).unwrap();
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }

    let final_content = read_file(&root, path).unwrap();
    assert!(
        final_content.starts_with("payload-"),
        "final content is one of the written payloads, got {final_content:?}"
    );

    // No crash litter: every successful write renamed its temp into place.
    let tmp: Vec<_> = std::fs::read_dir(&vault)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(tmp.is_empty(), "no .tmp litter after concurrent writes");

    std::fs::remove_dir_all(&vault).unwrap();
}

/// `cleanup_stale_tmp` removes only `.tmp` siblings older than `max_age`,
/// leaving fresh temp files, directories, and unrelated files untouched.
#[test]
fn cleanup_stale_tmp_removes() {
    let dir = temp_vault("tmp-clean");
    let old_tmp = dir.join(".note.111.tmp");
    let fresh_tmp = dir.join(".note.222.tmp");
    std::fs::write(&old_tmp, "stale").unwrap();

    // Let the stale file age well past the threshold, then create the fresh
    // one so the two differ by far more than any mtime granularity.
    std::thread::sleep(std::time::Duration::from_millis(100));
    std::fs::write(&fresh_tmp, "fresh").unwrap();
    std::fs::write(dir.join("keep.md"), "keep").unwrap();
    let max_age = std::time::Duration::from_millis(20);

    let removed = cleanup_stale_tmp(&dir, max_age).unwrap();
    assert_eq!(removed, 1, "exactly the stale tmp is removed");
    assert!(!old_tmp.exists(), "stale tmp removed");
    assert!(fresh_tmp.exists(), "fresh tmp kept");
    assert!(dir.join("keep.md").exists(), "non-tmp file untouched");

    // A directory named `*.tmp` must never be deleted.
    std::fs::create_dir_all(dir.join(".a.tmp")).unwrap();
    assert_eq!(cleanup_stale_tmp(&dir, max_age).unwrap(), 0);

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn search_notes_finds_deep_matches_without_the_old_dir_cap() {
    // The old bounds (512 dirs / depth 24) could silently drop a match buried in
    // a deeply nested tree. The default bound is generous (100k dirs / depth 64),
    // so a note 32 levels deep is still found.
    let vault = temp_vault("search-deep");
    let mut dir = vault.clone();
    for i in 0..32 {
        dir = dir.join(format!("d{i}"));
    }
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("needle.md"), "x").unwrap();
    let hits = search_notes(vault.to_str().unwrap(), "needle", 100).unwrap();
    assert_eq!(hits.len(), 1, "deep match must not be silently truncated");
    assert!(hits[0].path.contains("needle.md"));
    let _ = std::fs::remove_dir_all(&vault);
}

#[test]
fn search_notes_default_bound_is_generous_and_can_be_overridden() {
    let vault = temp_vault("search-bound");
    for i in 0..3 {
        let d = vault.join(format!("dir{i}"));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(format!("match-{i}.md")), "x").unwrap();
    }
    let root = vault.to_str().unwrap();
    // Default (None) → generous bound: every match is returned.
    let all = search_notes_with_max(root, "match", 100, None).unwrap();
    assert_eq!(all.len(), 3);
    // An explicit small override still succeeds and is configurable, not silent.
    let capped = search_notes_with_max(root, "match", 100, Some(0)).unwrap();
    assert!(capped.is_empty(), "an explicit 0-dir bound yields no matches");
    let _ = std::fs::remove_dir_all(&vault);
}

// ---------------------------------------------------------------------------
// import_attachment (picker-based import)
// ---------------------------------------------------------------------------

/// A temp directory holding one source image to import. Deliberately a sibling
/// of the vault, not inside it: the whole point of the picker is that the file
/// lives anywhere on disk.
fn temp_source_image(label: &str, name: &str, bytes: &[u8]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "nekowite-import-src-{label}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(name);
    std::fs::write(&file, bytes).unwrap();
    file
}

#[test]
fn import_attachment_copies_a_picked_file_into_the_vault() {
    let vault = temp_vault("import-basic");
    let root = vault.to_str().unwrap().to_string();
    let source = temp_source_image("basic", "cat.png", b"picked-bytes");

    let rel = import_attachment(&root, source.to_str().unwrap(), "notes/a_assets").unwrap();
    assert_eq!(rel, "notes/a_assets/cat.png");
    assert_eq!(std::fs::read(vault.join(&rel)).unwrap(), b"picked-bytes");
    // The original stays where the user had it.
    assert_eq!(std::fs::read(&source).unwrap(), b"picked-bytes");

    std::fs::remove_dir_all(&vault).unwrap();
    std::fs::remove_dir_all(source.parent().unwrap()).unwrap();
}

#[test]
fn import_attachment_falls_back_to_the_month_folder_for_an_empty_dir() {
    let vault = temp_vault("import-month");
    let root = vault.to_str().unwrap().to_string();

    for (i, dir) in ["", "  ", "."].into_iter().enumerate() {
        // A fresh name per pass: all three land in the same month folder, so
        // reusing one would (correctly) dedupe to `pic-1.webp`.
        let name = format!("pic{i}.webp");
        let source = temp_source_image("month", &name, b"w");
        let rel = import_attachment(&root, source.to_str().unwrap(), dir).unwrap();
        assert!(rel.starts_with("attachments/"), "got {rel}");
        assert_eq!(rel.split('/').nth(1).unwrap().len(), 7, "YYYY-MM: {rel}");
        assert!(rel.ends_with(&name), "got {rel}");
        assert!(vault.join(&rel).is_file());
        std::fs::remove_dir_all(source.parent().unwrap()).unwrap();
    }

    std::fs::remove_dir_all(&vault).unwrap();
}

#[test]
fn import_attachment_dedupes_a_name_collision() {
    let vault = temp_vault("import-dedupe");
    let root = vault.to_str().unwrap().to_string();
    let source = temp_source_image("dedupe", "shot.png", b"x");

    let a = import_attachment(&root, source.to_str().unwrap(), "assets").unwrap();
    let b = import_attachment(&root, source.to_str().unwrap(), "assets").unwrap();
    assert_eq!(a, "assets/shot.png");
    assert_eq!(b, "assets/shot-1.png");

    std::fs::remove_dir_all(&vault).unwrap();
    std::fs::remove_dir_all(source.parent().unwrap()).unwrap();
}

#[test]
fn import_attachment_accepts_the_allowlisted_extensions() {
    let vault = temp_vault("import-ext-ok");
    let root = vault.to_str().unwrap().to_string();

    for ext in ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "ico", "tiff", "tif"] {
        let name = format!("img.{ext}");
        let source = temp_source_image("ext-ok", &name, b"x");
        let rel = import_attachment(&root, source.to_str().unwrap(), "assets")
            .unwrap_or_else(|e| panic!("{ext} should import: {e}"));
        assert!(rel.ends_with(&name), "{rel}");
        // Case-insensitive, so a camera's uppercase extension still imports.
        let upper = format!("UPPER.{ext}").to_uppercase();
        let source_upper = temp_source_image("ext-upper", &upper, b"x");
        assert!(import_attachment(&root, source_upper.to_str().unwrap(), "assets").is_ok());
        std::fs::remove_dir_all(source.parent().unwrap()).unwrap();
        std::fs::remove_dir_all(source_upper.parent().unwrap()).unwrap();
    }

    std::fs::remove_dir_all(&vault).unwrap();
}

#[test]
fn import_attachment_rejects_anything_off_the_image_allowlist() {
    let vault = temp_vault("import-ext-bad");
    let root = vault.to_str().unwrap().to_string();

    for name in ["notes.txt", "payload.exe", "run.ps1", "archive.zip", "noext"] {
        let source = temp_source_image("ext-bad", name, b"x");
        assert!(
            import_attachment(&root, source.to_str().unwrap(), "assets").is_err(),
            "{name} must be rejected"
        );
        std::fs::remove_dir_all(source.parent().unwrap()).unwrap();
    }
    // Nothing was copied, and no directory was created for the rejects.
    assert!(!vault.join("assets").exists());

    std::fs::remove_dir_all(&vault).unwrap();
}

#[test]
fn import_attachment_rejects_a_non_absolute_or_missing_source() {
    let vault = temp_vault("import-src-guard");
    let root = vault.to_str().unwrap().to_string();

    assert!(import_attachment(&root, "relative/pic.png", "assets").is_err());
    let missing = vault.join("nope").join("missing.png");
    assert!(import_attachment(&root, missing.to_str().unwrap(), "assets").is_err());
    // A directory is not a file.
    assert!(import_attachment(&root, vault.to_str().unwrap(), "assets").is_err());

    std::fs::remove_dir_all(&vault).unwrap();
}

#[test]
fn import_attachment_rejects_a_source_over_the_size_cap() {
    let vault = temp_vault("import-oversize");
    let root = vault.to_str().unwrap().to_string();
    let source = temp_source_image("oversize", "huge.png", &[]);
    // Sparse: set the length instead of writing 10 MiB of zeros.
    let file = std::fs::OpenOptions::new().write(true).open(&source).unwrap();
    file.set_len(MAX_IMPORT_BYTES + 1).unwrap();
    drop(file);

    let err = import_attachment(&root, source.to_str().unwrap(), "assets").unwrap_err();
    assert!(err.contains("import limit"), "got {err}");
    assert!(!vault.join("assets/huge.png").exists());

    std::fs::remove_dir_all(&vault).unwrap();
    std::fs::remove_dir_all(source.parent().unwrap()).unwrap();
}

#[test]
fn import_attachment_confines_the_destination_to_the_vault() {
    let vault = temp_vault("import-dest-guard");
    let root = vault.to_str().unwrap().to_string();
    let source = temp_source_image("dest-guard", "shot.png", b"x");
    let path = source.to_str().unwrap();

    for dir in ["../evil", "sub/../../evil", ".."] {
        assert!(import_attachment(&root, path, dir).is_err(), "{dir} must be rejected");
    }
    assert!(!vault.join("evil/shot.png").exists());

    std::fs::remove_dir_all(&vault).unwrap();
    std::fs::remove_dir_all(source.parent().unwrap()).unwrap();
}

#[test]
fn is_importable_image_is_case_insensitive_and_extension_only() {
    assert!(is_importable_image(Path::new("/tmp/a.PNG")));
    assert!(is_importable_image(Path::new("/tmp/a.jpeg")));
    assert!(!is_importable_image(Path::new("/tmp/a.txt")));
    assert!(!is_importable_image(Path::new("/tmp/a")));
    assert!(!is_importable_image(Path::new("/tmp/png")));
}

/// `save_attachment` is reachable from more than the paste UI (plugins, the
/// chat panel, any future caller), so the backend enforces the same policy as
/// the picker rather than trusting the frontend's checks.
#[test]
fn save_attachment_enforces_the_size_cap() {
    let vault = temp_vault("attach-size-cap");
    let root = vault.to_str().unwrap().to_string();

    let oversize = vec![0u8; MAX_IMPORT_BYTES as usize + 1];
    let err = save_attachment(&root, "big.png", &b64(&oversize), "").unwrap_err();
    assert!(err.contains("limit"), "got {err}");
    assert!(!vault.join("attachments").exists(), "nothing was written");

    // The encoded-length check must reject without decoding an oversized
    // payload into memory.
    let encoded = "A".repeat((MAX_IMPORT_BYTES as usize).div_ceil(3) * 4 + 8);
    assert!(save_attachment(&root, "big.png", &encoded, "").is_err());

    // A payload at the limit is still accepted.
    let exactly = vec![0u8; MAX_IMPORT_BYTES as usize];
    assert!(save_attachment(&root, "at-limit.png", &b64(&exactly), "").is_ok());

    std::fs::remove_dir_all(&vault).unwrap();
}

/// The paste path shares the picker's extension allowlist: `sanitize_attachment_name`
/// only constrains the name's shape, so without this a rename to `notes.html`
/// would drop an executable/rendered file type into the vault.
#[test]
fn save_attachment_rejects_non_image_extensions() {
    let vault = temp_vault("attach-ext");
    let root = vault.to_str().unwrap().to_string();

    for bad in ["notes.html", "payload.exe", "run.ps1", "archive.zip", "data.json", "noext"] {
        assert!(
            save_attachment(&root, bad, &b64(b"x"), "").is_err(),
            "{bad} must be rejected"
        );
    }
    assert!(!vault.join("attachments").exists(), "nothing was written");

    // Case-insensitive, like the picker's check.
    assert!(save_attachment(&root, "SHOT.PNG", &b64(b"x"), "assets").is_ok());
    assert!(save_attachment(&root, "pic.webp", &b64(b"x"), "assets").is_ok());

    std::fs::remove_dir_all(&vault).unwrap();
}
