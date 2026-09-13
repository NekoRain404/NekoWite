//! Secure key store: the master-key file format, the Argon2id KDF, and the
//! stronghold-backed provider-key store.
//!
//! This is the on-disk and in-memory boundary for key material. The crash-safe
//! recovery/re-encryption sequence lives in [`crate::domain::recovery`];
//! the `#[tauri::command]` entry points that drive it live in
//! [`crate::commands::keys`]. Nothing here ever discloses a real API key to the
//! window.

use std::fs;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use tauri::Manager;
use tauri_plugin_stronghold::stronghold::Stronghold;

use crate::domain::recovery::open_snapshot;
use crate::errors::fs_error;
use crate::state::KeyVault;

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
        return Err(
            "this is the masked placeholder, not an API key: re-enter the key".into(),
        );
    }
    Ok(())
}

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

/// Scratch path used while re-encrypting the snapshot (see
/// [`open_snapshot`]/re-encryption).
pub fn stronghold_tmp_path(snapshot: &Path) -> PathBuf {
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
pub fn sibling_suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut p = path.to_path_buf();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    p.set_file_name(format!("{name}.{suffix}"));
    p
}

// ---------------------------------------------------------------------------
// Key-file (de)serialization + master-key derivation.
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

// ---------------------------------------------------------------------------
// Reading / writing the master key file.
// ---------------------------------------------------------------------------

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
                fs::create_dir_all(parent)
                    .map_err(|e| fs_error("create the folder containing", parent, e))?;
            }
            let mut key = [0u8; 32];
            getrandom::getrandom(&mut key).map_err(|e| e.to_string())?;
            write_keyfile(path, &encode_keyfile_passwordless(&key))?;
            Ok(VaultKeyState::Auto(key))
        }
        Err(e) => Err(fs_error("read the master key file", path, e)),
    }
}

/// Write `bytes` directly to `path` (creating parent dirs), forcing mode
/// `0600` on unix, and fsync the contents. Does not rename — callers that need
/// atomicity wrap this with a temp sibling (see [`write_keyfile`]) or a
/// rename sequence (see `reencrypt_vault`).
pub fn write_key_file_at(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| fs_error("create the folder containing", parent, e))?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut f = options
        .open(path)
        .map_err(|e| fs_error("open the master key file", path, e))?;
    f.write_all(bytes)
        .map_err(|e| fs_error("write the master key file", path, e))?;
    f.sync_all()
        .map_err(|e| fs_error("flush the master key file", path, e))?;
    Ok(())
}

/// Overwrite `path` with `bytes`, forcing mode `0600` (unix). Written atomically
/// via a temp sibling + fsync + rename so a partial write can never leave a
/// corrupt key file. Used by [`read_vault_key_state`] on first creation;
/// `reencrypt_vault` stages the new key at `master.key.new` instead.
fn write_keyfile(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = sibling_tmp(path);
    write_key_file_at(&tmp, bytes)?;
    fs::rename(&tmp, path).map_err(|e| fs_error("replace the master key file", path, e))
}

/// Flush an existing file's data to stable storage. Stronghold's `save()` does
/// not fsync, so the re-encryption path does it explicitly before any rename
/// makes the temp snapshot the live one.
pub fn fsync_file(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|e| fs_error("flush", path, e))
}

/// Create/read a master key and return its raw 32 bytes, ONLY for the
/// passwordless case. If a master password is set the vault is locked and an
/// error is returned (call `unlock_vault`); the raw key is never revealed.
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
        VaultKeyState::Locked { .. } => {
            Err("master key is password-protected; the vault is locked (call unlock_vault)".into())
        }
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
            &snapshot_path,
            &key_path,
            master_key.to_vec(),
        )?);
    }
    let stronghold = guard.as_ref().expect("open_vault guarantees a stronghold");
    f(stronghold)
}

/// Init source that auto-generates/reads the master key file.
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
