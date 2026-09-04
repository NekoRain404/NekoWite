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

/// What the on-disk `master.key` actually holds. It NEVER holds a raw
/// decryption key when a master password is set — only a verifier derived from
/// the password via a proper KDF, so the file alone cannot unlock the vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultKeyState {
    /// No master password set (legacy/auto-generated): a random 32-byte key is
    /// stored so the vault auto-unlocks on launch. There is no secret password
    /// to protect here; the file permissions (0600) are the boundary.
    Auto([u8; 32]),
    /// A master password is set: the file carries the KDF salt and a one-way
    /// verifier. The Stronghold key is only recoverable by deriving it from the
    /// password; the file alone cannot decrypt the snapshot.
    Locked { salt: [u8; 32], verifier: [u8; 32] },
}

/// Key-file format version byte.
const KEYFILE_VERSION: u8 = 1;
/// Mode byte: 0 = passwordless (raw key), 1 = password (salt + verifier).
const MODE_PASSWORDLESS: u8 = 0;
const MODE_PASSWORD: u8 = 1;

/// Fixed masked indicator returned to the frontend by `load_ai_key`. Never the
/// real API key — only a "a key is configured" marker the settings UI can show.
pub const AI_KEY_MASKED: &str = "••••••••";

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

// ---------------------------------------------------------------------------
// Key file (de)serialization + master-key derivation.
// ---------------------------------------------------------------------------

/// Serialize a passwordless key file: `[version=1, mode=0, key(32)]`.
pub fn encode_keyfile_passwordless(key: &[u8; 32]) -> Vec<u8> {
    let mut out = vec![KEYFILE_VERSION, MODE_PASSWORDLESS];
    out.extend_from_slice(key);
    out
}

/// Serialize a password key file: `[version=1, mode=1, salt(32), verifier(32)]`.
pub fn encode_keyfile_password(salt: &[u8; 32], verifier: &[u8; 32]) -> Vec<u8> {
    let mut out = vec![KEYFILE_VERSION, MODE_PASSWORD];
    out.extend_from_slice(salt);
    out.extend_from_slice(verifier);
    out
}

/// Decode a master key file into its state. Rejects wrong lengths, wrong
/// version, or unknown modes so a corrupt/partial key is never silently used.
pub fn decode_keyfile(bytes: &[u8]) -> Result<VaultKeyState, String> {
    let invalid = || {
        format!(
            "master key file has invalid length {} (expected 34 or 66)",
            bytes.len()
        )
    };
    if bytes.len() < 2 {
        return Err(invalid());
    }
    if bytes[0] != KEYFILE_VERSION {
        return Err(invalid());
    }
    match bytes[1] {
        MODE_PASSWORDLESS => {
            if bytes.len() != 34 {
                return Err(invalid());
            }
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes[2..34]);
            Ok(VaultKeyState::Auto(key))
        }
        MODE_PASSWORD => {
            if bytes.len() != 66 {
                return Err(invalid());
            }
            let mut salt = [0u8; 32];
            salt.copy_from_slice(&bytes[2..34]);
            let mut verifier = [0u8; 32];
            verifier.copy_from_slice(&bytes[34..66]);
            Ok(VaultKeyState::Locked { salt, verifier })
        }
        mode => Err(format!("master key file has unknown mode {mode}")),
    }
}

/// Derive the 32-byte Stronghold master key from a user password + per-vault
/// salt using **Argon2id** (OWASP-recommended parameters: 19 MiB, t=2, p=1).
/// This replaces the old single-round SHA-256, which was both weak and allowed
/// a raw key — here the output is a KDF-hardened key that is never persisted.
pub fn derive_master_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let config = argon2::Config::owasp2();
    let hash = argon2::hash_raw(password.as_bytes(), salt, &config)
        .map_err(|e| format!("key derivation failed: {e}"))?;
    let mut out = [0u8; 32];
    out.copy_from_slice(&hash[..32]);
    Ok(out)
}

/// One-way verification value stored in a password-protected key file. It is
/// derived from the *master key* (not the password directly) so it is NEVER
/// itself usable as the Stronghold key — it only lets an unlock confirm the
/// password was correct.
pub fn verifier_of(master_key: &[u8; 32]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(master_key);
    hasher.finalize().into()
}

/// Read a master key file and return its [`VaultKeyState`]. A missing file is
/// treated as first-run: a fresh random passwordless key is generated and
/// persisted (mode `0600`). Any other read error is propagated so a damaged key
/// is never silently overwritten; wrong lengths/modes are rejected by
/// [`decode_keyfile`].
pub fn read_vault_key_state(path: &Path) -> Result<VaultKeyState, String> {
    match fs::read(path) {
        Ok(bytes) => decode_keyfile(&bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut key = [0u8; 32];
            getrandom::getrandom(&mut key).map_err(|e| e.to_string())?;
            write_keyfile(path, &encode_keyfile_passwordless(&key))?;
            Ok(VaultKeyState::Auto(key))
        }
        Err(e) => Err(format!("cannot read master key file: {e}")),
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
/// corrupt key file. Used by `read_vault_key_state` on first creation;
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

/// Read an on-disk master key that is directly usable as a Stronghold key. Only
/// valid for a **passwordless** key file; a password-protected file returns an
/// error (its key must be derived from the password). Used by the load-time
/// recovery in [`open_snapshot`] against the `master.key.old` backup.
fn read_unlockable_keyfile(path: &Path) -> Result<Vec<u8>, String> {
    match read_vault_key_state(path)? {
        VaultKeyState::Auto(key) => Ok(key.to_vec()),
        VaultKeyState::Locked { .. } => {
            Err("backup master key is password-protected".to_string())
        }
    }
}

/// Create/read a master key and return its raw 32 bytes, ONLY for the
/// passwordless case. If a master password is set the vault is locked and an
/// error is returned (call [`unlock_vault`]); the raw key is never revealed.
///
/// Only a missing file (`ErrorKind::NotFound`) triggers generation; any other
/// read failure (EIO, permission denied, …) is propagated so a damaged key is
/// never silently overwritten. A file that is malformed is likewise an error.
///
/// Pure and `AppHandle`-free so the file logic is unit-testable in
/// `tests/keys_test.rs`. `ensure_master_key` wraps this with the app data dir.
pub fn ensure_keyfile(path: &Path) -> Result<Vec<u8>, String> {
    match read_vault_key_state(path)? {
        VaultKeyState::Auto(key) => Ok(key.to_vec()),
        VaultKeyState::Locked { .. } => Err(
            "master key is password-protected; the vault is locked (call unlock_vault)".into(),
        ),
    }
}

/// Ensure the master key file exists under the app data dir and return its
/// 32 bytes (passwordless only). Auto-generated on first run (mode `0600`),
/// stable across runs.
pub fn ensure_master_key(app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    ensure_keyfile(&master_key_path(app)?)
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
            let backup = read_unlockable_keyfile(&sibling_suffixed(key_path, "old"))
                .and_then(|backup_key| {
                    Stronghold::new(snapshot_path, backup_key).map_err(|e| e.to_string())
                });
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

/// Open the managed stronghold, initializing it lazily with the current
/// master key if it has not been opened yet. `init` supplies the snapshot
/// path, master key path, and the key state (resolved *before* locking so the
/// caller does not borrow the app while holding the vault guard).
///
/// A password-protected vault that has not been unlocked yet errors here with a
/// recovery hint instead of auto-opening, so the locked state is never bypassed.
fn open_vault<R>(
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
        *guard = Some(open_snapshot(&snapshot_path, &key_path, master_key.to_vec())?);
    }
    let stronghold = guard.as_ref().expect("open_vault guarantees a stronghold");
    f(stronghold)
}

/// Init source that auto-generates/reads the master key file.
fn default_init(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf, VaultKeyState), String> {
    let key_path = master_key_path(app)?;
    Ok((
        stronghold_path(app)?,
        key_path.clone(),
        read_vault_key_state(&key_path)?,
    ))
}

/// Borrow-safe wrapper of [`default_init`] for `open_vault`.
fn init_with_default(
    app: &tauri::AppHandle,
) -> impl FnMut() -> Result<(PathBuf, PathBuf, VaultKeyState), String> + '_ {
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
    // Never store the masked "a key is configured" indicator as a real key —
    // the settings UI shows it as a placeholder and must not persist it over a
    // previously-saved credential.
    if key == AI_KEY_MASKED {
        return Err("this is the masked placeholder, not an API key: re-enter the key".into());
    }
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

/// Read the stored API key for a provider, for AI request use *inside Rust
/// only*. Never exposed over IPC — it is the sole path that yields the real key.
pub fn load_ai_key_internal(
    app: &tauri::AppHandle,
    provider: &str,
) -> Result<Option<String>, String> {
    let provider_bytes = provider.as_bytes().to_vec();
    open_vault(&app, &mut init_with_default(&app), |stronghold| {
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

/// Return whether an API key is configured for a provider, without disclosing
/// it. Serializes as `string | null` on the JS side (`Some` is the masked
/// indicator, never the real key) so the settings UI can signal "a key is set".
#[tauri::command]
pub fn load_ai_key(app: tauri::AppHandle, provider: String) -> Result<Option<String>, String> {
    Ok(ai_key_presence(load_ai_key_internal(&app, &provider)?))
}

/// Re-encrypt the snapshot at `snapshot_path` with `new_key`, migrating
/// `records` over, and swap the new master key file in at `key_path`. `keyfile`
/// is the serialized key blob to persist (`master.key` = salt+verifier for a
/// password-protected vault, or a passwordless raw key). Pure path-level
/// function, testable without an `AppHandle`.
///
/// Crash-safe two-phase swap. Every step leaves the on-disk key files and the
/// snapshot mutually recoverable, so a crash at ANY point loses no stored key
/// (load-time recovery is `open_snapshot`'s `master.key.old` retry):
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
    let _ = fs::remove_file(&new_key_staging);
    write_key_file_at(&new_key_staging, keyfile)?;

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

/// Resolve the currently open vault's records, then re-encrypt the snapshot
/// under a key derived from `password` and swap in the new verifier file.
///
/// The vault mutex is held across the ENTIRE operation — record collection,
/// the crash-safe two-phase swap, and the reload — so a concurrent
/// `store_ai_key` can neither read stale (old-key) records mid-swap nor save
/// old-key ciphertext into the swapped snapshot afterwards.
///
/// Changing an already-password-protected vault requires it to be unlocked
/// first (call [`unlock_vault`] with the current password), then this command
/// with the new one.
#[tauri::command]
pub fn set_master_password(app: tauri::AppHandle, password: String) -> Result<(), String> {
    validate_password(&password)?;
    let snapshot_path = stronghold_path(&app)?;
    let key_path = master_key_path(&app)?;

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
        let (snapshot, key_file, key_state) = default_init(&app)?;
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
        *guard = Some(open_snapshot(&snapshot, &key_file, master_key.to_vec())?);
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
    if let Err(e) = reencrypt_vault(&snapshot_path, &key_path, &new_key, &keyfile, &records) {
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
/// If the snapshot still decrypts under the previous password (a crash midway
/// through [`set_master_password`]), the `master.key.old` backup salt + verifier
/// is tried before giving up, so the recovery path works with the old password.
#[tauri::command]
pub fn unlock_vault(app: tauri::AppHandle, password: String) -> Result<(), String> {
    validate_password(&password)?;
    let state = app.state::<KeyVault>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    let snapshot_path = stronghold_path(&app)?;
    let key_path = master_key_path(&app)?;

    // Collect the candidate (salt, verifier) pairs: the current key file, and
    // the `.old` backup if it is a password-protected one (crash recovery).
    let mut candidates: Vec<(PathBuf, [u8; 32], [u8; 32])> = Vec::new();
    if let VaultKeyState::Locked { salt, verifier } = read_vault_key_state(&key_path)? {
        candidates.push((snapshot_path.clone(), salt, verifier));
    } else {
        return Err("no master password is set".into());
    }
    let backup_path = sibling_suffixed(&key_path, "old");
    if let Ok(VaultKeyState::Locked { salt, verifier }) = read_vault_key_state(&backup_path) {
        candidates.push((snapshot_path.clone(), salt, verifier));
    }

    let mut last_err = "incorrect master password".to_string();
    for (snapshot, salt, verifier) in candidates {
        let derived = match derive_master_key(&password, &salt) {
            Ok(k) => k,
            Err(e) => {
                last_err = e;
                continue;
            }
        };
        if verifier_of(&derived) != verifier {
            continue;
        }
        if let Ok(stronghold) = Stronghold::new(snapshot, derived.to_vec()) {
            *guard = Some(stronghold);
            return Ok(());
        }
        // The derived key matched the verifier but the snapshot refused it;
        // fall through and let the next candidate (the `.old` backup) try.
    }
    Err(last_err)
}
