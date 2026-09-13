//! The on-disk adapter for the key-file port the recovery sequence uses.
//!
//! [`crate::domain::recovery`] owns the crash-safe swap and the order of its
//! steps; the key-file format, the fsync and the mode bits are persistence, so
//! they live here and the domain reaches them only through
//! [`KeyFileIo`] (roadmap §13.10: `domain` receives the trait, `storage`
//! implements it). This adapter is a thin forwarder on purpose: the format and
//! the permission bits keep their single implementation in
//! [`crate::storage::key_store`], because a second copy of either would let the
//! two drift and silently break a vault that one of them still opens.

use std::path::Path;

use crate::domain::key_files::{KeyFileIo, VaultKeyState};
use crate::storage::key_store;

/// The vault's key files as they exist on disk: the implementation a caller
/// passes to `domain::recovery::{open_snapshot, reencrypt_vault}`.
pub struct DiskKeyFiles;

impl KeyFileIo for DiskKeyFiles {
    fn read_key_state(&self, path: &Path) -> Result<VaultKeyState, String> {
        key_store::read_vault_key_state(path)
    }

    fn write_key_file(&self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        key_store::write_key_file_at(path, bytes)
    }

    fn fsync_file(&self, path: &Path) -> Result<(), String> {
        key_store::fsync_file(path)
    }

    fn tighten_perms(&self, path: &Path) -> Result<(), String> {
        key_store::tighten_snapshot_perms(path)
    }
}
