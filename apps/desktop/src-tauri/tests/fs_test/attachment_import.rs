//! The picker-based import: a file the user chose anywhere on disk is copied into the vault, with
//! the same extension allowlist, collision suffixes, size cap and destination confinement the paste
//! path applies.

use super::support::temp_vault;
use nekowite_lib::storage::file_store::{import_attachment, is_importable_image, MAX_IMPORT_BYTES};
use std::path::{Path, PathBuf};

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

    for ext in [
        "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "ico", "tiff", "tif",
    ] {
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

    for name in [
        "notes.txt",
        "payload.exe",
        "run.ps1",
        "archive.zip",
        "noext",
    ] {
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
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(&source)
        .unwrap();
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
        assert!(
            import_attachment(&root, path, dir).is_err(),
            "{dir} must be rejected"
        );
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
