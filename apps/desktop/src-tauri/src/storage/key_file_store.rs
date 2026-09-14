//! The master key file end to end: its format, the KDF behind a master
//! password, the state the vault's key material is in, and the one place a
//! missing file becomes a fresh key.
//!
//! Split out of [`super::key_store`] (roadmap §13.1 — that file was over the
//! 400-line budget, and this is the vertical slice the key-file work belongs to
//! rather than a horizontal chop, §13.3). `key_store` re-exports every public
//! name here, so callers and tests that import them from the key store keep
//! resolving.
//!
//! The policy this module exists for is how a **missing** file is read. See
//! [`read_vault_key_state`]: a missing `master.key` is a first run only when
//! nothing is beside it.
//!
//! The crash-safe sequence that *moves* these files lives in
//! [`crate::domain::recovery`]; this module only says what they hold.

use std::fs;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use crate::domain::key_files::VaultKeyState;
use crate::domain::path_policy::ipc_path;
use crate::domain::recovery::backup_key_paths;
use crate::errors::fs_error;

/// Key-file format version byte.
const KEYFILE_VERSION: u8 = 1;
/// Mode byte: 0 = passwordless (raw key), 1 = password (salt + verifier).
const MODE_PASSWORDLESS: u8 = 0;
const MODE_PASSWORD: u8 = 1;

/// Length of a legacy key file: the bare 32-byte key, with no version/mode
/// header. Accepted on read and rewritten in the current format (see
/// [`read_vault_key_state`]).
const LEGACY_KEYFILE_LEN: usize = 32;

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
    // A bare key with no envelope, as written by builds that predate the
    // versioned format. The 32 bytes ARE the Stronghold key, so reading it is
    // not a guess — and rejecting it (what the length check below did) locked a
    // perfectly good vault out of its own key with "invalid length 32".
    // `read_vault_key_state` rewrites such a file in the current format.
    //
    // The length alone is NOT enough to call it legacy. A *versioned* file cut
    // short to 32 bytes — `[01, 01, salt[0..30]]`, what a truncated restore or
    // an interrupted copy leaves — has the same length, and 32 bytes are also
    // what the upgrade path writes back. Accepting one would therefore destroy
    // the salt and verifier it still held and rewrite the file over them,
    // leaving the snapshot permanently undecryptable (`reencrypt_vault` deletes
    // `master.key.old`, so the load-time fallback cannot help either). Rejecting
    // it keeps the old, recoverable behaviour: a clear error and the file left
    // untouched for the user to restore.
    //
    // A genuine legacy key is random, so it carries a valid version+mode prefix
    // about once in 65536 — the discriminator costs essentially nothing.
    if bytes.len() == LEGACY_KEYFILE_LEN {
        let truncated_header =
            bytes[0] == KEYFILE_VERSION && matches!(bytes[1], MODE_PASSWORDLESS | MODE_PASSWORD);
        if !truncated_header {
            let mut key = [0u8; 32];
            key.copy_from_slice(bytes);
            return Ok(VaultKeyState::Auto(key));
        }
    }
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
// Writing a key file.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Reading a key file, and what a missing one means.
// ---------------------------------------------------------------------------

/// Read a master key file and say whether there is one. `Ok(None)` is the
/// answer a key file cannot give about itself — there is no file at `path` —
/// and it is a *different state* from a passwordless file (`Auto`).
///
/// No file is created where there was none, so the callers that must tell those
/// two states apart can: `password_candidates` builds the unlock candidates
/// from it, and [`read_vault_key_state`] uses it to decide whether a missing
/// file is a first run. A legacy bare-key file is still upgraded in place,
/// exactly as on every other read path — the 32 bytes ARE the key, so carrying
/// them over is safe.
pub fn read_existing_vault_key_state(path: &Path) -> Result<Option<VaultKeyState>, String> {
    match fs::read(path) {
        Ok(bytes) => {
            let state = decode_keyfile(&bytes)?;
            if bytes.len() == LEGACY_KEYFILE_LEN {
                if let VaultKeyState::Auto(key) = &state {
                    // Best effort: a read-only key file must not stop the vault
                    // from opening, and the next read simply tries again.
                    let _ = write_keyfile(path, &encode_keyfile_passwordless(key));
                }
            }
            Ok(Some(state))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(fs_error("read the master key file", path, e)),
    }
}

/// Read a master key file and return its [`VaultKeyState`].
///
/// **A missing file is a first run only when there is nothing beside it**: then
/// a fresh random passwordless key is generated and persisted (mode `0600`),
/// which is what makes a fresh install work.
///
/// A missing file with a key backup beside it is NOT that. It is the state the
/// two-phase swap in [`crate::domain::recovery::reencrypt_vault`] leaves when
/// the process dies between its two renames: the backup is the key that opens
/// the live snapshot, and for a password-protected vault it is also the only
/// place the password's salt and verifier are left. Creating a passwordless key
/// there answered "this vault has no password" over a vault that has one — the
/// unlock then returned "no master password is set" *before* reaching the loop
/// written to read that backup, and the forged file shadowed it for every later
/// reader. So the state comes from the backups instead: the first one that
/// opens the snapshot without a password, else the first password-protected one
/// (`Locked`, which is what makes the load path report the vault as locked and
/// send the user to the unlock).
///
/// Every other outcome is unchanged: a damaged key file is an error, never
/// silently overwritten, and wrong lengths/modes are rejected by
/// [`decode_keyfile`]. A legacy bare-key file is upgraded on first read, with
/// the 32 key bytes carried over verbatim, so the Stronghold key is unchanged
/// and the rewrite cannot lose anything.
pub fn read_vault_key_state(path: &Path) -> Result<VaultKeyState, String> {
    let Some(state) = read_existing_vault_key_state(path)? else {
        return missing_key_file_state(path);
    };
    Ok(state)
}

/// What a vault with no `master.key` at all is: a genuine first run, or the
/// interrupted-swap state seen from the other side.
fn missing_key_file_state(path: &Path) -> Result<VaultKeyState, String> {
    if let Some(state) = state_from_backups(path) {
        return Ok(state);
    }
    if backup_key_paths(path).is_empty() {
        return create_first_run_keyfile(path);
    }
    // Backups are there and none of them could be read: the vault's key
    // material is unreadable, which is an error rather than a reason to invent
    // a new key over what the user may still be able to restore.
    Err(format!(
        "the master key file {} is missing and the key backups beside it could not be read",
        ipc_path(path)
    ))
}

/// The state the backups beside a missing `master.key` put the vault in, in the
/// order recovery searches them ([`backup_key_paths`]: the canonical
/// `master.key.old` slot first, then the backups a swap rotated out of it,
/// newest first).
///
/// A passwordless backup is the answer as soon as one is readable: it opens the
/// live snapshot without a password, so that vault is not locked and the load
/// path must open it. Only when every readable backup is password-protected is
/// the vault locked — and `Locked` is what makes the load path say so instead
/// of trying a key it does not have. (`open_snapshot` still retries every backup
/// by itself, so picking the first one here can only save the wasted attempt,
/// never change which key the vault ends up open with.)
///
/// `None` means no backup could be read at all: none there, or all malformed.
fn state_from_backups(key_path: &Path) -> Option<VaultKeyState> {
    let mut locked = None;
    for backup in backup_key_paths(key_path) {
        match read_existing_vault_key_state(&backup) {
            Ok(Some(state @ VaultKeyState::Auto(_))) => return Some(state),
            Ok(Some(state @ VaultKeyState::Locked { .. })) => locked = locked.or(Some(state)),
            // Unreadable or malformed: the load-time search skips these too.
            _ => continue,
        }
    }
    locked
}

/// First run: no key file and nothing beside it that recovery could use. This
/// is the ONLY place a missing key file is answered by creating one, and
/// `tests/keys_test.rs::master_key_created_and_reused` pins it.
fn create_first_run_keyfile(path: &Path) -> Result<VaultKeyState, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| fs_error("create the folder containing", parent, e))?;
    }
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).map_err(|e| e.to_string())?;
    write_keyfile(path, &encode_keyfile_passwordless(&key))?;
    Ok(VaultKeyState::Auto(key))
}

/// Create/read a master key and return its raw 32 bytes, ONLY for the
/// passwordless case. If a master password is set the vault is locked and an
/// error is returned (call `unlock_vault`); the raw key is never revealed.
///
/// Only a missing file with no key backup beside it (`ErrorKind::NotFound`)
/// triggers generation; any other read failure (EIO, permission denied, …) is
/// propagated so a damaged key is never silently overwritten. A file that is
/// malformed is likewise an error.
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

/// Reject an empty master password.
pub fn validate_password(password: &str) -> Result<(), String> {
    if password.trim().is_empty() {
        return Err("password cannot be empty".into());
    }
    Ok(())
}
