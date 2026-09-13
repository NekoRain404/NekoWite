//! Crash recovery for the encrypted vault: what the on-disk key files must
//! look like when a `set_master_password` swap is interrupted, and what the
//! load-time fallback and the master-password unlock are able to find
//! afterwards.
//!
//! The expensive tests here build REAL snapshots (each `Stronghold::new` pays
//! the Argon2id KDF, ~1 minute in debug), so they are `#[ignore]`d and run with
//! `cargo test -- --ignored`. The cheap ones pin the file-name contract the
//! recovery depends on.

use nekowite_lib::commands::keys::{password_candidates, unlock_snapshot};
use nekowite_lib::domain::recovery::{backup_key_paths, open_snapshot, reencrypt_vault};
use nekowite_lib::storage::key_store::{
    derive_master_key, encode_keyfile_password, encode_keyfile_passwordless, sibling_suffixed,
    verifier_of,
};
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

/// The unlock path reads the same key files the load-time recovery does.
///
/// `unlock_vault` used to read `master.key` and the canonical `master.key.old`
/// slot only, while `open_snapshot` searched every backup beside them. A
/// password-protected vault whose only usable key had been rotated out of the
/// slot (see `unlock_opens_a_vault_through_a_rotated_backup`) therefore could
/// not be unlocked with the password that opens it: the key file was right
/// there, under a name the unlock path never read.
#[test]
fn unlock_candidates_cover_every_backup_the_recovery_path_searches() {
    let dir = temp_dir("unlock-candidates");
    let key_path = dir.join("master.key");

    let current_salt = [11u8; 32];
    let current = verifier_of(&derive_master_key("current password", &current_salt).unwrap());
    fs::write(&key_path, encode_keyfile_password(&current_salt, &current)).unwrap();

    let canonical_salt = [12u8; 32];
    let canonical = verifier_of(&derive_master_key("first password", &canonical_salt).unwrap());
    fs::write(
        sibling_suffixed(&key_path, "old"),
        encode_keyfile_password(&canonical_salt, &canonical),
    )
    .unwrap();

    let older_salt = [13u8; 32];
    let older = verifier_of(&derive_master_key("older password", &older_salt).unwrap());
    fs::write(
        sibling_suffixed(&key_path, "old-1700000000000"),
        encode_keyfile_password(&older_salt, &older),
    )
    .unwrap();

    let newer_salt = [14u8; 32];
    let newer = verifier_of(&derive_master_key("newer password", &newer_salt).unwrap());
    fs::write(
        sibling_suffixed(&key_path, "old-1700000000001"),
        encode_keyfile_password(&newer_salt, &newer),
    )
    .unwrap();

    assert_eq!(
        password_candidates(&key_path).unwrap(),
        vec![
            (current_salt, current),
            (canonical_salt, canonical),
            (newer_salt, newer),
            (older_salt, older),
        ],
        "the current key file first, then every backup recovery searches, newest rotation first"
    );

    // Neither of these may become a candidate. `master.key.new` belongs to a
    // swap that has not been committed, and a passwordless backup has no
    // password to check: honoring one would let any string typed into the
    // unlock dialog open a vault whose `master.key` claims a password protects
    // it.
    fs::write(
        sibling_suffixed(&key_path, "new"),
        encode_keyfile_password(&[15u8; 32], &[16u8; 32]),
    )
    .unwrap();
    fs::write(
        sibling_suffixed(&key_path, "old-1700000000002"),
        encode_keyfile_passwordless(&[17u8; 32]),
    )
    .unwrap();
    assert_eq!(
        password_candidates(&key_path).unwrap().len(),
        4,
        "the staging file and a passwordless backup must not be offered"
    );

    // A vault with no master password set has nothing to unlock, whatever the
    // backups hold.
    fs::write(&key_path, encode_keyfile_passwordless(&[18u8; 32])).unwrap();
    assert_eq!(
        password_candidates(&key_path).unwrap_err(),
        "no master password is set"
    );

    let _ = fs::remove_dir_all(&dir);
}

/// A wrong password must not write anything.
///
/// The candidate list is built by READING key files, and `read_vault_key_state`
/// creates a missing one (a fresh random passwordless key). Probing a
/// `master.key.old` that is not there therefore forged a backup on every failed
/// or wrong-password unlock — a file that opens nothing, which the recovery
/// path then tries and a later swap rotates into the key-file history.
#[test]
fn a_wrong_password_does_not_forge_a_master_key_backup() {
    let dir = temp_dir("unlock-no-forge");
    let key_path = dir.join("master.key");
    let salt = [21u8; 32];
    let verifier = verifier_of(&derive_master_key("the real password", &salt).unwrap());
    fs::write(&key_path, encode_keyfile_password(&salt, &verifier)).unwrap();

    let err = match unlock_snapshot(&dir.join("stronghold.bin"), &key_path, "not the password") {
        Ok(_) => panic!("a wrong password must be refused"),
        Err(e) => e,
    };
    assert_eq!(err, "incorrect master password");
    assert!(
        !sibling_suffixed(&key_path, "old").exists(),
        "a wrong password must not create a master.key.old"
    );
    let files: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(
        files,
        vec!["master.key".to_string()],
        "a failed unlock must leave the key files alone, got {files:?}"
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

/// A password-protected vault whose only usable key was ROTATED must still
/// unlock with the password that key belongs to.
///
/// The state is reachable, and it is exactly the one `displace_current_key`
/// refuses to destroy: a swap interrupted between steps 4 and 5 leaves
/// `master.key` holding a key that opens nothing and the real key in
/// `master.key.old`, the vault is recovered from there (with the old password,
/// through `unlock_vault`), and the NEXT password change starts by rotating
/// that backup out of the slot to `master.key.old-<ms>`. Interrupt that swap
/// too and the only key that decrypts the live snapshot sits in the rotated
/// name, with a password-protected key file in `master.key`.
///
/// `open_snapshot` cannot help here — a password-protected backup has no key to
/// hand it, the key has to be derived from the password, and it skips those —
/// so `unlock_vault` is the only path that can open this vault, and it has to
/// look in the rotated slot.
///
/// `#[ignore]`d for the Argon2 cost (two real Stronghold opens, ~2 min in
/// debug); run with `cargo test -- --ignored`.
#[test]
#[ignore = "two real Stronghold opens: ~2 minutes in debug"]
#[cfg(unix)]
fn unlock_opens_a_vault_through_a_rotated_backup() {
    use tauri_plugin_stronghold::stronghold::Stronghold;

    let dir = temp_dir("unlock-rotated");
    let snapshot = dir.join("stronghold.bin");
    let key_path = dir.join("master.key");
    const CLIENT: [u8; 32] = [1u8; 32];

    // The vault the user actually has: encrypted under a key derived from their
    // password, holding one record.
    let password = "correct horse battery staple";
    let salt = [42u8; 32];
    let genuine_key = derive_master_key(password, &salt).unwrap();
    {
        let stronghold = Stronghold::new(snapshot.clone(), genuine_key.to_vec()).unwrap();
        let client = stronghold.inner().create_client(CLIENT).unwrap();
        client
            .store()
            .insert(b"openai".to_vec(), b"sk-old".to_vec(), None)
            .unwrap();
        stronghold.save().unwrap();
    }

    // The interrupted-swap state: `master.key` carries the password of the
    // swap that never committed (so it opens nothing), and the password that
    // does open the snapshot survives in the rotated backup.
    let stale_salt = [7u8; 32];
    let stale_key =
        derive_master_key("the password of the swap that was interrupted", &stale_salt).unwrap();
    fs::write(
        &key_path,
        encode_keyfile_password(&stale_salt, &verifier_of(&stale_key)),
    )
    .unwrap();
    let rotated = sibling_suffixed(&key_path, "old-1700000000000");
    write_key_file(
        &rotated,
        &encode_keyfile_password(&salt, &verifier_of(&genuine_key)),
    );

    // Anything else is still refused — a rotated key file is not a bypass.
    assert!(
        unlock_snapshot(&snapshot, &key_path, "not the password").is_err(),
        "only the password of a key file on disk may unlock"
    );

    // Before this fix the loop read `master.key` and `.old` only and answered
    // "incorrect master password", leaving a vault whose key was on disk
    // unopenable by any path.
    let stronghold = unlock_snapshot(&snapshot, &key_path, password)
        .expect("the password whose key file was rotated must still unlock");
    let client = stronghold.inner().load_client(CLIENT).unwrap();
    let got = client
        .store()
        .get(b"openai".as_slice())
        .unwrap()
        .map(|b| String::from_utf8_lossy(&b).to_string());
    assert_eq!(got.as_deref(), Some("sk-old"));

    // The rotated backup is what opened it: with that file gone the same
    // password decrypts nothing.
    fs::remove_file(&rotated).unwrap();
    assert!(unlock_snapshot(&snapshot, &key_path, password).is_err());

    let _ = fs::remove_dir_all(&dir);
}
