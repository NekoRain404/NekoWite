//! Crash-safe recovery of the encrypted stronghold vault.
//!
//! These are the pure, path-level functions behind a master-password change
//! and the load-time fallback on the `master.key.old` backup. They run without
//! an `AppHandle`, so the load-time recovery path is testable directly (see
//! `tests/keys_test.rs`). The key-file format and KDF live behind
//! [`KeyFileIo`], implemented by the storage layer and handed in by the caller;
//! this module owns the *recovery* sequence, not the files it moves.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri_plugin_stronghold::stronghold::Stronghold;

use super::key_files::{sibling_suffixed, stronghold_tmp_path, KeyFileIo, VaultKeyState};
use crate::errors::fs_error;

/// Suffix of the canonical backup slot: `master.key.old`.
const BACKUP_SUFFIX: &str = "old";

/// Prefix of the backups a swap ROTATED out of that slot: `master.key.old-<ms>`.
const ROTATED_BACKUP_PREFIX: &str = "old-";

/// Milliseconds since the epoch, used to name a rotated backup.
fn rotation_stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default()
}

/// Every key file that may open the snapshot beside `key_path`, in the order
/// recovery tries them: the canonical `master.key.old` slot first, then the
/// backups a previous swap rotated out of it, newest first.
///
/// A swap that finds the slot occupied must move that file aside instead of
/// deleting it — it can be the only key that decrypts the live snapshot (a
/// crash between the two renames of an earlier swap leaves exactly that state,
/// with `master.key` holding a key that opens nothing). Preserving it is only
/// worth anything if recovery looks at the rotated name, which is what this
/// list is for. The staging file (`master.key.new`) is deliberately NOT a
/// candidate: it carries the key of a swap that has not been committed, which
/// cannot open the snapshot that is still live.
pub fn backup_key_paths(key_path: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let canonical = sibling_suffixed(key_path, BACKUP_SUFFIX);
    if canonical.exists() {
        out.push(canonical);
    }
    let (Some(parent), Some(name)) = (
        key_path.parent(),
        key_path.file_name().and_then(|n| n.to_str()),
    ) else {
        return out;
    };
    let prefix = format!("{name}.{ROTATED_BACKUP_PREFIX}");
    let Ok(entries) = std::fs::read_dir(parent) else {
        // An unreadable directory is not "no backups": the canonical slot above
        // was still offered, and the caller reports the primary error anyway.
        return out;
    };
    let mut rotated: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&prefix))
        })
        .collect();
    // Stamps are fixed-width milliseconds, so name order is age order.
    rotated.sort();
    rotated.reverse();
    out.extend(rotated);
    out
}

/// Read an on-disk master key that is directly usable as a Stronghold key. Only
/// valid for a **passwordless** key file; a password-protected file returns an
/// error (its key must be derived from the password). Used by the load-time
/// recovery in [`open_snapshot`] against the `master.key.old` backup.
///
/// The file is read through `io` rather than a concrete key store: what a key
/// file holds is the format's business, while which backups recovery tries and
/// in what order is this module's.
fn read_unlockable_keyfile(io: &dyn KeyFileIo, path: &Path) -> Result<Vec<u8>, String> {
    match io.read_key_state(path)? {
        VaultKeyState::Auto(key) => Ok(key.to_vec()),
        VaultKeyState::Locked { .. } => Err("backup master key is password-protected".to_string()),
    }
}

/// Open the snapshot at `snapshot_path` with `master_key`. If that fails, retry
/// with each key backup beside `key_path` (see [`backup_key_paths`]) before
/// giving up.
///
/// The backup is the recovery path for a crash mid-`set_master_password`: the
/// two-phase swap in [`reencrypt_vault`] can be interrupted after the key files
/// were renamed but before the snapshot was swapped, leaving the OLD key in
/// `master.key.old` (with `master.key` holding the new, not-yet-applicable key,
/// or missing entirely) beside a snapshot that still decrypts with the old key.
/// A failed open never writes to disk, so the retry cannot make things worse.
///
/// Pure and `AppHandle`-free so the recovery path is testable in
/// `tests/keys_test.rs`/`tests/recovery_test.rs`; the backup keys are read
/// through the caller's `io` ([`KeyFileIo`]), so a test can drive the retry
/// without a real key store.
pub fn open_snapshot(
    io: &dyn KeyFileIo,
    snapshot_path: &Path,
    key_path: &Path,
    master_key: Vec<u8>,
) -> Result<Stronghold, String> {
    match Stronghold::new(snapshot_path, master_key) {
        Ok(stronghold) => Ok(stronghold),
        Err(primary_err) => {
            for backup in backup_key_paths(key_path) {
                // A password-protected backup cannot be used from here at all
                // (its key has to be derived from the password), so it is
                // skipped rather than ending the retry — a later candidate may
                // still be the passwordless key that opens this snapshot.
                let Ok(backup_key) = read_unlockable_keyfile(io, &backup) else {
                    continue;
                };
                if let Ok(stronghold) = Stronghold::new(snapshot_path, backup_key) {
                    return Ok(stronghold);
                }
            }
            // Surface the primary error: the backups are missing, also wrong or
            // password-protected, and their own errors would only repeat the
            // same decryption failure.
            Err(primary_err.to_string())
        }
    }
}

/// What [`displace_current_key`] moved out of the way, so a failed swap can put
/// back exactly that and nothing else.
#[derive(Default)]
struct DisplacedKey {
    /// The pre-swap `master.key` now sits in the backup slot.
    moved_current: bool,
    /// A pre-existing backup that was rotated out of the slot to make room.
    rotated: Option<PathBuf>,
}

/// The name a rotated backup can take: `master.key.old-<ms>`, bumped a
/// millisecond at a time until it is free. Bumping replaces the stamp instead
/// of stacking a second one, so the name keeps the fixed-width shape
/// [`backup_key_paths`] sorts by age.
fn free_rotation_path(key_path: &Path) -> PathBuf {
    let mut stamp = rotation_stamp();
    loop {
        let candidate = sibling_suffixed(key_path, &format!("{ROTATED_BACKUP_PREFIX}{stamp}"));
        if !candidate.exists() {
            return candidate;
        }
        stamp = stamp.saturating_add(1);
    }
}

/// Move the current `master.key` into the `.old` recovery slot, rotating any
/// backup already in that slot aside rather than deleting it.
///
/// The file in the slot can be the ONLY key that decrypts the live snapshot:
/// a swap interrupted between steps 4 and 5 of an earlier run leaves
/// `master.key` holding a key that opens nothing and the real one in `.old`.
/// Deleting it before this swap has committed would therefore lose the vault
/// for good — there is no other copy of that key anywhere. Rotating keeps it
/// reachable ([`backup_key_paths`] is what [`open_snapshot`] uses to find it).
///
/// A missing `master.key` is left alone entirely: that is the same crash state
/// seen from the other side, and there the slot must keep what it holds.
fn displace_current_key(key_path: &Path) -> Result<DisplacedKey, String> {
    let backup = sibling_suffixed(key_path, BACKUP_SUFFIX);
    if !key_path.exists() {
        return Ok(DisplacedKey::default());
    }
    let rotated = if backup.exists() {
        let target = free_rotation_path(key_path);
        std::fs::rename(&backup, &target)
            .map_err(|e| fs_error("move the existing master key backup aside", &backup, e))?;
        Some(target)
    } else {
        None
    };
    if let Err(e) = std::fs::rename(key_path, &backup) {
        // Nothing has been installed under either name yet, so the disk has to
        // be left exactly as it was: the rotated backup goes back to the slot
        // the load-time recovery reads.
        if let Some(rotated) = rotated.as_deref() {
            let _ = std::fs::rename(rotated, &backup);
        }
        return Err(fs_error("move the old master key aside", key_path, e));
    }
    Ok(DisplacedKey {
        moved_current: true,
        rotated,
    })
}

/// Undo [`displace_current_key`]: the pre-swap key returns to `key_path` (the
/// snapshot it opens is still the live one) and the backup it displaced returns
/// to the slot recovery reads.
fn restore_displaced_key(key_path: &Path, displaced: &DisplacedKey) {
    let backup = sibling_suffixed(key_path, BACKUP_SUFFIX);
    if displaced.moved_current {
        let _ = std::fs::rename(&backup, key_path);
    }
    if let Some(rotated) = displaced.rotated.as_deref() {
        let _ = std::fs::rename(rotated, &backup);
    }
}

/// Re-encrypt the snapshot at `snapshot_path` with `new_key`, migrating
/// `records` over, and swap the new master key file in at `key_path`. `keyfile`
/// is the serialized key blob to persist (`master.key` = salt+verifier for a
/// password-protected vault, or a passwordless raw key). `client_id` is the
/// snapshot's single client slot: the caller passes the one its `records` were
/// read from, so the rebuilt snapshot keeps that slot without this module
/// knowing anything about where a vault stores its clients. Pure path-level
/// function, testable without an `AppHandle`, and the only thing it asks of
/// storage is the files it writes and flushes through `io` ([`KeyFileIo`]).
///
/// Crash-safe two-phase swap. Every step leaves the on-disk key files and the
/// snapshot mutually recoverable, so a crash at ANY point loses no stored key
/// (load-time recovery is [`open_snapshot`]'s backup search):
///
/// 1. Write + fsync the new key blob to the `master.key.new` staging file. The
///    old `master.key` and old snapshot are untouched, so the vault stays
///    readable with the old key.
/// 2. Build the new-key snapshot at the temp sibling (clearing any stale temp
///    from a previously interrupted run first), `save()` it, fsync it, and
///    tighten its permissions. Still nothing swapped, so the old pair remains
///    consistent — and everything that can still fail happens BEFORE the swap,
///    so an error can never describe a vault that is already re-encrypted.
/// 3. Move `master.key` -> `master.key.old`, rotating an existing backup aside
///    instead of deleting it (see [`displace_current_key`]). A crash here
///    leaves `master.key` missing, but every key that was on disk is still
///    there and the load-time search finds them.
/// 4. Rename `master.key.new` -> `master.key`. A crash here leaves the new key
///    in place beside the OLD snapshot, which still decrypts with a backup —
///    exactly the state the load-time fallback recovers from.
/// 5. Atomically swap the temp snapshot over the real one — a single
///    `fs::rename` replaces the destination in place on the same filesystem,
///    so there is no `remove_file` step that could delete the only vault copy.
///    From here the new key decrypts the live snapshot, and no fallible step
///    remains.
/// 6. Delete `master.key.old` and the rotated backup, which are stale by
///    definition now.
///
/// If a rename fails mid-sequence, the key files are moved back so the disk is
/// left consistent with the (still old) snapshot.
pub fn reencrypt_vault(
    io: &dyn KeyFileIo,
    snapshot_path: &Path,
    key_path: &Path,
    new_key: &[u8],
    keyfile: &[u8],
    client_id: [u8; 32],
    records: &[(Vec<u8>, Vec<u8>)],
) -> Result<(), String> {
    let new_key_staging = sibling_suffixed(key_path, "new");
    let old_key_backup = sibling_suffixed(key_path, BACKUP_SUFFIX);
    let tmp_snapshot = stronghold_tmp_path(snapshot_path);

    // 1. Durable new key material at the staging path. Clear any stale staging
    //    file from a previously interrupted run first.
    let _ = std::fs::remove_file(&new_key_staging);
    io.write_key_file(&new_key_staging, keyfile)?;

    // 2. Rebuild under the new key at a temp path. Clear any stale temp file
    //    first, or `Stronghold::new` would try to load it with the new key and
    //    fail.
    let _ = std::fs::remove_file(&tmp_snapshot);
    let new_stronghold =
        Stronghold::new(tmp_snapshot.clone(), new_key.to_vec()).map_err(|e| e.to_string())?;
    let client = new_stronghold
        .inner()
        .create_client(client_id)
        .map_err(|e| e.to_string())?;
    for (k, v) in records {
        client
            .store()
            .insert(k.clone(), v.clone(), None)
            .map_err(|e| e.to_string())?;
    }
    new_stronghold.save().map_err(|e| e.to_string())?;
    io.fsync_file(&tmp_snapshot)?;
    // Tighten the STAGED file, before the swap rather than after it. `rename`
    // does not change the mode, so this is what gives the live snapshot its
    // permissions — and it keeps the failure ahead of the commit point, where
    // an error still means "nothing happened". Tightening after the swap could
    // only report a failed password change over a vault that is already
    // re-encrypted, and would leave the in-memory handle dropped by the caller
    // for no reason. (It also means a temp snapshot left behind by a later
    // failure is not world-readable.)
    io.tighten_perms(&tmp_snapshot)?;

    // 3. Move the old key aside BEFORE the new key takes its name, so step 4
    //    does not have to rename over an existing file.
    let displaced = displace_current_key(key_path)?;

    // 4. Promote the staged key. If this fails, put the key files back so the
    //    disk stays consistent with the (still old) snapshot.
    if let Err(e) = std::fs::rename(&new_key_staging, key_path) {
        restore_displaced_key(key_path, &displaced);
        return Err(fs_error("replace the master key file", key_path, e));
    }

    // 5. Atomic snapshot swap; restore the key files if it fails.
    if let Err(e) = std::fs::rename(&tmp_snapshot, snapshot_path) {
        restore_displaced_key(key_path, &displaced);
        return Err(fs_error("replace the vault snapshot", snapshot_path, e));
    }

    // 6. Every backup is stale once the snapshot decrypts with `master.key`.
    let _ = std::fs::remove_file(&old_key_backup);
    if let Some(rotated) = displaced.rotated.as_deref() {
        let _ = std::fs::remove_file(rotated);
    }
    Ok(())
}
