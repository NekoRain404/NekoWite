//! Secure key store: the vault's Stronghold lifecycle (open, save, client) and
//! the stronghold-backed provider-key store.
//!
//! This is the on-disk and in-memory boundary for key material. The master key
//! *file* — its format, its Argon2id KDF, and the state a vault is in when the
//! file is missing — lives in [`crate::storage::key_file_store`] and is
//! re-exported here, so callers and tests that import those names from the key
//! store keep resolving. The crash-safe recovery/re-encryption sequence lives
//! in [`crate::domain::recovery`]; the `#[tauri::command]` entry points that
//! drive it live in [`crate::commands::keys`]. Nothing here ever discloses a
//! real API key to the window.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;
use tauri_plugin_stronghold::stronghold::Stronghold;

use crate::domain::recovery::open_snapshot;
use crate::errors::fs_error;
use crate::state::KeyVault;
use crate::storage::key_file_io::DiskKeyFiles;

// The key-file *names* and the state a key file decodes to are what the
// crash-safe swap reasons about, so they are domain policy and live in
// `crate::domain::key_files`. Re-exported here for this stage so callers and
// tests that import them from the key store keep resolving (roadmap §10.1
// rule 5).
pub use crate::domain::key_files::{sibling_suffixed, stronghold_tmp_path, VaultKeyState};

// The master key file itself moved to `crate::storage::key_file_store` (roadmap
// §13.1 line budget, §13.3 vertical slice: the file, its KDF, and the state a
// missing file puts the vault in, end to end). Re-exported so that no consumer
// of the key store had to be edited for the split.
pub use crate::storage::key_file_store::{
    decode_keyfile, derive_master_key, encode_keyfile_password, encode_keyfile_passwordless,
    ensure_keyfile, read_existing_vault_key_state, read_vault_key_state, validate_password,
    verifier_of, write_key_file_at,
};

/// Client id used for the single provider-key client inside the vault.
pub(crate) const VAULT_CLIENT_ID: [u8; 32] = [1u8; 32];

/// Fixed masked indicator returned to the frontend by `load_ai_key`. Never the
/// real API key — only a "a key is configured" marker the settings UI can show.
pub const AI_KEY_MASKED: &str = "••••••••";

/// Decide whether `key` may be written to the provider-key store.
///
/// There is **no maximum length**. Vault `write_secret` records are historically
/// capped at 255 bytes, which is why this path uses the Stronghold *client
/// store* (an unbounded byte map) instead. Provider credentials routinely
/// exceed 256 characters (`sk-proj-…`, JWT-shaped keys from OpenAI-compatible
/// gateways). The only value we refuse is the masked placeholder the settings
/// UI displays when a key is already configured.
pub fn validate_stored_api_key(key: &str) -> Result<(), String> {
    if key == AI_KEY_MASKED {
        return Err("this is the masked placeholder, not an API key: re-enter the key".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// Resolve the app data dir without panicking.
fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))
}

/// Path to the stronghold snapshot: `{app_data_dir}/.nekowite/stronghold.bin`.
pub fn stronghold_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(".nekowite").join("stronghold.bin"))
}

/// Path to the master key file: `{app_data_dir}/.nekowite/master.key`.
pub fn master_key_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(".nekowite").join("master.key"))
}

// ---------------------------------------------------------------------------
// The vault snapshot's I/O helpers.
// ---------------------------------------------------------------------------

/// Flush an existing file's data to stable storage. Stronghold's `save()` does
/// not fsync, so the re-encryption path does it explicitly before any rename
/// makes the temp snapshot the live one.
pub fn fsync_file(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|e| fs_error("flush", path, e))
}

/// Ensure the master key file exists under the app data dir and return its
/// 32 bytes (passwordless only). Auto-generated on first run (mode `0600`),
/// stable across runs.
pub fn ensure_master_key(app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    ensure_keyfile(&master_key_path(app)?)
}

// ---------------------------------------------------------------------------
// Stronghold open / save / client helpers.
// ---------------------------------------------------------------------------

/// Open the managed stronghold, initializing it lazily with the current
/// master key if it has not been opened yet. `init` supplies the snapshot
/// path, master key path, and the key state (resolved *before* locking so the
/// caller does not borrow the app while holding the vault guard).
///
/// A password-protected vault that has not been unlocked yet errors here with a
/// recovery hint instead of auto-opening, so the locked state is never bypassed.
pub fn open_vault<R>(
    app: &tauri::AppHandle,
    init: &mut dyn FnMut() -> Result<(PathBuf, PathBuf, VaultKeyState), String>,
    f: impl FnOnce(&Stronghold) -> Result<R, String>,
) -> Result<R, String> {
    let state = app.state::<KeyVault>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        let (snapshot_path, key_path, key_state) = init()?;
        let master_key = match key_state {
            VaultKeyState::Auto(key) => key,
            VaultKeyState::Locked { .. } => {
                return Err(
                    "vault is locked: unlock it with your master password first \
                     (unlock_vault)"
                        .into(),
                )
            }
        };
        *guard = Some(open_snapshot(
            &DiskKeyFiles,
            &snapshot_path,
            &key_path,
            master_key.to_vec(),
        )?);
    }
    let stronghold = guard.as_ref().expect("open_vault guarantees a stronghold");
    f(stronghold)
}

/// Init source that auto-generates/reads the master key file.
///
/// In the state an interrupted key swap leaves — no `master.key`, the key that
/// opens the snapshot in `master.key.old` — `read_vault_key_state` resolves the
/// state from the backup rather than creating a fresh passwordless key, so this
/// opens the vault with the key that actually decrypts it (or reports the vault
/// as locked when the backup is password-protected and the user has to unlock).
pub fn default_init(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf, VaultKeyState), String> {
    let key_path = master_key_path(app)?;
    Ok((
        stronghold_path(app)?,
        key_path.clone(),
        read_vault_key_state(&key_path)?,
    ))
}

/// Borrow-safe wrapper of [`default_init`] for [`open_vault`].
pub fn init_with_default(
    app: &tauri::AppHandle,
) -> impl FnMut() -> Result<(PathBuf, PathBuf, VaultKeyState), String> + '_ {
    || default_init(app)
}

/// Resolve the provider client: reuse the in-session client if already
/// loaded, restore it from the snapshot if it was persisted, and only create a
/// fresh one on the very first use. `create_client` would otherwise replace an
/// in-memory client (dropping its records before the next `save`).
pub fn get_or_create_client(stronghold: &Stronghold) -> Result<iota_stronghold::Client, String> {
    if let Ok(client) = stronghold.inner().get_client(VAULT_CLIENT_ID) {
        return Ok(client);
    }
    if let Ok(client) = stronghold.inner().load_client(VAULT_CLIENT_ID) {
        return Ok(client);
    }
    stronghold
        .inner()
        .create_client(VAULT_CLIENT_ID)
        .map_err(|e| e.to_string())
}

/// Persist the currently open vault's snapshot to disk.
pub fn save_vault(stronghold: &Stronghold) -> Result<(), String> {
    stronghold.save().map_err(|e| e.to_string())
}

/// Tighten the snapshot file to mode `0600`, matching `master.key`. Stronghold
/// writes the snapshot with the process default umask (typically `0644`), so
/// after every write we re-set the perms to keep the key material private.
#[cfg(unix)]
pub fn tighten_snapshot_perms(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| fs_error("restrict permissions on", path, e))
}

/// Platforms without POSIX file modes: nothing to tighten, the platform
/// default permissions apply.
#[cfg(not(unix))]
pub fn tighten_snapshot_perms(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Tighten snapshot perms after a save at `{app_data_dir}/.nekowite/stronghold.bin`.
pub fn tighten_saved_snapshot(app: &tauri::AppHandle) -> Result<(), String> {
    tighten_snapshot_perms(&stronghold_path(app)?)
}

// ---------------------------------------------------------------------------
// Provider-key store (stronghold-backed).
// ---------------------------------------------------------------------------

/// Read the stored API key for a provider, for AI request use *inside Rust
/// only*. Never exposed over IPC — it is the sole path that yields the real key.
pub fn load_ai_key_internal(
    app: &tauri::AppHandle,
    provider: &str,
) -> Result<Option<String>, String> {
    let provider_bytes = provider.as_bytes().to_vec();
    open_vault(app, &mut init_with_default(app), |stronghold| {
        let client = get_or_create_client(stronghold)?;
        let value = client
            .store()
            .get(&provider_bytes)
            .map_err(|e| e.to_string())?;
        Ok(value.map(|bytes| String::from_utf8_lossy(&bytes).to_string()))
    })
}

/// Map the presence of a stored key to its disclosed form. Never returns the
/// real key: it returns [`AI_KEY_MASKED`] when a key is configured (so the
/// settings UI can show "a key is set") and `None` otherwise. Pure and
/// unit-testable.
pub fn ai_key_presence(store_value: Option<String>) -> Option<String> {
    store_value.map(|_| AI_KEY_MASKED.to_string())
}

#[cfg(test)]
mod stored_api_key_tests {
    use super::*;
    use iota_stronghold::Store;

    #[test]
    fn client_store_round_trips_a_multi_kilobyte_key() {
        let long = format!("sk-proj-{}", "a".repeat(8192));
        assert!(validate_stored_api_key(&long).is_ok());
        let store = Store::default();
        store
            .insert(b"openai".to_vec(), long.as_bytes().to_vec(), None)
            .expect("client store must accept a multi-kilobyte API key");
        let got = store.get(b"openai").unwrap().expect("key was stored");
        assert_eq!(got, long.as_bytes());
    }
}
