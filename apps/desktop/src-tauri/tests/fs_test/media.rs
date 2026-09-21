//! The media resolver the `asset://` protocol is fed by: the grant reaches the whole vault (the
//! unsaved-tab `.tmp` staging directory and per-note asset folders included) while the command layer
//! stays vault-confinement only, and a resolution refuses a missing file, a traversal attempt and a
//! symlink that leaves the vault.

use super::support::temp_vault;
use nekowite_lib::domain::path_policy::has_hidden_component;
use nekowite_lib::storage::file_store::{list_dir, resolve_media_path, save_attachment};
#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::path::Path;

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
    assert!(has_hidden_component(Path::new(
        &vault.join(".nekowite/history/snap.md")
    )));
    assert!(has_hidden_component(Path::new(
        &vault.join(".nekowite-trash/key.md")
    )));
    assert!(has_hidden_component(Path::new(&vault.join(".git/index"))));
    assert!(!has_hidden_component(Path::new(
        &vault.join("notes/note_assets/pic.png")
    )));

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

#[test]
fn resolve_media_path_is_not_verbatim() {
    let vault = temp_vault("media-path");
    let root = vault.to_str().unwrap().to_string();
    save_attachment(&root, "a.png", "aGVsbG8=", "attachments").unwrap();
    let listing = list_dir(&root, Some("attachments")).unwrap();
    let file = listing
        .iter()
        .find(|e| e.name.ends_with(".png"))
        .expect("attachment");
    let resolved = resolve_media_path(&root, &file.path).unwrap();
    assert!(!resolved.starts_with(r"\\?\"), "verbatim: {resolved}");
    std::fs::remove_dir_all(&vault).unwrap();
}
