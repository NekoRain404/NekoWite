//! Key commands: the IPC surface for storing/loading provider keys and
//! setting/unlocking a master password.
//!
//! These drive the key store and the crash-safe recovery module. Command names,
//! DTOs and error strings are unchanged from the pre-split layout.
//!
//! The two master-password commands answer [`VaultCommandError`] rather than a string. That type
//! lives in [`crate::commands::key_vault`] beside the read of the same state, because the arms it
//! names are the states that read reports: a window that is told *which* one it hit can point at
//! the control that fixes it, and a single "could not unlock" sends every one of them at the
//! password field — including the two whose problem is not the password at all.

use std::path::Path;

use tauri::Manager;
use tauri_plugin_stronghold::stronghold::Stronghold;

use crate::commands::key_vault::{key_file_error, unlock_error, VaultCommandError};
use crate::domain::path_policy::ipc_path;
use crate::domain::recovery::{backup_key_paths, open_snapshot, reencrypt_vault};
use crate::state::KeyVault;
use crate::storage::key_file_io::DiskKeyFiles;
use crate::storage::key_store::{
    self, ai_key_presence, derive_master_key, encode_keyfile_password, load_ai_key_internal,
    read_existing_vault_key_state, validate_password, validate_stored_api_key, verifier_of,
    VaultKeyState,
};

/// The sentence [`password_candidates`] answers a vault that has no master password with.
///
/// A constant because the unlock path has to *classify* this answer into its own arm, and a
/// classifier comparing against its own copy of the sentence would keep compiling while the arm
/// it produces became unreachable. `tests/keys_test.rs` pins the spelling the window sees.
pub const NO_MASTER_PASSWORD: &str = "no master password is set";

/// The sentence [`unlock_snapshot`] answers a password that matched no key file with, constant
/// for the same reason.
pub const WRONG_MASTER_PASSWORD: &str = "incorrect master password";

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
pub async fn set_master_password(
    app: tauri::AppHandle,
    password: String,
) -> Result<(), VaultCommandError> {
    validate_password(&password).map_err(|message| VaultCommandError::EmptyPassword { message })?;
    let snapshot_path = key_store::stronghold_path(&app).map_err(key_file_error)?;
    let key_path = key_store::master_key_path(&app).map_err(key_file_error)?;

    // Fresh per-vault salt: even two users picking the same password end up with
    // different derived keys, and the salt is stored (not secret) in the file.
    let mut salt = [0u8; 32];
    getrandom::getrandom(&mut salt).map_err(|e| VaultCommandError::ChangeFailed {
        message: e.to_string(),
    })?;
    let new_key = derive_master_key(&password, &salt)
        .map_err(|message| VaultCommandError::ChangeFailed { message })?;
    let verifier = verifier_of(&new_key);
    let keyfile = encode_keyfile_password(&salt, &verifier);

    let state = app.state::<KeyVault>();
    let mut guard = state
        .0
        .lock()
        .map_err(|e| VaultCommandError::ChangeFailed {
            message: e.to_string(),
        })?;

    // Open the vault under the held lock if it is not open yet (same lazy
    // init as `open_vault`). A password-protected vault must be unlocked first.
    if guard.is_none() {
        let (snapshot, key_file, key_state) =
            key_store::default_init(&app).map_err(key_file_error)?;
        let master_key = match key_state {
            VaultKeyState::Auto(key) => key,
            VaultKeyState::Locked { .. } => {
                return Err(VaultCommandError::VaultLocked {
                    message: "vault is locked: call unlock_vault with the CURRENT password \
                              before changing it"
                        .into(),
                })
            }
        };
        *guard = Some(
            open_snapshot(&DiskKeyFiles, &snapshot, &key_file, master_key.to_vec())
                .map_err(key_file_error)?,
        );
    }

    // Collect existing records from the currently open (old-key) vault.
    // Errors reading the old vault are PROPAGATED (never swallowed into an
    // empty record set), so a failed read cannot silently wipe stored keys.
    let old = guard.as_ref().expect("vault was opened above");
    let client = key_store::get_or_create_client(old)
        .map_err(|message| VaultCommandError::ChangeFailed { message })?;
    let mut records: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    for k in client
        .store()
        .keys()
        .map_err(|e| VaultCommandError::ChangeFailed {
            message: e.to_string(),
        })?
    {
        let value = client
            .store()
            .get(&k)
            .map_err(|e| VaultCommandError::ChangeFailed {
                message: e.to_string(),
            })?
            .ok_or_else(|| VaultCommandError::ChangeFailed {
                message: "stored key record has no value".to_string(),
            })?;
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
        return Err(VaultCommandError::ChangeFailed { message: e });
    }

    // Reload the managed vault from the swapped snapshot so the rest of this
    // process keeps working under the new key. On failure, drop the handle the
    // same way: keeping the old-key stronghold would let its next `save()`
    // corrupt the new snapshot.
    match Stronghold::new(snapshot_path.clone(), new_key.to_vec()) {
        Ok(stronghold) => *guard = Some(stronghold),
        Err(e) => {
            *guard = None;
            return Err(VaultCommandError::ChangeFailed {
                message: format!("vault re-encrypted but reload failed: {e}"),
            });
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
pub async fn unlock_vault(
    app: tauri::AppHandle,
    password: String,
) -> Result<(), VaultCommandError> {
    validate_password(&password).map_err(|message| VaultCommandError::EmptyPassword { message })?;
    let state = app.state::<KeyVault>();
    let mut guard = state
        .0
        .lock()
        .map_err(|e| VaultCommandError::ChangeFailed {
            message: e.to_string(),
        })?;
    if guard.is_some() {
        return Ok(());
    }
    let snapshot_path = key_store::stronghold_path(&app).map_err(key_file_error)?;
    let key_path = key_store::master_key_path(&app).map_err(key_file_error)?;
    let opened = unlock_snapshot(&snapshot_path, &key_path, &password).map_err(unlock_error)?;
    *guard = Some(opened);
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
/// Only files that exist are read, and they are read without creating anything:
/// probing a path that is not there used to forge a `master.key.old` that opens
/// nothing on every failed unlock — a backup the recovery path would then try
/// and a later swap would rotate into the user's key-file history.
///
/// A missing `master.key` is not the passwordless vault above, and it is not a
/// reason to stop looking either. It is the state the two-phase swap leaves
/// when it dies between its two renames (`master.key` -> `master.key.old`,
/// then `master.key.new` -> `master.key`): the backup then holds the only salt
/// and verifier left for the password that opens the live snapshot. Returning
/// early there answered "no master password is set" over a vault that has one,
/// and the loop below — the one written to read that backup — never ran.
pub fn password_candidates(key_path: &Path) -> Result<Vec<PasswordCandidate>, String> {
    // `read_existing_vault_key_state`, not `read_vault_key_state`: the two
    // states this function has to tell apart — no `master.key` at all, and a
    // `master.key` that really is passwordless — are exactly what the plain
    // read collapses, and what it may WRITE over.
    let primary = read_existing_vault_key_state(key_path)?;
    if let Some(VaultKeyState::Auto(_)) = primary {
        // A vault with no master password set has nothing to unlock, whatever
        // the backups hold: its key is right there in `master.key` and opens it
        // without a password, so honouring a passwordless backup here would only
        // let any string typed into the unlock dialog through.
        return Err(NO_MASTER_PASSWORD.into());
    }

    let mut candidates = Vec::new();
    if let Some(VaultKeyState::Locked { salt, verifier }) = primary {
        candidates.push((salt, verifier));
    }
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
        if let Ok(Some(VaultKeyState::Locked { salt, verifier })) =
            read_existing_vault_key_state(&backup)
        {
            candidates.push((salt, verifier));
        }
    }
    if candidates.is_empty() {
        // Only reachable with no `master.key` to read. The vault was not
        // passwordless — that returned above — so its key file is missing, and
        // that is what the user has to be told. Answering "no master password is
        // set" here told them something untrue about their own vault: the
        // password is correct and its salt and verifier are in a backup the loop
        // above never got to look at, because the read had replaced the missing
        // file with a fresh passwordless one.
        return Err(format!(
            "the master key file {} is missing and no key file on disk holds a master \
             password to check",
            ipc_path(key_path)
        ));
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
    let mut last_err = WRONG_MASTER_PASSWORD.to_string();
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
