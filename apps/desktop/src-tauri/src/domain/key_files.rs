//! The vault's key files as the domain sees them: the names the crash-safe
//! swap gives them, the state a file holds, and the port through which the
//! recovery sequence reaches them.
//!
//! The *names* and the *decoded state* live here because [`super::recovery`]
//! has to reason about them: which name a rotated backup may take, and whether
//! a key file can open the snapshot directly. The *behaviour* behind
//! [`KeyFileIo`] — the key-file format, the fsync, the mode bits — is
//! persistence, so it stays in the storage layer and is passed in by the
//! caller: `domain` receives the trait, `storage` implements it, and nothing
//! here names a concrete implementation (roadmap §10.2 module ownership,
//! §13.10 trait direction, §13.11).

use std::path::{Path, PathBuf};

/// What an on-disk `master.key` actually holds. It NEVER holds a raw
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

/// Scratch path used while re-encrypting the snapshot (see
/// [`super::recovery::open_snapshot`]/re-encryption).
pub fn stronghold_tmp_path(snapshot: &Path) -> PathBuf {
    let mut p = snapshot.to_path_buf();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "stronghold.bin".to_string());
    p.set_file_name(format!(".{name}.tmp"));
    p
}

/// The key-file operations the crash-safe swap needs, declared here and
/// implemented by the storage layer.
///
/// The swap's *ordering* is domain policy (see [`super::recovery`]); reading
/// and writing the files is persistence, so the sequence reaches them through
/// this port rather than through a concrete implementation it imports. The
/// caller passes the adapter it wants — the on-disk one in production, a
/// recording or failing fake in a test that drives a step of the swap — which
/// is what keeps `domain` free of the key-file format (roadmap §10.1, §13.10).
pub trait KeyFileIo {
    /// Read what the key file at `path` holds.
    ///
    /// The implementation may CREATE a missing file (a fresh passwordless key),
    /// so callers pass only paths whose file they know is there:
    /// [`super::recovery::backup_key_paths`] lists existing files for exactly
    /// that reason, and the unlock path re-checks `exists()` before reading —
    /// a forged `master.key.old` that opens nothing is what that check stops.
    fn read_key_state(&self, path: &Path) -> Result<VaultKeyState, String>;

    /// Write `bytes` to `path` durably. Nobody but the owner may be able to
    /// read the file, and the bytes have to be on stable storage before this
    /// returns: the swap renames over `path` immediately afterwards, and a
    /// crash that loses them leaves the vault without a key.
    fn write_key_file(&self, path: &Path, bytes: &[u8]) -> Result<(), String>;

    /// Flush `path`'s data to stable storage. Stronghold's `save()` does not
    /// fsync, so the swap flushes the rebuilt snapshot before the rename that
    /// makes it the live one.
    fn fsync_file(&self, path: &Path) -> Result<(), String>;

    /// Restrict `path` to its owner (mode 0600 on unix). A rename does not
    /// change the mode, so this is what gives the live snapshot its
    /// permissions.
    fn tighten_perms(&self, path: &Path) -> Result<(), String>;
}
