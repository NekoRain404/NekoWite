//! What the `asset://` protocol is allowed to serve out of a vault.
//!
//! `asset://` is a privileged reader: whatever the scope allows, the webview can
//! read, no IPC guard in between. This suite pins the allow-set to the narrowest
//! thing the app can work with — the individual media files it resolved for the
//! notes on screen — and pins the refusals that make that set meaningful:
//! dotfiles, configuration, notes, the vault's own metadata trees, and anything
//! outside the vault the user currently has open.
//!
//! The tests drive the same function the `resolve_media_path` command calls, so
//! they cover the IPC boundary (an unopened vault grants nothing) as well as the
//! path policy.

use nekowite_lib::commands::fs::authorized_media_grant;
use nekowite_lib::VaultRegistry;
use std::fs;
use std::path::{Path, PathBuf};

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-assetscope-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn put(root: &Path, rel: &str, bytes: &[u8]) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
}

/// A vault shaped like a real one: notes, the shared attachment tree, a
/// per-note assets folder, staged pastes for an unsaved tab — plus everything
/// that must stay out of reach of `asset://`.
fn seeded_vault(label: &str) -> PathBuf {
    let root = temp_dir(label);
    put(&root, "notes/note.md", b"# note\n");
    put(&root, "notes/secret.md", b"# secret note\n");
    put(&root, "notes/note_assets/diagram.jpg", b"\xff\xd8\xff");
    put(&root, "attachments/2026-09/pic.png", b"\x89PNG\r\n\x1a\n");
    // Cross-directory: a note in `notes/` referencing a picture that is nowhere
    // near it. The whole point of the old tree-wide allow was that this resolves.
    put(&root, "other/deep/pic.png", b"\x89PNG\r\n\x1a\n");
    // Staged pastes (an unsaved tab has no folder of its own yet).
    put(&root, ".tmp/staged.png", b"\x89PNG\r\n\x1a\n");
    put(&root, ".tmp/sub/nested.png", b"\x89PNG\r\n\x1a\n");
    // App bookkeeping, a repository, and the user's own dotfiles/secrets.
    put(&root, ".nekowite/history/leak.png", b"\x89PNG\r\n\x1a\n");
    put(&root, ".nekowite-trash/leak.png", b"\x89PNG\r\n\x1a\n");
    put(&root, ".git/config", b"[core]\n");
    put(&root, ".env", b"API_KEY=secret\n");
    put(&root, ".ssh/id_rsa", b"PRIVATE KEY\n");
    put(&root, "config.toml", b"[ai]\n");
    put(&root, "data.json", b"{}\n");
    put(&root, "notes/passwd", b"root:x:0:0\n");
    // A dotfile that IS an image: hidden wins over the extension allowlist.
    put(&root, "assets/.hidden.png", b"\x89PNG\r\n\x1a\n");
    // A directory wearing an image extension.
    fs::create_dir_all(root.join("fake.png")).unwrap();
    root
}

/// The vault as the app has it once the user opened it.
fn opened_vault(root: &Path) -> VaultRegistry {
    let reg = VaultRegistry::default();
    reg.approve_pick(root.to_str().unwrap()).unwrap();
    reg.register(root.to_str().unwrap(), None).unwrap();
    reg
}

fn grant(root: &Path, reg: &VaultRegistry, rel: &str) -> Result<PathBuf, String> {
    authorized_media_grant(reg, root.to_str().unwrap(), rel)
}

fn refused(root: &Path, reg: &VaultRegistry, rel: &str) -> String {
    match grant(root, reg, rel) {
        Ok(path) => panic!(
            "{rel} must NOT be servable through asset://, but it granted {}",
            path.display()
        ),
        Err(e) => e,
    }
}

/// The grant is the FILE, not its folder and not a glob: one `allow_file` per
/// resolved path is the entire allow-set.
#[test]
fn an_image_is_granted_by_its_own_path_never_as_a_folder() {
    let root = seeded_vault("grant");
    let reg = opened_vault(&root);
    let granted = grant(&root, &reg, "attachments/2026-09/pic.png").unwrap();
    assert!(
        granted.is_file(),
        "the grant is a file: {}",
        granted.display()
    );
    assert!(
        !granted.is_dir(),
        "a directory grant would hand over the whole tree: {}",
        granted.display()
    );
    let text = granted.to_string_lossy();
    assert!(
        !text.contains('*') && !text.contains('?'),
        "the grant must be a literal path, not a pattern: {text}"
    );
    assert!(
        granted.starts_with(root.canonicalize().unwrap()),
        "the grant stays inside the vault: {}",
        granted.display()
    );
    let _ = fs::remove_dir_all(&root);
}

/// A note in one folder referencing a picture in another — the case the
/// tree-wide allow existed for. Per-file grants keep it working.
#[test]
fn attachments_are_granted_across_directories() {
    let root = seeded_vault("crossdir");
    let reg = opened_vault(&root);
    for rel in [
        "other/deep/pic.png",
        "notes/note_assets/diagram.jpg",
        "attachments/2026-09/pic.png",
    ] {
        assert!(
            grant(&root, &reg, rel).is_ok(),
            "{rel} is a picture the current note may reference"
        );
    }
    let _ = fs::remove_dir_all(&root);
}

/// Pasted images wait in the app's staging folder until the tab has a path, so
/// the staging folder is the one hidden directory the scope may reach into.
#[test]
fn staged_images_for_an_unsaved_tab_are_granted() {
    let root = seeded_vault("staged");
    let reg = opened_vault(&root);
    assert!(grant(&root, &reg, ".tmp/staged.png").is_ok());
    assert!(grant(&root, &reg, ".tmp/sub/nested.png").is_ok());
    let _ = fs::remove_dir_all(&root);
}

/// Ordinary notes are not media: the protocol must not become a second read
/// path for vault content that `read_file` already guards.
#[test]
fn notes_are_not_servable() {
    let root = seeded_vault("notes");
    let reg = opened_vault(&root);
    refused(&root, &reg, "notes/secret.md");
    refused(&root, &reg, "notes/note.md");
    refused(&root, &reg, "notes/passwd");
    let _ = fs::remove_dir_all(&root);
}

/// Configuration and secrets, with and without an image extension.
#[test]
fn dotfiles_and_configuration_are_not_servable() {
    let root = seeded_vault("config");
    let reg = opened_vault(&root);
    for rel in [
        ".env",
        ".ssh/id_rsa",
        "config.toml",
        "data.json",
        "assets/.hidden.png",
    ] {
        refused(&root, &reg, rel);
    }
    let _ = fs::remove_dir_all(&root);
}

/// The app's own bookkeeping and any repository the vault contains. An image
/// inside `.nekowite` is still bookkeeping, not a picture.
#[test]
fn metadata_trees_are_not_servable() {
    let root = seeded_vault("metadata");
    let reg = opened_vault(&root);
    for rel in [
        ".nekowite/history/leak.png",
        ".nekowite-trash/leak.png",
        ".git/config",
    ] {
        refused(&root, &reg, rel);
    }
    let _ = fs::remove_dir_all(&root);
}

/// Nothing outside the open vault, by traversal or by absolute path — including
/// a picture that lives in the vault the user just left.
#[test]
fn paths_outside_the_open_vault_are_not_servable() {
    let root = seeded_vault("outside");
    let other = temp_dir("outside-other");
    put(&other, "pic.png", b"\x89PNG\r\n\x1a\n");
    let reg = opened_vault(&root);
    refused(&root, &reg, "../outside.png");
    refused(&root, &reg, "notes/../../outside.png");
    let absolute = other.join("pic.png").to_string_lossy().to_string();
    let err = refused(&root, &reg, &absolute);
    assert!(
        err.contains("escapes vault"),
        "an absolute path into another vault is a traversal, got: {err}"
    );
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&other);
}

/// A folder named `pic.png`, and a picture that is not there yet, are both
/// nothing to serve.
#[test]
fn only_existing_media_files_are_granted() {
    let root = seeded_vault("shape");
    let reg = opened_vault(&root);
    refused(&root, &reg, "fake.png");
    refused(&root, &reg, "attachments/2026-09/missing.png");
    refused(&root, &reg, "notes/note_assets");
    let _ = fs::remove_dir_all(&root);
}

/// The IPC boundary: a vault the user never opened grants nothing, whatever the
/// path looks like.
#[test]
fn a_vault_that_was_never_opened_grants_nothing() {
    let root = seeded_vault("unopened");
    let reg = VaultRegistry::default();
    let err = grant(&root, &reg, "attachments/2026-09/pic.png")
        .expect_err("an unregistered vault must not extend the asset scope");
    assert!(
        err.contains("vault root is not open"),
        "expected the not-open error, got: {err}"
    );
    let _ = fs::remove_dir_all(&root);
}

/// Switching to a vault nested inside the one that was open: what the parent
/// vault holds is no longer reachable, and the nested vault's own pictures are.
#[test]
fn a_parent_vault_is_not_reachable_from_the_nested_vault_that_replaced_it() {
    let root = seeded_vault("nested-parent");
    let nested = root.join("other");
    // A picture the PARENT vault holds and the nested one does not.
    let parent_only = root.join("attachments/2026-09/pic.png");

    let reg = opened_vault(&root);
    assert!(grant(&root, &reg, "attachments/2026-09/pic.png").is_ok());

    // The user opens the nested folder as their vault (a real pick).
    reg.approve_pick(nested.to_str().unwrap()).unwrap();
    reg.register(nested.to_str().unwrap(), None).unwrap();

    // The picture is still on disk, but the vault that held it is closed: the
    // nested vault may only answer for paths inside itself.
    assert!(parent_only.is_file());
    let absolute = parent_only.to_string_lossy().to_string();
    let err = grant(&nested, &reg, &absolute).expect_err("the parent vault is closed");
    assert!(err.contains("escapes vault"), "got: {err}");
    refused(&nested, &reg, "../attachments/2026-09/pic.png");
    assert!(
        grant(&nested, &reg, "deep/pic.png").is_ok(),
        "the nested vault's own picture is still served"
    );
    let _ = fs::remove_dir_all(&root);
}
