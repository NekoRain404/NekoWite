use std::fs;
use std::io::Write;
#[cfg(unix)]
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

/// `{parent}/{name}.{suffix}` sibling of `path`: the `master.key.new` staging
/// file and `master.key.old` recovery backup used by the crash-safe swap in
/// `reencrypt_vault` (and consulted by `open_snapshot` on load).
fn sibling_suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut p = path.to_path_buf();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    p.set_file_name(format!("{name}.{suffix}"));
    p
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

/// Write `bytes` directly to `path` (creating parent dirs), forcing mode
/// `0600` on unix, and fsync the contents. Does not rename — callers that need
/// atomicity wrap this with a temp sibling (see `write_keyfile`) or a
/// rename sequence (see `reencrypt_vault`).
fn write_key_file_at(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut f = options.open(path).map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    Ok(())
}

/// Overwrite `path` with `bytes`, forcing mode `0600` (unix). Written atomically
/// via a temp sibling + fsync + rename so a partial write can never leave a
/// corrupt key file. Used by `ensure_keyfile` on first creation;
/// `reencrypt_vault` stages the new key at `master.key.new` instead.
fn write_keyfile(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = sibling_tmp(path);
    write_key_file_at(&tmp, bytes)?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Flush an existing file's data to stable storage. Stronghold's `save()` does
/// not fsync, so `reencrypt_vault` does it explicitly before any rename makes
/// the temp snapshot the live one.
fn fsync_file(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())
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

/// Open the snapshot at `snapshot_path` with `master_key`. If that fails and a
/// `master.key.old` backup exists, retry with it before giving up.
///
/// The backup is the recovery path for a crash mid-`set_master_password`: the
/// two-phase swap in `reencrypt_vault` can be interrupted after the key files
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
            let backup = read_keyfile(&sibling_suffixed(key_path, "old"))
                .and_then(|backup_key| {
                    Stronghold::new(snapshot_path, backup_key).map_err(|e| e.to_string())
                });
            match backup {
                Ok(stronghold) => Ok(stronghold),
                // Surface the primary error: the backup is missing or also
                // wrong, and its own error would only repeat the same
                // decryption failure.
                Err(_) => Err(primary_err.to_string()),
            }
        }
    }
}

/// Open the managed stronghold, initializing it lazily with the current
/// master key if it has not been opened yet. `init` supplies the snapshot
/// path, master key path, and master key (resolved *before* locking so the
/// caller does not borrow the app while holding the vault guard).
fn open_vault<R>(
    app: &tauri::AppHandle,
    init: &mut dyn FnMut() -> Result<(PathBuf, PathBuf, Vec<u8>), String>,
    f: impl FnOnce(&Stronghold) -> Result<R, String>,
) -> Result<R, String> {
    let state = app.state::<KeyVault>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        let (snapshot_path, key_path, master_key) = init()?;
        *guard = Some(open_snapshot(&snapshot_path, &key_path, master_key)?);
    }
    let stronghold = guard.as_ref().expect("open_vault guarantees a stronghold");
    f(stronghold)
}

/// Init source that auto-generates/reads the master key file.
fn default_init(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf, Vec<u8>), String> {
    let key_path = master_key_path(app)?;
    Ok((stronghold_path(app)?, key_path, ensure_master_key(app)?))
}

/// Borrow-safe wrapper of [`default_init`] for `open_vault`.
fn init_with_default(
    app: &tauri::AppHandle,
) -> impl FnMut() -> Result<(PathBuf, PathBuf, Vec<u8>), String> + '_ {
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

/// Tighten the snapshot file to mode `0600`, matching `master.key`. Stronghold
/// writes the snapshot with the process default umask (typically `0644`), so
/// after every write we re-set the perms to keep the key material private.
#[cfg(unix)]
fn tighten_snapshot_perms(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())
}

/// Platforms without POSIX file modes: nothing to tighten, the platform
/// default permissions apply.
#[cfg(not(unix))]
fn tighten_snapshot_perms(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Tighten snapshot perms after a save at `{app_data_dir}/.nekowite/stronghold.bin`.
fn tighten_saved_snapshot(app: &tauri::AppHandle) -> Result<(), String> {
    tighten_snapshot_perms(&stronghold_path(app)?)
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
    })?;
    tighten_saved_snapshot(&app)?;
    Ok(())
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
/// `records` over, and swap the new master key in at `key_path`. Pure
/// path-level function, testable without an `AppHandle`.
///
/// Crash-safe two-phase swap. Every step leaves the on-disk key files and the
/// snapshot mutually recoverable, so a crash at ANY point loses no stored key
/// (load-time recovery is `open_snapshot`'s `master.key.old` retry):
///
/// 1. Write + fsync the new key to the `master.key.new` staging file. The old
///    `master.key` and old snapshot are untouched, so the vault stays readable
///    with the old key.
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
    records: &[(Vec<u8>, Vec<u8>)],
) -> Result<(), String> {
    let new_key_staging = sibling_suffixed(key_path, "new");
    let old_key_backup = sibling_suffixed(key_path, "old");
    let tmp_snapshot = stronghold_tmp_path(snapshot_path);

    // 1. Durable new key material at the staging path. Clear any stale staging
    //    file from a previously interrupted run first.
    let _ = fs::remove_file(&new_key_staging);
    write_key_file_at(&new_key_staging, new_key)?;

    // 2. Rebuild under the new key at a temp path. Clear any stale temp file
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
    fsync_file(&tmp_snapshot)?;

    // 3. Move the old key aside BEFORE the new key takes its name, so step 4
    //    does not have to rename over an existing file.
    let _ = fs::remove_file(&old_key_backup);
    fs::rename(key_path, &old_key_backup).map_err(|e| e.to_string())?;

    // 4. Promote the staged key. If this fails, put the old key back so the
    //    disk stays consistent with the (still old) snapshot.
    if let Err(e) = fs::rename(&new_key_staging, key_path) {
        let _ = fs::rename(&old_key_backup, key_path);
        return Err(e.to_string());
    }

    // 5. Atomic snapshot swap; restore the old key if it fails.
    if let Err(e) = fs::rename(&tmp_snapshot, snapshot_path) {
        let _ = fs::rename(&old_key_backup, key_path);
        return Err(e.to_string());
    }
    // The rename preserved the temp file's umask-derived perms; tighten them.
    tighten_snapshot_perms(snapshot_path)?;

    // 6. The backup is stale once the snapshot decrypts with `master.key`.
    let _ = fs::remove_file(&old_key_backup);
    Ok(())
}

/// Set (or replace) the master password. Derives a new 32-byte master key from
/// the password, re-encrypts the stronghold snapshot with it, and updates the
/// `master.key` file so future launches unlock with the new password.
///
/// The vault mutex is held across the ENTIRE operation — record collection,
/// the crash-safe two-phase swap, and the reload — so a concurrent
/// `store_ai_key` can neither read stale (old-key) records mid-swap nor save
/// old-key ciphertext into the swapped snapshot afterwards.
#[tauri::command]
pub fn set_master_password(app: tauri::AppHandle, password: String) -> Result<(), String> {
    validate_password(&password)?;
    let snapshot_path = stronghold_path(&app)?;
    let key_path = master_key_path(&app)?;
    let new_key = derive_key_from_password(&password);

    let state = app.state::<KeyVault>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;

    // Open the vault under the held lock if it is not open yet (same lazy
    // init as `open_vault`).
    if guard.is_none() {
        let (snapshot, key_file, master_key) = default_init(&app)?;
        *guard = Some(open_snapshot(&snapshot, &key_file, master_key)?);
    }

    // Collect existing records from the currently open (old-key) vault.
    // Errors reading the old vault are PROPAGATED (never swallowed into an
    // empty record set), so a failed read cannot silently wipe stored keys.
    let old = guard.as_ref().expect("vault was opened above");
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

    // Two-phase swap of the key + snapshot on disk.
    if let Err(e) = reencrypt_vault(&snapshot_path, &key_path, &new_key, &records) {
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
