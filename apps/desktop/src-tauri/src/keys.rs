use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_stronghold::stronghold::Stronghold;

/// Managed stronghold handle, opened lazily on first use (or by
/// `set_master_password`, which swaps the inner snapshot after re-encryption).
pub struct KeyVault(pub Mutex<Option<Stronghold>>);

impl Default for KeyVault {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// Client id used for the single provider-key client inside the vault.
const VAULT_CLIENT_ID: [u8; 32] = [1u8; 32];

/// Path to the stronghold snapshot: `{app_data_dir}/.nekowite/stronghold.bin`.
fn stronghold_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app data dir must resolve")
        .join(".nekowite")
        .join("stronghold.bin")
}

/// Scratch path used while re-encrypting the snapshot (see `set_master_password`).
fn stronghold_tmp_path(snapshot: &Path) -> PathBuf {
    let mut p = snapshot.to_path_buf();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "stronghold.bin".to_string());
    p.set_file_name(format!(".{name}.tmp"));
    p
}

/// Path to the master key file: `{app_data_dir}/.nekowite/master.key`.
pub fn master_key_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app data dir must resolve")
        .join(".nekowite")
        .join("master.key")
}

/// Create a 32-byte master key file at `path` if it does not exist (mode
/// `0600`), or read it back if it already does. Returns the key bytes.
///
/// Pure and `AppHandle`-free so the file logic is unit-testable in
/// `tests/keys_test.rs`. `ensure_master_key` wraps this with the app data dir.
pub fn ensure_keyfile(path: &Path) -> Result<Vec<u8>, String> {
    if let Ok(bytes) = fs::read(path) {
        return Ok(bytes);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    write_keyfile(path, &bytes)?;
    Ok(bytes.to_vec())
}

/// Overwrite `path` with `bytes`, forcing mode `0600`. Used by
/// `set_master_password` to persist the new password-derived key.
fn write_keyfile(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    Ok(())
}

/// Ensure the master key file exists under the app data dir and return its
/// 32 bytes. Auto-generated on first run (mode `0600`), stable across runs.
pub fn ensure_master_key(app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    ensure_keyfile(&master_key_path(app))
}

/// Derive a 32-byte master key from a user-set master password (SHA-256).
fn derive_key_from_password(password: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    hasher.finalize().into()
}

/// Open the managed stronghold, initializing it lazily with the current
/// master key if it has not been opened yet. `init` supplies the snapshot path
/// and master key (resolved *before* locking so the caller does not borrow the
/// app while holding the vault guard).
fn open_vault<R>(
    app: &tauri::AppHandle,
    init: &mut dyn FnMut() -> Result<(PathBuf, Vec<u8>), String>,
    f: impl FnOnce(&Stronghold) -> Result<R, String>,
) -> Result<R, String> {
    let state = app.state::<KeyVault>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        let (snapshot_path, master_key) = init()?;
        let stronghold = Stronghold::new(snapshot_path, master_key).map_err(|e| e.to_string())?;
        *guard = Some(stronghold);
    }
    let stronghold = guard.as_ref().expect("open_vault guarantees a stronghold");
    f(stronghold)
}

/// Init source that auto-generates/reads the master key file.
fn default_init(app: &tauri::AppHandle) -> Result<(PathBuf, Vec<u8>), String> {
    Ok((stronghold_path(app), ensure_master_key(app)?))
}

/// Borrow-safe wrapper of [`default_init`] for `open_vault`.
fn init_with_default(app: &tauri::AppHandle) -> impl FnMut() -> Result<(PathBuf, Vec<u8>), String> + '_ {
    || default_init(app)
}

/// Resolve the provider client: reuse the in-session client if already
/// loaded, restore it from the snapshot if it was persisted, and only create a
/// fresh one on the very first use. `create_client` would otherwise replace an
/// in-memory client (dropping its records before the next `save`).
fn get_or_create_client(
    stronghold: &Stronghold,
) -> Result<iota_stronghold::Client, String> {
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
fn save_vault(stronghold: &Stronghold) -> Result<(), String> {
    stronghold.save().map_err(|e| e.to_string())
}

/// Store an API key for a provider in the stronghold vault. If the provider
/// already has a key, it is overwritten. The snapshot is committed after each
/// write so the key survives restarts.
#[tauri::command]
pub fn store_ai_key(app: tauri::AppHandle, provider: String, key: String) -> Result<(), String> {
    let provider_bytes = provider.into_bytes();
    let key_bytes = key.into_bytes();
    open_vault(&app, &mut init_with_default(&app), |stronghold| {
        let client = get_or_create_client(stronghold)?;
        client
            .store()
            .insert(provider_bytes.clone(), key_bytes.clone(), None)
            .map_err(|e| e.to_string())?;
        save_vault(stronghold)
    })
}

/// Load the stored API key for a provider, or `None` if none has been saved.
/// Serializes as `string | null` on the JS side.
#[tauri::command]
pub fn load_ai_key(app: tauri::AppHandle, provider: String) -> Result<Option<String>, String> {
    let provider_bytes = provider.into_bytes();
    open_vault(&app, &mut init_with_default(&app), |stronghold| {
        let client = get_or_create_client(stronghold)?;
        let value = client
            .store()
            .get(&provider_bytes)
            .map_err(|e| e.to_string())?;
        Ok(value.map(|bytes| String::from_utf8_lossy(&bytes).to_string()))
    })
}

/// Set (or replace) the master password. Derives a new 32-byte master key from
/// the password, re-encrypts the stronghold snapshot with it, and updates the
/// `master.key` file so future launches unlock with the new password.
#[tauri::command]
pub fn set_master_password(app: tauri::AppHandle, password: String) -> Result<(), String> {
    let snapshot_path = stronghold_path(&app);
    let key_path = master_key_path(&app);
    let new_key = derive_key_from_password(&password);

    // Collect existing records from the currently open (old-key) vault, then
    // rebuild the snapshot encrypted with the new key and migrate them over.
    let records = open_vault(&app, &mut init_with_default(&app), |old| {
        let mut records: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
        if let Ok(client) = get_or_create_client(old) {
            if let Ok(keys) = client.store().keys() {
                for k in keys {
                    if let Ok(Some(v)) = client.store().get(&k) {
                        records.push((k, v));
                    }
                }
            }
        }
        Ok(records)
    })?;

    let new_stronghold = Stronghold::new(stronghold_tmp_path(&snapshot_path), new_key.to_vec())
        .map_err(|e| e.to_string())?;
    let client = new_stronghold
        .inner()
        .create_client(VAULT_CLIENT_ID)
        .map_err(|e| e.to_string())?;
    for (k, v) in &records {
        client
            .store()
            .insert(k.clone(), v.clone(), None)
            .map_err(|e| e.to_string())?;
    }
    new_stronghold.save().map_err(|e| e.to_string())?;

    // Atomically swap the new snapshot over the old one (writing in place would
    // fail: `Stronghold::new` decrypts the existing file with the new key).
    let _ = fs::remove_file(&snapshot_path);
    fs::rename(stronghold_tmp_path(&snapshot_path), &snapshot_path).map_err(|e| e.to_string())?;

    // Persist the new master key and swap the live stronghold.
    write_keyfile(&key_path, &new_key)?;
    {
        let state = app.state::<KeyVault>();
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        *guard = Some(new_stronghold);
    }
    Ok(())
}
