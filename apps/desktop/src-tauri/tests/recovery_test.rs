//! Crash recovery for the encrypted vault: what the on-disk key files must
//! look like when a `set_master_password` swap is interrupted, and what the
//! load-time fallback is able to find afterwards.
//!
//! The expensive tests here build REAL snapshots (each `Stronghold::new` pays
//! the Argon2id KDF, ~1 minute in debug), so they are `#[ignore]`d and run with
//! `cargo test -- --ignored`. The cheap ones pin the file-name contract the
//! recovery depends on.

use nekowite_lib::domain::recovery::{backup_key_paths, open_snapshot, reencrypt_vault};
use nekowite_lib::storage::key_store::{encode_keyfile_passwordless, sibling_suffixed};
use std::fs;
#[cfg(unix)]
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

fn temp_dir(label: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("nekowite-recovery-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Write a key file with mode `0600` on unix, like the real key store does.
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

/// The recovery order: the canonical `master.key.old` slot first, then the
/// backups a previous swap displaced out of it, newest first.
///
/// A swap that finds `.old` occupied has to move that file aside rather than
/// delete it (it may be the only key that decrypts the live snapshot), which is
/// only worth anything if recovery still looks at the rotated name.
#[test]
fn backup_candidates_start_with_the_canonical_slot_then_newest_rotation() {
    let dir = temp_dir("candidates");
    let key_path = dir.join("master.key");
    fs::write(&key_path, encode_keyfile_passwordless(&[1u8; 32])).unwrap();
    assert!(
        backup_key_paths(&key_path).is_empty(),
        "a vault that never swapped a key has no backup to try"
    );

    let canonical = sibling_suffixed(&key_path, "old");
    fs::write(&canonical, encode_keyfile_passwordless(&[2u8; 32])).unwrap();
    assert_eq!(backup_key_paths(&key_path), vec![canonical.clone()]);

    let older = sibling_suffixed(&key_path, "old-1700000000000");
    let newer = sibling_suffixed(&key_path, "old-1700000000001");
    fs::write(&older, encode_keyfile_passwordless(&[3u8; 32])).unwrap();
    fs::write(&newer, encode_keyfile_passwordless(&[4u8; 32])).unwrap();
    assert_eq!(
        backup_key_paths(&key_path),
        vec![canonical, newer, older],
        "every backup stays reachable, the canonical slot first"
    );

    // The staging file of a swap in flight is NOT a backup: it holds the new
    // key, which cannot open the snapshot that is still live.
    fs::write(
        sibling_suffixed(&key_path, "new"),
        encode_keyfile_passwordless(&[5u8; 32]),
    )
    .unwrap();
    assert!(
        !backup_key_paths(&key_path)
            .iter()
            .any(|p| p.ends_with("master.key.new")),
        "the staging file must not be offered as a recovery key"
    );

    let _ = fs::remove_dir_all(&dir);
}

/// A swap that fails AFTER it moved the key files must leave the disk exactly
/// where it started, including the backup that opens the live snapshot.
///
/// The state seeded here is the one an interrupted earlier swap leaves:
/// `master.key` holds a key that does NOT decrypt the live snapshot, and
/// `master.key.old` holds the one that does — which is exactly why
/// `open_snapshot` falls back to it. Re-encrypting from there used to delete
/// that backup unconditionally and promote the (useless) `master.key` into its
/// place, forging a backup that opens nothing: combined with the failure below,
/// the vault was left with no key able to decrypt it, permanently.
///
/// The failure is injected at the snapshot swap: a directory at the destination
/// makes that rename fail (EISDIR) after the key files have already moved, so
/// the rollback path is the one under test. `#[ignore]`d for the Argon2 cost.
#[test]
#[ignore = "three real Stronghold opens: ~3 minutes in debug"]
#[cfg(unix)]
fn a_failed_swap_keeps_the_backup_that_opens_the_snapshot() {
    use tauri_plugin_stronghold::stronghold::Stronghold;

    let dir = temp_dir("interrupted-swap");
    let live = dir.join("live.bin");
    let snapshot_path = dir.join("stronghold.bin");
    let key_path = dir.join("master.key");
    const CLIENT: [u8; 32] = [1u8; 32];
    let stale_key = [4u8; 32];
    let genuine_key = [3u8; 32];
    let new_key = [9u8; 32];

    // The snapshot the user actually has, encrypted with the genuine key.
    {
        let stronghold = Stronghold::new(live.clone(), genuine_key.to_vec()).unwrap();
        let client = stronghold.inner().create_client(CLIENT).unwrap();
        client
            .store()
            .insert(b"openai".to_vec(), b"sk-old".to_vec(), None)
            .unwrap();
        stronghold.save().unwrap();
    }
    let genuine_keyfile = encode_keyfile_passwordless(&genuine_key);
    write_key_file(&key_path, &encode_keyfile_passwordless(&stale_key));
    let backup_path = sibling_suffixed(&key_path, "old");
    write_key_file(&backup_path, &genuine_keyfile);
    let master_before = fs::read(&key_path).unwrap();

    // Fault injection: the destination of the final swap is a non-empty
    // directory, so only the last step of the sequence fails.
    fs::create_dir_all(&snapshot_path).unwrap();
    fs::write(snapshot_path.join("occupied"), "x").unwrap();

    let err = reencrypt_vault(
        &snapshot_path,
        &key_path,
        &new_key,
        &encode_keyfile_passwordless(&new_key),
        &[],
    )
    .unwrap_err();
    assert!(
        err.contains("snapshot"),
        "the failure must name the snapshot swap: {err}"
    );

    // An error status means nothing was committed.
    assert_eq!(
        fs::read(&key_path).unwrap(),
        master_before,
        "a failed swap must put the current key file back untouched"
    );
    assert_eq!(
        fs::read(&backup_path).unwrap_or_default(),
        genuine_keyfile,
        "the backup that opens the live snapshot was destroyed by the failed swap"
    );
    let key_files: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("master.key"))
        .collect();
    let mut sorted = key_files.clone();
    sorted.sort();
    assert_eq!(
        sorted,
        vec!["master.key".to_string(), "master.key.old".to_string()],
        "a failed swap leaves exactly the two key files it started with, got {key_files:?}"
    );

    // And the load-time recovery really can still get in: the primary key is
    // the one that does not decrypt the snapshot, so this succeeds only through
    // the backup.
    let stronghold = open_snapshot(&live, &key_path, stale_key.to_vec())
        .expect("recovery must still find a key that opens the snapshot");
    let client = stronghold.inner().load_client(CLIENT).unwrap();
    let got = client
        .store()
        .get(b"openai".as_slice())
        .unwrap()
        .map(|b| String::from_utf8_lossy(&b).to_string());
    assert_eq!(got.as_deref(), Some("sk-old"));

    let _ = fs::remove_dir_all(&dir);
}
