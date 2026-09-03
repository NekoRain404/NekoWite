use nekowite_lib::keys::{ensure_keyfile, validate_password};
#[cfg(unix)]
use nekowite_lib::keys::{open_snapshot, reencrypt_vault};
use std::fs;
#[cfg(unix)]
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
#[cfg(unix)]
use std::path::Path;
#[cfg(unix)]
use tauri_plugin_stronghold::stronghold::Stronghold;

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nekowite-keys-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Write a 32-byte key file at `path` with mode `0600` (unix; the platform
/// default elsewhere — the tests that use this only assert content).
#[cfg(unix)]
fn write_key_file(path: &Path, bytes: &[u8]) {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut f = options.open(path).unwrap();
    f.write_all(bytes).unwrap();
    f.sync_all().unwrap();
}

#[test]
#[cfg(unix)]
fn master_key_created_and_reused() {
    let dir = temp_dir("created");
    let p: PathBuf = dir.join("master.key");
    let a = ensure_keyfile(&p).unwrap();
    let b = ensure_keyfile(&p).unwrap();
    assert_eq!(a, b, "re-reading an existing key file must return the same bytes");
    assert_eq!(a.len(), 32, "master key must be 32 bytes");
    let perm = fs::metadata(&p).unwrap().permissions().mode();
    assert_eq!(perm & 0o777, 0o600, "master key file must be mode 0600");
    fs::remove_dir_all(&dir).unwrap();
}

/// `ensure_keyfile` must regenerate ONLY on a missing file (`NotFound`). A
/// non-NotFound read error (here: the path is a directory → EISDIR) must be
/// propagated, not overwritten with a fresh key.
#[test]
fn ensure_keyfile_errors_on_non_notfound() {
    let dir = temp_dir("nonnotfound");
    let p: PathBuf = dir.join("master.key");
    fs::create_dir_all(&p).unwrap();
    let err = ensure_keyfile(&p).unwrap_err();
    assert!(
        err.contains("cannot read master key file"),
        "expected read error to propagate, got: {err}"
    );
    assert!(p.is_dir(), "non-NotFound error must not be treated as missing");
    fs::remove_dir_all(&dir).unwrap();
}

/// A master key file that is not exactly 32 bytes must be rejected, not
/// silently regenerated (a corrupt/partial key must never be overwritten).
#[test]
#[cfg(unix)]
fn ensure_keyfile_rejects_wrong_length() {
    let dir = temp_dir("wronglen");
    let p: PathBuf = dir.join("master.key");
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&p)
        .unwrap();
    f.write_all(&[7u8; 16]).unwrap();
    f.sync_all().unwrap();
    drop(f);
    let err = ensure_keyfile(&p).unwrap_err();
    assert!(
        err.contains("invalid length 16"),
        "expected invalid-length error, got: {err}"
    );
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn validate_password_rejects_empty() {
    assert!(validate_password("").is_err());
    assert!(validate_password("   ").is_err());
    assert!(validate_password("correct horse battery staple").is_ok());
}

/// Full re-encrypt round-trip through REAL stronghold (no AppHandle needed —
/// `reencrypt_vault` is a pure path-level function). Proves the new-key
/// snapshot is readable with the new key, the old key no longer decrypts it,
/// and no stale temp/staging files are left behind by the two-phase swap. The
/// old snapshot is never removed — `fs::rename` atomically replaces it in
/// place.
///
/// Marked `#[ignore]` because stronghold's Argon2 KDF is intentionally slow
/// (~30s per `Stronghold::new` in debug), making this ~2.5 min. Run explicitly
/// with `cargo test -- --ignored`.
#[test]
#[ignore]
#[cfg(unix)]
fn reencrypt_vault_migrates_records_to_new_key() {
    let dir = temp_dir("reencrypt");
    let snapshot = dir.join("stronghold.bin");
    let key_path = dir.join("master.key");
    const CLIENT: [u8; 32] = [1u8; 32];
    let old_key = [3u8; 32];
    let new_key = [9u8; 32];

    // Seed: old-key snapshot holding one record + the old master.key file.
    {
        let stronghold = Stronghold::new(snapshot.clone(), old_key.to_vec()).unwrap();
        let client = stronghold.inner().create_client(CLIENT).unwrap();
        client
            .store()
            .insert(b"openai".to_vec(), b"sk-old".to_vec(), None)
            .unwrap();
        stronghold.save().unwrap();
    }
    write_key_file(&key_path, &old_key);

    let records = vec![(b"openai".to_vec(), b"sk-old".to_vec())];
    reencrypt_vault(&snapshot, &key_path, &new_key, &records).unwrap();

    // New master.key on disk, old key file replaced.
    assert_eq!(fs::read(&key_path).unwrap(), new_key.to_vec());

    // Snapshot now decrypts with the new key and retains the record.
    let stronghold = Stronghold::new(snapshot.clone(), new_key.to_vec()).unwrap();
    let client = stronghold.inner().load_client(CLIENT).unwrap();
    let got = client
        .store()
        .get(b"openai".as_slice())
        .unwrap()
        .map(|b| String::from_utf8_lossy(&b).to_string());
    assert_eq!(got.as_deref(), Some("sk-old"));

    // Old key can no longer decrypt.
    assert!(Stronghold::new(snapshot.clone(), old_key.to_vec()).is_err());

    // No stale temp snapshot or key staging/backup file left behind.
    assert!(!dir.join(".stronghold.bin.tmp").exists());
    assert!(!dir.join("master.key.new").exists());
    assert!(!dir.join("master.key.old").exists());

    fs::remove_dir_all(&dir).unwrap();
}

/// Crash recovery for an interrupted `reencrypt_vault`: a crash after step 4
/// (the new key was promoted to `master.key`) but before step 5 (the snapshot
/// swap) leaves the NEW key beside a snapshot still encrypted with the OLD key,
/// which lives on in `master.key.old`. `open_snapshot` must fall back to that
/// backup and recover the vault instead of failing. Also checks that the
/// primary error is surfaced when no usable backup exists.
///
/// Marked `#[ignore]` for the same Argon2 KDF cost as the re-encrypt test (3
/// real snapshot opens). Run explicitly with `cargo test -- --ignored`.
#[test]
#[ignore]
#[cfg(unix)]
fn open_snapshot_recovers_with_master_key_old_backup() {
    let dir = temp_dir("recovery");
    let snapshot = dir.join("stronghold.bin");
    let key_path = dir.join("master.key");
    const CLIENT: [u8; 32] = [1u8; 32];
    let old_key = [3u8; 32];
    let new_key = [9u8; 32];

    // Seed: old-key snapshot holding one record.
    {
        let stronghold = Stronghold::new(snapshot.clone(), old_key.to_vec()).unwrap();
        let client = stronghold.inner().create_client(CLIENT).unwrap();
        client
            .store()
            .insert(b"openai".to_vec(), b"sk-old".to_vec(), None)
            .unwrap();
        stronghold.save().unwrap();
    }

    // Simulate the interrupted-swap state: master.key holds the NEW key (which
    // cannot decrypt the old snapshot yet), the OLD key survives in the backup.
    write_key_file(&key_path, &new_key);
    write_key_file(&dir.join("master.key.old"), &old_key);

    // The new key alone would fail; the `master.key.old` fallback recovers.
    let stronghold = open_snapshot(&snapshot, &key_path, new_key.to_vec()).unwrap();
    let client = stronghold.inner().load_client(CLIENT).unwrap();
    let got = client
        .store()
        .get(b"openai".as_slice())
        .unwrap()
        .map(|b| String::from_utf8_lossy(&b).to_string());
    assert_eq!(got.as_deref(), Some("sk-old"));

    // Without the backup the same open must fail (primary error surfaced).
    fs::remove_file(dir.join("master.key.old")).unwrap();
    assert!(open_snapshot(&snapshot, &key_path, new_key.to_vec()).is_err());

    fs::remove_dir_all(&dir).unwrap();
}
