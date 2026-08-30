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

/// Resolve the app data dir without panicking.
fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))
}

/// Path to the stronghold snapshot: `{app_data_dir}/.nekowite/stronghold.bin`.
fn stronghold_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(".nekowite").join("stronghold.bin"))
}

/// Scratch path used while re-encrypting the snapshot (see `reencrypt_vault`).
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
pub fn master_key_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(".nekowite").join("master.key"))
}

/// Read a master key file, validating it is exactly 32 bytes.
fn read_keyfile(path: &Path) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() == 32 {
        Ok(bytes)
    } else {
        Err(format!("master key file has invalid length {}", bytes.len()))
    }
}

/// Create a 32-byte master key file at `path` if it does not exist (mode
/// `0600`), or read it back if it already does. Returns the key bytes.
///
/// Only a missing file (`ErrorKind::NotFound`) triggers generation; any other
/// read failure (EIO, permission denied, …) is propagated so a damaged key is
/// never silently overwritten. A file that exists but is not exactly 32 bytes
/// is likewise an error, not silently regenerated.
///
/// Pure and `AppHandle`-free so the file logic is unit-testable in
/// `tests/keys_test.rs`. `ensure_master_key` wraps this with the app data dir.
pub fn ensure_keyfile(path: &Path) -> Result<Vec<u8>, String> {
    match fs::read(path) {
        Ok(bytes) if bytes.len() == 32 => return Ok(bytes),
        Ok(bytes) => {
            return Err(format!(
                "master key file has invalid length {} (expected 32)",
                bytes.len()
            ))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("cannot read master key file: {e}")),
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    write_keyfile(path, &bytes)?;
    Ok(bytes.to_vec())
}

/// Overwrite `path` with `bytes`, forcing mode `0600`. Written atomically via a
/// temp sibling + fsync + rename so a partial write can never leave a corrupt
/// key file. Used by `set_master_password` to persist the new key, and by
/// `ensure_keyfile` on first creation.
fn write_keyfile(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = sibling_tmp(path);
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

/// `{parent}/.{name}.tmp` sibling of `path`, used for atomic writes.
fn sibling_tmp(path: &Path) -> PathBuf {
    let mut p = path.to_path_buf();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    p.set_file_name(format!(".{name}.tmp"));
    p
}

/// Ensure the master key file exists under the app data dir and return its
/// 32 bytes. Auto-generated on first run (mode `0600`), stable across runs.
pub fn ensure_master_key(app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    ensure_keyfile(&master_key_path(app)?)
}

/// Derive a 32-byte master key from a user-set master password (SHA-256).
fn derive_key_from_password(password: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    hasher.finalize().into()
}

/// Reject an empty master password.
pub fn validate_password(password: &str) -> Result<(), String> {
    if password.trim().is_empty() {
        return Err("password cannot be empty".into());
    }
    Ok(())
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
    Ok((stronghold_path(app)?, ensure_master_key(app)?))
}

/// Borrow-safe wrapper of [`default_init`] for `open_vault`.
fn init_with_default(
    app: &tauri::AppHandle,
) -> impl FnMut() -> Result<(PathBuf, Vec<u8>), String> + '_ {
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

/// Re-encrypt the snapshot at `snapshot_path` with `new_key`, migrating
/// `records` over, and persist the new master key at `key_path`. Pure
/// path-level function, testable without an `AppHandle`.
///
/// Crash/error-safe ordering:
/// 1. Build the new-key snapshot at a temp sibling (clearing any stale temp
///    from a previously interrupted run first), then `save()` it.
/// 2. Write + fsync the new `master.key` FIRST. If this fails, the old snapshot
///    and the old key are still on disk, so an `Err` leaves the vault readable
///    by the old key.
/// 3. Swap the snapshot with a single atomic `fs::rename` — it replaces the
///    destination in place on the same filesystem, so there is no
///    `remove_file` step that could delete the only vault copy.
/// 4. If the swap itself fails, restore the old master key so the disk remains
///    consistent with the old key, then return `Err`.
pub fn reencrypt_vault(
    snapshot_path: &Path,
    key_path: &Path,
    new_key: &[u8],
    records: &[(Vec<u8>, Vec<u8>)],
) -> Result<(), String> {
    let old_key = read_keyfile(key_path)?;
    let tmp_snapshot = stronghold_tmp_path(snapshot_path);

    // 1. Rebuild under the new key at a temp path. Clear any stale temp file
    //    first, or `Stronghold::new` would try to load it with the new key and
    //    fail.
    let _ = fs::remove_file(&tmp_snapshot);
    let new_stronghold = Stronghold::new(tmp_snapshot.clone(), new_key.to_vec())
        .map_err(|e| e.to_string())?;
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

    // 2. Durable new master key first.
    write_keyfile(key_path, new_key)?;

    // 3+4. Atomic swap; restore the old key if it fails.
    if let Err(e) = fs::rename(&tmp_snapshot, snapshot_path) {
        let _ = write_keyfile(key_path, &old_key);
        return Err(e.to_string());
    }
    Ok(())
}

/// Set (or replace) the master password. Derives a new 32-byte master key from
/// the password, re-encrypts the stronghold snapshot with it, and updates the
/// `master.key` file so future launches unlock with the new password.
#[tauri::command]
pub fn set_master_password(app: tauri::AppHandle, password: String) -> Result<(), String> {
    validate_password(&password)?;
    let snapshot_path = stronghold_path(&app)?;
    let key_path = master_key_path(&app)?;
    let new_key = derive_key_from_password(&password);

    // Collect existing records from the currently open (old-key) vault, then
    // rebuild the snapshot encrypted with the new key and migrate them over.
    // Errors reading the old vault are PROPAGATED (never swallowed into an
    // empty record set), so a failed read cannot silently wipe stored keys.
    let records = open_vault(&app, &mut init_with_default(&app), |old| {
        let client = get_or_create_client(old)?;
        let mut records: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
        for k in client.store().keys().map_err(|e| e.to_string())? {
            let value = client
                .store()
                .get(&k)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "stored key record has no value".to_string())?;
            records.push((k, value));
        }
        Ok(records)
    })?;

    reencrypt_vault(&snapshot_path, &key_path, &new_key, &records)?;

    // Reload the managed vault from the swapped snapshot so the rest of this
    // process keeps working under the new key.
    {
        let state = app.state::<KeyVault>();
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        let reloaded = Stronghold::new(&snapshot_path, new_key.to_vec()).map_err(|e| e.to_string())?;
        *guard = Some(reloaded);
    }
    Ok(())
}
