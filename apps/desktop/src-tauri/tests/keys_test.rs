use nekowite_lib::commands::keys::password_candidates;
#[cfg(unix)]
use nekowite_lib::domain::recovery::{open_snapshot, reencrypt_vault};
#[cfg(unix)]
use nekowite_lib::storage::key_file_io::DiskKeyFiles;
use nekowite_lib::storage::key_store::{
    ai_key_presence, decode_keyfile, derive_master_key, encode_keyfile_password,
    encode_keyfile_passwordless, ensure_keyfile, read_vault_key_state, sibling_suffixed,
    validate_password, validate_stored_api_key, verifier_of, VaultKeyState, AI_KEY_MASKED,
};
use std::fs;
#[cfg(unix)]
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;
#[cfg(unix)]
use tauri_plugin_stronghold::stronghold::Stronghold;

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nekowite-keys-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Write a passwordless key file at `path` with mode `0600` (unix; the platform
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
    assert_eq!(
        a, b,
        "re-reading an existing key file must return the same bytes"
    );
    assert_eq!(a.len(), 32, "master key must be 32 bytes");
    let perm = fs::metadata(&p).unwrap().permissions().mode();
    assert_eq!(perm & 0o777, 0o600, "master key file must be mode 0600");
    fs::remove_dir_all(&dir).unwrap();
}

/// A missing `master.key` is a first run ONLY when nothing is beside it.
///
/// The crash state: `reencrypt_vault` renamed `master.key` to `master.key.old`
/// (step 3) and died before promoting `master.key.new` (step 4). The key that
/// opens the snapshot — for a password-protected vault, the salt and verifier
/// the password is derived against — is the backup, and the snapshot is still
/// the one that backup matches (step 5 never ran).
///
/// Reading the key file used to answer this state by CREATING a passwordless
/// `master.key`, which turned "the key file is missing" into "this vault has no
/// password": `password_candidates` then returned "no master password is set"
/// before it ever looked at the backup, and the vault was unopenable by every
/// path (load-time recovery skips a password-protected backup by design, so
/// unlock was the only one left). The forged file also shadowed the backup for
/// every later reader, so the state could not be recovered from.
///
/// Cheap on purpose (no Stronghold): it pins the file-level contract the heavy
/// unlock test in `recovery_test.rs` then drives end to end.
#[test]
fn a_missing_key_file_beside_a_backup_is_not_a_fresh_vault() {
    let dir = temp_dir("missing-key-crash");
    let key_path = dir.join("master.key");
    let password = "correct horse battery staple";
    let salt = [42u8; 32];
    let verifier = verifier_of(&derive_master_key(password, &salt).unwrap());
    fs::write(
        sibling_suffixed(&key_path, "old"),
        encode_keyfile_password(&salt, &verifier),
    )
    .unwrap();

    // Whatever the read answers, it must not leave a passwordless `master.key`
    // where the backup is the key that opens the vault.
    let _ = read_vault_key_state(&key_path);
    assert!(
        !key_path.exists(),
        "a missing master.key beside a backup is the interrupted-swap state, not a fresh vault"
    );

    // And the unlock path must reach the backup's password rather than answering
    // that the vault has none.
    assert_eq!(
        password_candidates(&key_path).unwrap(),
        vec![(salt, verifier)],
        "the password of the key file in master.key.old is the one that opens this vault"
    );
    assert!(
        !key_path.exists(),
        "building the candidate list must not write a key file either"
    );

    // The contrast that must survive: with no backup beside it, a missing key
    // file IS the first run (`master_key_created_and_reused`), and a key file
    // that really is passwordless still has nothing to unlock.
    let fresh = dir.join("fresh").join("master.key");
    assert!(
        read_vault_key_state(&fresh).is_ok(),
        "a fresh install must still get a key file"
    );
    assert!(fresh.exists(), "a fresh install must still write it");
    fs::write(&key_path, encode_keyfile_passwordless(&[18u8; 32])).unwrap();
    assert_eq!(
        password_candidates(&key_path).unwrap_err(),
        "no master password is set",
        "a genuinely passwordless master.key has nothing to unlock, whatever the backups hold"
    );

    let _ = fs::remove_dir_all(&dir);
}

/// In the same state, what the vault OPENS with has to be the key that is still
/// there — the load path is the only one that can open a vault whose
/// `master.key` is gone, so this answer decides whether the user gets the vault
/// back at all.
///
/// A passwordless backup is the vault's key and opens the snapshot without a
/// password, so it is the answer. It is preferred over a password-protected
/// backup because that one cannot be used from here at all — `open_snapshot`
/// skips it by design — and because reporting `Locked` over a vault that opens
/// by itself would send the user looking for a password that is not the point.
#[test]
fn a_missing_key_file_reads_as_the_backup_that_still_opens_the_vault() {
    let dir = temp_dir("missing-key-opens-from-backup");
    let key_path = dir.join("master.key");
    let live_key = [5u8; 32];
    fs::write(
        sibling_suffixed(&key_path, "old"),
        encode_keyfile_password(&[7u8; 32], &[8u8; 32]),
    )
    .unwrap();
    fs::write(
        sibling_suffixed(&key_path, "old-1700000000000"),
        encode_keyfile_passwordless(&live_key),
    )
    .unwrap();

    assert_eq!(
        read_vault_key_state(&key_path).unwrap(),
        VaultKeyState::Auto(live_key),
        "the passwordless backup is the key the load path has to open with"
    );
    assert!(
        !key_path.exists(),
        "reading the state must not create the missing key file"
    );

    let _ = fs::remove_dir_all(&dir);
}

/// With every readable backup password-protected there is no key the load path
/// may use, and the vault is locked: the state has to say so — it is what makes
/// the load path report the vault as locked and send the user to `unlock_vault`
/// with the password that derives the key, instead of trying a key it does not
/// have (or inventing one).
#[test]
fn a_missing_key_file_reads_as_locked_when_only_the_password_can_open_it() {
    let dir = temp_dir("missing-key-locked-backup");
    let key_path = dir.join("master.key");
    let salt = [11u8; 32];
    let verifier = [12u8; 32];
    fs::write(
        sibling_suffixed(&key_path, "old"),
        encode_keyfile_password(&salt, &verifier),
    )
    .unwrap();

    assert_eq!(
        read_vault_key_state(&key_path).unwrap(),
        VaultKeyState::Locked { salt, verifier },
        "a password-protected backup is the vault being locked, not a fresh vault"
    );
    assert!(
        !key_path.exists(),
        "no key file may be forged over this state"
    );

    let _ = fs::remove_dir_all(&dir);
}

/// And a backup that cannot be read is neither: there is nothing to open with
/// and nothing that may check a password, so the read reports the damage rather
/// than writing a fresh key over whatever is still there to be restored.
#[test]
fn unreadable_backups_do_not_become_a_fresh_vault() {
    let dir = temp_dir("missing-key-damaged-backup");
    let key_path = dir.join("master.key");
    let truncated = vec![0u8; 16];
    fs::write(sibling_suffixed(&key_path, "old"), &truncated).unwrap();

    assert!(
        read_vault_key_state(&key_path).is_err(),
        "a damaged backup is an error, not a reason to invent key material"
    );
    assert!(!key_path.exists());
    assert_eq!(
        fs::read(sibling_suffixed(&key_path, "old")).unwrap(),
        truncated,
        "the damaged backup must be left byte-for-byte intact to be restored"
    );

    let _ = fs::remove_dir_all(&dir);
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
        err.contains("could not read the master key file") && err.contains("master.key"),
        "expected read error to propagate with the file named, got: {err}"
    );
    assert!(
        p.is_dir(),
        "non-NotFound error must not be treated as missing"
    );
    fs::remove_dir_all(&dir).unwrap();
}

/// A master key file that is not a valid versioned key file must be rejected,
/// not silently regenerated (a corrupt/partial key must never be overwritten).
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

/// [C] The master password MUST NOT be reduced to a single round of SHA-256.
/// `derive_master_key` uses Argon2id, so its output differs from `SHA-256(pw)`.
#[test]
fn derived_key_is_not_plain_sha256() {
    use sha2::{Digest, Sha256};
    let password = "hunter2";
    let salt = [7u8; 32];
    let derived = derive_master_key(password, &salt).unwrap();
    let sha = Sha256::digest(password.as_bytes());
    assert_ne!(
        derived.as_slice(),
        sha.as_slice(),
        "KDF output must not be plain SHA-256 of the password"
    );
    // Argon2id is keyed by the salt: the same password + different salt yields a
    // different key, and re-deriving with the same salt is stable.
    let salt2 = [8u8; 32];
    let derived2 = derive_master_key(password, &salt2).unwrap();
    assert_ne!(
        derived, derived2,
        "different salt must give a different key"
    );
    assert_eq!(
        derive_master_key(password, &salt).unwrap(),
        derived,
        "same password + salt is deterministic"
    );
}

/// [C] The on-disk master key file for a password-protected vault is a salt +
/// one-way verifier, NEVER the raw decryption key. Reading the file alone (or
/// `ensure_keyfile`) must not yield a usable Stronghold key.
#[test]
fn disk_keyfile_cannot_unlock_without_password() {
    let dir = temp_dir("kdf-disk");
    let key_path = dir.join("master.key");
    let password = "correct horse battery staple";
    let salt = [42u8; 32];
    let master = derive_master_key(password, &salt).unwrap();
    let verifier = verifier_of(&master);

    let bytes = encode_keyfile_password(&salt, &verifier);
    fs::write(&key_path, &bytes).unwrap();

    // The file decodes to a Locked state, never a raw Auto key.
    match read_vault_key_state(&key_path).unwrap() {
        VaultKeyState::Locked {
            salt: s,
            verifier: v,
        } => {
            assert_eq!(s, salt);
            assert_eq!(v, verifier);
        }
        VaultKeyState::Auto(k) => panic!("keyfile leaked a raw key: {k:?}"),
    }

    // The file content cannot be the raw key, and the verifier is not the key.
    assert_ne!(
        bytes.as_slice(),
        master.as_slice(),
        "keyfile must not contain the raw key"
    );
    assert_ne!(
        verifier.as_slice(),
        master.as_slice(),
        "verifier must differ from the key"
    );
    // `ensure_keyfile` refuses to hand back a raw key from a locked file.
    assert!(ensure_keyfile(&key_path).is_err());

    fs::remove_dir_all(&dir).unwrap();
}

/// [B] The IPC-facing key reader discloses only a fixed masked indicator, never
/// the real API key.
#[test]
fn ai_key_presence_never_discloses_the_key() {
    assert_eq!(ai_key_presence(None), None, "no key stays None");
    let disclosed = ai_key_presence(Some("sk-super-secret".to_string())).unwrap();
    assert_eq!(
        disclosed, AI_KEY_MASKED,
        "presence reports the masked indicator"
    );
    assert_ne!(
        disclosed, "sk-super-secret",
        "the real key must not be returned"
    );
    // The masked indicator is a fixed literal, not derived from the secret.
    assert_eq!(AI_KEY_MASKED, "••••••••");
}

/// Provider keys have no maximum length. A JWT-shaped or `sk-proj-` credential
/// is several hundred characters and must not be rejected at the IPC gate.
#[test]
fn stored_api_key_has_no_maximum_length() {
    assert!(validate_stored_api_key(AI_KEY_MASKED).is_err());
    assert!(validate_stored_api_key("sk-short").is_ok());
    let long = format!("sk-proj-{}", "a".repeat(4096));
    assert!(
        validate_stored_api_key(&long).is_ok(),
        "a {}-byte key must be accepted",
        long.len()
    );
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
    write_key_file(&key_path, &encode_keyfile_passwordless(&old_key));

    let records = vec![(b"openai".to_vec(), b"sk-old".to_vec())];
    reencrypt_vault(
        &DiskKeyFiles,
        &snapshot,
        &key_path,
        &new_key,
        &encode_keyfile_passwordless(&new_key),
        CLIENT,
        &records,
    )
    .unwrap();

    // New master.key on disk is a passwordless keyfile holding the new key.
    match read_vault_key_state(&key_path).unwrap() {
        VaultKeyState::Auto(k) => assert_eq!(k, new_key),
        VaultKeyState::Locked { .. } => panic!("expected passwordless keyfile"),
    }

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
    write_key_file(&key_path, &encode_keyfile_passwordless(&new_key));
    write_key_file(
        &dir.join("master.key.old"),
        &encode_keyfile_passwordless(&old_key),
    );

    // The new key alone would fail; the `master.key.old` fallback recovers.
    let stronghold = open_snapshot(&DiskKeyFiles, &snapshot, &key_path, new_key.to_vec()).unwrap();
    let client = stronghold.inner().load_client(CLIENT).unwrap();
    let got = client
        .store()
        .get(b"openai".as_slice())
        .unwrap()
        .map(|b| String::from_utf8_lossy(&b).to_string());
    assert_eq!(got.as_deref(), Some("sk-old"));

    // Without the backup the same open must fail (primary error surfaced).
    fs::remove_file(dir.join("master.key.old")).unwrap();
    assert!(open_snapshot(&DiskKeyFiles, &snapshot, &key_path, new_key.to_vec()).is_err());

    fs::remove_dir_all(&dir).unwrap();
}

/// `decode_keyfile` round-trips both key file modes and rejects malformed
/// inputs.
#[test]
fn keyfile_roundtrips_and_rejects_garbage() {
    let key = [5u8; 32];
    let auto = decode_keyfile(&encode_keyfile_passwordless(&key)).unwrap();
    assert_eq!(auto, VaultKeyState::Auto(key));

    let salt = [6u8; 32];
    let verifier = [7u8; 32];
    let locked = decode_keyfile(&encode_keyfile_password(&salt, &verifier)).unwrap();
    assert_eq!(locked, VaultKeyState::Locked { salt, verifier });

    assert!(decode_keyfile(&[]).is_err());
    assert!(decode_keyfile(&[0u8; 16]).is_err());
    assert!(decode_keyfile(&[1u8, 99u8]).is_err());
    // Wrong length for the declared mode.
    assert!(decode_keyfile(&encode_keyfile_passwordless(&key)[..33]).is_err());
}

/// A key file written before the versioned envelope existed holds the bare
/// 32-byte key. Rejecting it as a bad length locked a working vault out of its
/// own key — the user saw "master key file has invalid length 32 (expected 34
/// or 66)" when saving an AI key, and no AI key could ever be stored again.
#[test]
fn a_legacy_bare_key_file_is_accepted_and_upgraded_in_place() {
    let dir = temp_dir("legacy-key");
    let path = dir.join("master.key");
    let key: Vec<u8> = (0u8..32).collect();
    fs::write(&path, &key).unwrap();

    let state = read_vault_key_state(&path).expect("a legacy key must still open the vault");
    assert_eq!(
        state,
        VaultKeyState::Auto(key.clone().try_into().unwrap()),
        "the bare bytes ARE the key, carried over verbatim"
    );

    let upgraded = fs::read(&path).unwrap();
    assert_eq!(upgraded.len(), 34, "rewritten in the versioned envelope");
    assert_eq!(
        decode_keyfile(&upgraded).unwrap(),
        state,
        "the upgrade must not change the key"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn upgrading_a_legacy_key_is_idempotent() {
    let dir = temp_dir("legacy-key-twice");
    let path = dir.join("master.key");
    let key: Vec<u8> = (0u8..32).collect();
    fs::write(&path, &key).unwrap();

    let first = read_vault_key_state(&path).unwrap();
    let second = read_vault_key_state(&path).unwrap();
    assert_eq!(first, second);
    assert_eq!(fs::read(&path).unwrap().len(), 34);
    let _ = fs::remove_dir_all(&dir);
}

/// A *versioned* file cut short to 32 bytes is NOT a legacy key.
///
/// `[01, 01, salt[0..30]]` has the same length as a bare key, and the upgrade
/// path would rewrite the file — destroying the salt and verifier it still
/// held and leaving the snapshot undecryptable for good (`reencrypt_vault`
/// deletes `master.key.old`, so the load-time fallback cannot rescue it).
/// Rejecting keeps the old behaviour: a clear error, file untouched.
#[test]
fn a_truncated_versioned_keyfile_is_rejected_and_left_intact() {
    let dir = temp_dir("legacy-truncated");
    let key = [9u8; 32];
    let cases: [(&str, Vec<u8>); 2] = [
        (
            "password (66 -> 32)",
            encode_keyfile_password(&[6u8; 32], &[7u8; 32])[..32].to_vec(),
        ),
        (
            "passwordless (34 -> 32)",
            encode_keyfile_passwordless(&key)[..32].to_vec(),
        ),
    ];
    for (label, truncated) in cases {
        assert_eq!(truncated.len(), 32, "{label} should be 32 bytes");
        let path = dir.join(format!(
            "{}.key",
            label.replace([' ', '(', ')', '-', '>'], "_")
        ));
        fs::write(&path, &truncated).unwrap();

        let read = read_vault_key_state(&path);
        assert!(
            read.is_err(),
            "{label}: a truncated versioned file must be refused, not adopted"
        );
        assert_eq!(
            fs::read(&path).unwrap(),
            truncated,
            "{label}: the refused file must be left byte-for-byte intact"
        );
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn only_the_bare_key_length_is_treated_as_legacy() {
    // Everything else that is not 34/66 is still a corrupt file: accepting it
    // would mean inventing key material.
    let dir = temp_dir("legacy-key-other");
    for len in [0usize, 16, 31, 33, 65, 67] {
        let path = dir.join(format!("master-{len}.key"));
        fs::write(&path, vec![0u8; len]).unwrap();
        assert!(
            read_vault_key_state(&path).is_err(),
            "a {len}-byte key file must still be rejected"
        );
    }
    let _ = fs::remove_dir_all(&dir);
}
