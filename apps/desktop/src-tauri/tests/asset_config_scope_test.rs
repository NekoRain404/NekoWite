//! What `tauri.conf.json` grants the `asset://` protocol — executed, not read.
//!
//! `asset_scope_test.rs` pins the Rust half: which files `resolve_media_path`
//! will grant, one at a time, after the vault and the extension have been
//! checked. This file pins the other half, the static
//! `security.assetProtocol.scope` entry, because a scope widened by CONFIG
//! bypasses that function entirely — `asset://` has no IPC guard in front of it,
//! so whatever the scope allows, the webview reads.
//!
//! The config used to carry `"scope": ["attachments/**"]` — a glob, and a
//! relative one — while `commands/fs.rs` said in as many words that "the scope
//! is never extended by a directory, a tree or a glob". One of the two was
//! wrong. The audit that found this read Tauri 2.11.5's matcher and concluded
//! the entry was inert; this suite executes the matcher instead:
//!
//! ```text
//! scope <-> config ["attachments/**"]                allowed_patterns = ["attachments/**"]  (relative)
//! is_allowed(<abs path of a real vault attachment>)  false
//! is_allowed("attachments/not-here.png")             true   <- a relative input, and only that
//! is_allowed(<abs path>, pattern "<site>/attachments/**")  true   <- same glob, made absolute
//! ```
//!
//! So the entry granted nothing: a relative pattern never matches the
//! canonicalized ABSOLUTE path the protocol asks about. It is not dead code,
//! though — it matched a relative input, and `Scope::is_allowed` canonicalizes a
//! path that exists before matching it, so the one arm it reaches can only ever
//! name a path that does not exist, which `File::open` then refuses. The entry
//! was removed rather than made to work: widening it would hand every
//! `attachments/` tree of every vault to the protocol with none of the
//! extension, dotfile or open-vault checks of `asset_media_grant`.
//!
//! These tests therefore assert the ABSENCE, and the last one keeps the reading
//! as a measurement — the behaviour is Tauri's, not ours, and a version that
//! made relative patterns work would turn that config entry back into a grant.
//! A test asserting nothing is granted must be able to prove it can say YES:
//! `a_granted_file_is_still_served` is that control.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::utils::config::FsScope;
use tauri::Manager;

/// The scope the app itself installs.
///
/// `tauri.conf.json` is read by `generate_context!` and handed to `Scope::new`
/// by Tauri's own `Builder`, so this is the shipped scope rather than a
/// re-creation of it: if the config entry comes back, these tests see it with no
/// test-side change.
fn app_scope() -> tauri::scope::fs::Scope {
    let app = tauri::test::mock_builder()
        .build(tauri::generate_context!())
        .expect("the app's own tauri.conf.json builds a context");
    app.asset_protocol_scope()
}

fn vault(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "nkw-cfgscope-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A real image file in a vault's shared attachment tree — the path an
/// `attachments/**` entry would have handed to the protocol.
fn attachment(root: &Path) -> PathBuf {
    let path = root.join("attachments/2026-09/pic.png");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"\x89PNG\r\n\x1a\n").unwrap();
    path
}

/// The config must contribute no pattern at all.
///
/// The app's grant is made at runtime by `allow_media_file`, one resolved file
/// at a time; anything listed here is a standing permission nobody asked for,
/// and it is invisible to every Rust-side check because `asset://` is not a
/// command.
#[test]
fn the_config_contributes_no_pattern_of_its_own() {
    let scope = app_scope();
    let granted = scope.allowed_patterns();
    let patterns: Vec<&str> = granted.iter().map(|p| p.as_str()).collect();
    assert!(
        patterns.is_empty(),
        "the static config must not widen `asset://`; it grants {patterns:?}"
    );
    assert_eq!(
        scope.forbidden_patterns().len(),
        0,
        "a forbidden pattern is a permanent denial that no later grant can undo"
    );
}

/// The regression this file exists for, in its original shape: a vault's own
/// attachment tree must not be reachable through a config entry.
#[test]
fn a_vault_attachment_is_not_granted_by_the_config() {
    let root = vault("config-glob");
    let pic = attachment(&root);
    assert!(
        !app_scope().is_allowed(&pic),
        "a config entry granted {}; that path reaches the webview with no \
         extension, dotfile or open-vault check in front of it",
        pic.display()
    );
    let _ = fs::remove_dir_all(&root);
}

/// The control: the same scope, asked about a file of exactly this shape in
/// exactly this location, says YES once the app grants it the way it really does.
///
/// Without this, the assertions above would also hold for a scope that matched
/// nothing at all — a broken matcher, a path spelling that never canonicalizes,
/// an empty temp file. This is what makes their `false` evidence.
#[test]
fn a_granted_file_is_still_served() {
    let root = vault("grant");
    let pic = attachment(&root);
    let scope = app_scope();
    assert!(!scope.is_allowed(&pic), "nothing has granted it yet");

    // What `resolve_media_path` does for one resolved reference.
    scope
        .allow_file(&pic)
        .expect("a per-file grant is accepted");
    assert!(
        scope.is_allowed(&pic),
        "the per-file grant the app makes at runtime must reach the protocol: {}",
        pic.display()
    );
    let _ = fs::remove_dir_all(&root);
}

/// The reading turned into a standing measurement.
///
/// A relative pattern in the scope does not match the absolute path the
/// protocol asks about — and the ONLY shape it does match is a relative input,
/// which `Scope::is_allowed` leaves relative only while the path does not exist
/// (`try_resolve_symlink_and_canonicalize`: an existing path is canonicalized
/// first). A file that is really there can therefore never be named by it.
///
/// This does not depend on our config any more: it builds the scope from the
/// same `FsScope` the config was, because the behaviour belongs to Tauri. If a
/// future version makes a relative pattern match an absolute path, this test is
/// where it shows up — and the answer is to keep `tauri.conf.json` free of
/// globs, not to relax this assertion.
#[test]
fn a_relative_pattern_matches_only_a_path_that_cannot_be_opened() {
    let app = tauri::test::mock_app();
    let config_shaped = tauri::scope::fs::Scope::new(
        &app,
        &FsScope::AllowedPaths(vec![PathBuf::from("attachments/**")]),
    )
    .unwrap();

    let root = vault("relative-pattern");
    let pic = attachment(&root);
    assert!(
        !config_shaped.is_allowed(&pic),
        "a relative `attachments/**` matched the absolute path of a real file: \
         {} would be servable through `asset://` with no Rust-side check",
        pic.display()
    );
    // The arm it does reach. A relative input is matched as-is only because it
    // does not exist; `get_response` opens the very next statement, and there is
    // nothing there to open. If this ever reads false, the entry got strictly
    // safer — update this line, do not "fix" it.
    assert!(
        config_shaped.is_allowed("attachments/not-here.png"),
        "the relative pattern stopped matching relative input"
    );

    // The same glob, made absolute, is not inert — so the `false` above is about
    // the spelling of the pattern and nothing else.
    let absolute = tauri::scope::fs::Scope::new(
        &app,
        &FsScope::AllowedPaths(vec![root.join("attachments/**")]),
    )
    .unwrap();
    assert!(
        absolute.is_allowed(&pic),
        "an absolute `attachments/**` must match a file under that folder, \
         otherwise the matcher is being asked the wrong question: {}",
        pic.display()
    );
    let _ = fs::remove_dir_all(&root);
}
