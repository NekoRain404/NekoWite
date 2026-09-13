//! Key commands: the IPC surface for storing/loading provider keys and
//! setting/unlocking a master password.
//!
//! These drive the key store and the crash-safe recovery module. Command names,
//! DTOs and error strings are unchanged from the pre-split layout.

use std::path::Path;

use tauri::Manager;
use tauri_plugin_stronghold::stronghold::Stronghold;

use crate::domain::recovery::{backup_key_paths, open_snapshot, reencrypt_vault};
use crate::state::KeyVault;
use crate::storage::key_file_io::DiskKeyFiles;
use crate::storage::key_store::{
    self, ai_key_presence, derive_master_key, encode_keyfile_password, load_ai_key_internal,
    read_vault_key_state, validate_password, validate_stored_api_key, verifier_of, VaultKeyState,
};

/// Store an API key for a provider in the stronghold vault. If the provider
/// already has a key, it is overwritten. The snapshot is committed after each
/// write so the key survives restarts.
#[tauri::command]
pub async fn store_ai_key(
    app: tauri::AppHandle,
    provider: String,
    key: String,
) -> Result<(), String> {
    // Never store the masked "a key is configured" indicator as a real key —
    // the settings UI shows it as a placeholder and must not persist it over a
    // previously-saved credential. Length is not capped: see
    // [`validate_stored_api_key`].
    validate_stored_api_key(&key)?;
    let provider_bytes = provider.into_bytes();
    let key_bytes = key.into_bytes();
    key_store::open_vault(
        &app,
        &mut key_store::init_with_default(&app),
        |stronghold| {
            let client = key_store::get_or_create_client(stronghold)?;
            client
                .store()
                .insert(provider_bytes.clone(), key_bytes.clone(), None)
                .map_err(|e| e.to_string())?;
            key_store::save_vault(stronghold)
        },
    )?;
    key_store::tighten_saved_snapshot(&app)?;
    Ok(())
}

/// Return whether an API key is configured for a provider, without disclosing
/// it. Serializes as `string | null` on the JS side (`Some` is the masked
/// indicator, never the real key) so the settings UI can signal "a key is set".
#[tauri::command]
pub async fn load_ai_key(
    app: tauri::AppHandle,
    provider: String,
) -> Result<Option<String>, String> {
    Ok(ai_key_presence(load_ai_key_internal(&app, &provider)?))
}

/// Set (or change) the master password, re-encrypting the snapshot under a
/// freshly derived Argon2id key and swapping in the new verifier key file.
///
/// The vault mutex is held across the ENTIRE operation — record collection,
/// the crash-safe two-phase swap, and the reload — so a concurrent
/// `store_ai_key` can neither read stale (old-key) records mid-swap nor save
/// old-key ciphertext into the swapped snapshot afterwards.
///
/// Changing an already-password-protected vault requires it to be unlocked
/// first (call `unlock_vault` with the current password), then this command
/// with the new one.
#[tauri::command]
pub async fn set_master_password(app: tauri::AppHandle, password: String) -> Result<(), String> {
    validate_password(&password)?;
    let snapshot_path = key_store::stronghold_path(&app)?;
    let key_path = key_store::master_key_path(&app)?;

    // Fresh per-vault salt: even two users picking the same password end up with
    // different derived keys, and the salt is stored (not secret) in the file.
    let mut salt = [0u8; 32];
    getrandom::getrandom(&mut salt).map_err(|e| e.to_string())?;
    let new_key = derive_master_key(&password, &salt)?;
    let verifier = verifier_of(&new_key);
    let keyfile = encode_keyfile_password(&salt, &verifier);

    let state = app.state::<KeyVault>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;

    // Open the vault under the held lock if it is not open yet (same lazy
    // init as `open_vault`). A password-protected vault must be unlocked first.
    if guard.is_none() {
        let (snapshot, key_file, key_state) = key_store::default_init(&app)?;
        let master_key = match key_state {
            VaultKeyState::Auto(key) => key,
            VaultKeyState::Locked { .. } => {
                return Err(
                    "vault is locked: call unlock_vault with the CURRENT password \
                     before changing it"
                        .into(),
                )
            }
        };
        *guard = Some(open_snapshot(
            &DiskKeyFiles,
            &snapshot,
            &key_file,
            master_key.to_vec(),
        )?);
    }

    // Collect existing records from the currently open (old-key) vault.
    // Errors reading the old vault are PROPAGATED (never swallowed into an
    // empty record set), so a failed read cannot silently wipe stored keys.
    let old = guard.as_ref().expect("vault was opened above");
    let client = key_store::get_or_create_client(old)?;
    let mut records: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    for k in client.store().keys().map_err(|e| e.to_string())? {
        let value = client
            .store()
            .get(&k)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "stored key record has no value".to_string())?;
        records.push((k, value));
    }

    // Two-phase swap of the key + snapshot on disk.
    if let Err(e) = reencrypt_vault(
        &DiskKeyFiles,
        &snapshot_path,
        &key_path,
        &new_key,
        &keyfile,
        key_store::VAULT_CLIENT_ID,
        &records,
    ) {
        // The disk may or may not have been swapped by the time the error
        // surfaced, so drop the in-memory handle: the next command re-opens
        // from disk (recovering via `master.key.old` if needed) instead of
        // saving stale old-key ciphertext over whatever is there now.
        *guard = None;
        return Err(e);
    }

    // Reload the managed vault from the swapped snapshot so the rest of this
    // process keeps working under the new key. On failure, drop the handle the
    // same way: keeping the old-key stronghold would let its next `save()`
    // corrupt the new snapshot.
    match Stronghold::new(snapshot_path.clone(), new_key.to_vec()) {
        Ok(stronghold) => *guard = Some(stronghold),
        Err(e) => {
            *guard = None;
            return Err(format!("vault re-encrypted but reload failed: {e}"));
        }
    }
    Ok(())
}

/// Unlock a password-protected vault. Derives the master key from `password`
/// and the stored salt, verifies it against the stored verifier, and opens the
/// stronghold so subsequent commands (`store_ai_key`, AI requests, …) can use
/// it. A no-op when the vault is already unlocked.
///
/// The password is tried against every key file that may open the snapshot, not
/// just `master.key` (see [`unlock_snapshot`]), so an interrupted password
/// change is still recoverable with the password that actually decrypts it.
#[tauri::command]
pub async fn unlock_vault(app: tauri::AppHandle, password: String) -> Result<(), String> {
    validate_password(&password)?;
    let state = app.state::<KeyVault>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    let snapshot_path = key_store::stronghold_path(&app)?;
    let key_path = key_store::master_key_path(&app)?;
    *guard = Some(unlock_snapshot(&snapshot_path, &key_path, &password)?);
    Ok(())
}

/// One key file a password may be derived against: the KDF salt it stores and
/// the one-way verifier that says whether the derived key is the right one.
pub type PasswordCandidate = ([u8; 32], [u8; 32]);

/// The candidates `password` may be derived against, in the order
/// [`unlock_snapshot`] tries them: the current `master.key` first, then every
/// backup beside it ([`backup_key_paths`]: the canonical `master.key.old` slot,
/// then the backups a swap rotated out of it, newest first).
///
/// Those are exactly the files the load-time recovery searches, and keeping the
/// two in step is what this function is for. `displace_current_key` rotates an
/// occupied backup aside instead of deleting it because it can be the only key
/// that opens the live snapshot; for a password-protected vault that key file
/// also carries the only password that still opens it. Recovery cannot use such
/// a file — a password-protected backup has no key to hand it, the key has to be
/// derived from the password, so `open_snapshot` skips it — which makes unlock
/// the ONLY path that can open that vault. It read `.old` alone, leaving the
/// rotated name unread.
///
/// Two files are deliberately not candidates: a passwordless backup, whose key
/// is usable as-is and so would let any string typed into the unlock dialog open
/// a vault whose `master.key` claims a password protects it; and
/// `master.key.new`, whose key belongs to a swap that has not been committed.
///
/// Only files that exist are read. `read_vault_key_state` CREATES a missing key
/// file (a fresh passwordless one), so probing a path that is not there forged a
/// `master.key.old` that opens nothing on every failed unlock — a backup the
/// recovery path would then try and a later swap would rotate into the user's
/// key-file history.
pub fn password_candidates(key_path: &Path) -> Result<Vec<PasswordCandidate>, String> {
    let VaultKeyState::Locked { salt, verifier } = read_vault_key_state(key_path)? else {
        return Err("no master password is set".into());
    };
    let mut candidates = vec![(salt, verifier)];
    for backup in backup_key_paths(key_path) {
        // `backup_key_paths` offers existing files, but a backup that vanished
        // between that listing and this read must not be resurrected as a
        // passwordless one (see the doc comment).
        if !backup.exists() {
            continue;
        }
        // Unreadable, malformed or passwordless backups are skipped: one bad
        // backup must not stop the unlock, and a passwordless one has no
        // password to check.
        if let Ok(VaultKeyState::Locked { salt, verifier }) = read_vault_key_state(&backup) {
            candidates.push((salt, verifier));
        }
    }
    Ok(candidates)
}

/// Unlock the vault at `snapshot_path` with `password`: derive the master key
/// from each candidate key file in turn and open the snapshot with the first
/// one whose verifier accepts the password.
///
/// A derived key that matches the verifier is not proof it opens the snapshot:
/// after an interrupted swap the live snapshot can still be encrypted under an
/// earlier password, so a rejected open falls through to the next candidate
/// instead of reporting the password as wrong.
///
/// Pure and `AppHandle`-free so the unlock sequence is testable directly (see
/// `tests/recovery_test.rs`), the same way [`open_snapshot`] is.
pub fn unlock_snapshot(
    snapshot_path: &Path,
    key_path: &Path,
    password: &str,
) -> Result<Stronghold, String> {
    let mut last_err = "incorrect master password".to_string();
    for (salt, verifier) in password_candidates(key_path)? {
        let derived = match derive_master_key(password, &salt) {
            Ok(k) => k,
            Err(e) => {
                last_err = e;
                continue;
            }
        };
        if verifier_of(&derived) != verifier {
            continue;
        }
        if let Ok(stronghold) = Stronghold::new(snapshot_path, derived.to_vec()) {
            return Ok(stronghold);
        }
        // The derived key matched the verifier but the snapshot refused it;
        // fall through and let the next candidate (a backup key file) try.
    }
    Err(last_err)
}
