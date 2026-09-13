//! Crash-safe recovery of the encrypted stronghold vault.
//!
//! These are the pure, path-level functions behind a master-password change
//! and the load-time fallback on the `master.key.old` backup. They run without
//! an `AppHandle`, so the load-time recovery path is testable directly (see
//! `tests/keys_test.rs`). The key-file format and KDF live in
//! [`crate::storage::key_store`]; this module owns the *recovery* sequence.

use std::path::Path;

use tauri_plugin_stronghold::stronghold::Stronghold;

use crate::errors::fs_error;
use crate::storage::key_store::{
    fsync_file, read_vault_key_state, sibling_suffixed, stronghold_tmp_path,
    tighten_snapshot_perms, write_key_file_at, VaultKeyState, VAULT_CLIENT_ID,
};

/// Read an on-disk master key that is directly usable as a Stronghold key. Only
/// valid for a **passwordless** key file; a password-protected file returns an
/// error (its key must be derived from the password). Used by the load-time
/// recovery in [`open_snapshot`] against the `master.key.old` backup.
fn read_unlockable_keyfile(path: &Path) -> Result<Vec<u8>, String> {
    match read_vault_key_state(path)? {
        VaultKeyState::Auto(key) => Ok(key.to_vec()),
        VaultKeyState::Locked { .. } => Err("backup master key is password-protected".to_string()),
    }
}

/// Open the snapshot at `snapshot_path` with `master_key`. If that fails and a
/// `master.key.old` backup exists, retry with it before giving up.
///
/// The backup is the recovery path for a crash mid-`set_master_password`: the
/// two-phase swap in [`reencrypt_vault`] can be interrupted after the key files
/// were renamed but before the snapshot was swapped, leaving the OLD key in
/// `master.key.old` (with `master.key` holding the new, not-yet-applicable key,
/// or missing entirely) beside a snapshot that still decrypts with the old key.
/// A failed open never writes to disk, so the retry cannot make things worse.
///
/// Pure and `AppHandle`-free so the recovery path is testable in
/// `tests/keys_test.rs`.
pub fn open_snapshot(
    snapshot_path: &Path,
    key_path: &Path,
    master_key: Vec<u8>,
) -> Result<Stronghold, String> {
    match Stronghold::new(snapshot_path, master_key) {
        Ok(stronghold) => Ok(stronghold),
        Err(primary_err) => {
            let backup = read_unlockable_keyfile(&sibling_suffixed(key_path, "old")).and_then(
                |backup_key| Stronghold::new(snapshot_path, backup_key).map_err(|e| e.to_string()),
            );
            match backup {
                Ok(stronghold) => Ok(stronghold),
                // Surface the primary error: the backup is missing or also
                // wrong (or password-protected), and its own error would only
                // repeat the same decryption failure.
                Err(_) => Err(primary_err.to_string()),
            }
        }
    }
}

/// Re-encrypt the snapshot at `snapshot_path` with `new_key`, migrating
/// `records` over, and swap the new master key file in at `key_path`. `keyfile`
/// is the serialized key blob to persist (`master.key` = salt+verifier for a
/// password-protected vault, or a passwordless raw key). Pure path-level
/// function, testable without an `AppHandle`.
///
/// Crash-safe two-phase swap. Every step leaves the on-disk key files and the
/// snapshot mutually recoverable, so a crash at ANY point loses no stored key
/// (load-time recovery is [`open_snapshot`]'s `master.key.old` retry):
///
/// 1. Write + fsync the new key blob to the `master.key.new` staging file. The
///    old `master.key` and old snapshot are untouched, so the vault stays
///    readable with the old key.
/// 2. Build the new-key snapshot at the temp sibling (clearing any stale temp
///    from a previously interrupted run first), `save()` it, and fsync it.
///    Still nothing swapped, so the old pair remains consistent.
/// 3. Rename `master.key` -> `master.key.old`. A crash here leaves
///    `master.key` missing, but the old key survives in the backup and still
///    decrypts the snapshot.
/// 4. Rename `master.key.new` -> `master.key`. A crash here leaves the new key
///    in place beside the OLD snapshot, which still decrypts with
///    `master.key.old` — exactly the state the load-time fallback recovers
///    from.
/// 5. Atomically swap the temp snapshot over the real one — a single
///    `fs::rename` replaces the destination in place on the same filesystem,
///    so there is no `remove_file` step that could delete the only vault copy.
///    From here the new key decrypts the live snapshot.
/// 6. Delete `master.key.old`, which is stale by definition now.
///
/// If a rename fails mid-sequence, the old key backup is moved back first so
/// the disk is left consistent with the old snapshot.
pub fn reencrypt_vault(
    snapshot_path: &Path,
    key_path: &Path,
    new_key: &[u8],
    keyfile: &[u8],
    records: &[(Vec<u8>, Vec<u8>)],
) -> Result<(), String> {
    let new_key_staging = sibling_suffixed(key_path, "new");
    let old_key_backup = sibling_suffixed(key_path, "old");
    let tmp_snapshot = stronghold_tmp_path(snapshot_path);

    // 1. Durable new key material at the staging path. Clear any stale staging
    //    file from a previously interrupted run first.
    let _ = std::fs::remove_file(&new_key_staging);
    write_key_file_at(&new_key_staging, keyfile)?;

    // 2. Rebuild under the new key at a temp path. Clear any stale temp file
    //    first, or `Stronghold::new` would try to load it with the new key and
    //    fail.
    let _ = std::fs::remove_file(&tmp_snapshot);
    let new_stronghold =
        Stronghold::new(tmp_snapshot.clone(), new_key.to_vec()).map_err(|e| e.to_string())?;
    let client = new_stronghold
        .inner()
        .create_client(VAULT_CLIENT_ID)
        .map_err(|e| e.to_string())?;
    for (k, v) in records {
        client
            .store()
            .insert(k.clone(), v.clone(), None)
            .map_err(|e| e.to_string())?;
    }
    new_stronghold.save().map_err(|e| e.to_string())?;
    fsync_file(&tmp_snapshot)?;

    // 3. Move the old key aside BEFORE the new key takes its name, so step 4
    //    does not have to rename over an existing file.
    let _ = std::fs::remove_file(&old_key_backup);
    std::fs::rename(key_path, &old_key_backup)
        .map_err(|e| fs_error("move the old master key aside", key_path, e))?;

    // 4. Promote the staged key. If this fails, put the old key back so the
    //    disk stays consistent with the (still old) snapshot.
    if let Err(e) = std::fs::rename(&new_key_staging, key_path) {
        let _ = std::fs::rename(&old_key_backup, key_path);
        return Err(fs_error("replace the master key file", key_path, e));
    }

    // 5. Atomic snapshot swap; restore the old key if it fails.
    if let Err(e) = std::fs::rename(&tmp_snapshot, snapshot_path) {
        let _ = std::fs::rename(&old_key_backup, key_path);
        return Err(fs_error("replace the vault snapshot", snapshot_path, e));
    }
    // The rename preserved the temp file's umask-derived perms; tighten them.
    tighten_snapshot_perms(snapshot_path)?;

    // 6. The backup is stale once the snapshot decrypts with `master.key`.
    let _ = std::fs::remove_file(&old_key_backup);
    Ok(())
}
