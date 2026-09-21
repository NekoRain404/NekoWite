//! The paste path: `save_attachment` decodes base64 into `attachments/{YYYY-MM}` or a caller-named
//! directory, dedupes a name collision, and enforces the name, extension and size policy — the same
//! policy the picker enforces, because this entry point has more callers than the paste UI.

use super::support::temp_vault;
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use nekowite_lib::domain::path_policy::resolve_within;
use nekowite_lib::storage::file_store::{
    list_dir, sanitize_attachment_name, save_attachment, MAX_IMPORT_BYTES,
};

fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
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
    let month = rel.split('/').nth(1).expect("month segment").to_string();
    assert_eq!(month.len(), 7, "YYYY-MM month dir: {month:?}");
    assert!(
        month.starts_with("20"),
        "month looks like a year: {month:?}"
    );
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
    assert!(
        std::fs::read(vault.join(&first)).unwrap() == b"v1",
        "original untouched"
    );
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
    assert!(
        !vault.join("evil.png").exists(),
        "no file escaped the vault"
    );
    assert!(
        list_dir(&root, Some("."))
            .unwrap()
            .iter()
            .all(|e| e.name != "attachments"),
        "nothing written"
    );

    std::fs::remove_dir_all(&vault).unwrap();
}

/// Invalid base64 payloads are refused before anything is written.
#[test]
fn save_attachment_rejects_bad_base64() {
    let vault = temp_vault("attach-b64");
    let root = vault.to_str().unwrap().to_string();
    assert!(save_attachment(&root, "ok.png", "not!base64!!", "").is_err());
    assert!(list_dir(&root, Some("."))
        .unwrap()
        .iter()
        .all(|e| e.name != "attachments"));
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
    assert_eq!(
        std::fs::read(vault.join(&a)).unwrap(),
        b"v1",
        "original untouched"
    );

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

    for bad in [
        "notes.html",
        "payload.exe",
        "run.ps1",
        "archive.zip",
        "data.json",
        "noext",
    ] {
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
