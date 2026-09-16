//! The agent's file capability, on the app's own write path.
//!
//! [`VaultFiles`] is the port `agent_runtime::fs_capability` declares; this is the
//! implementation the app supplies, and it lives here for the same reason
//! [`super::key_file_io::DiskKeyFiles`] does (roadmap §13.10: the module that owns
//! the *policy* declares the trait, the module that owns the *bytes* implements
//! it). The runtime must not reach into `storage` by absolute path — that is why
//! the trait exists at all — and it must not re-implement reading or writing for
//! the same reason.
//!
//! So this adapter forwards and decides nothing. Every property the agent's writes
//! need is already in the two functions it calls:
//!
//! - the path is resolved inside the vault (`resolve_within`), so a request that
//!   escapes the root is refused rather than performed;
//! - the write takes the crate's one write lock, so an agent's save cannot
//!   interleave with a restore or a rename;
//! - it refuses a destination the user made read-only, and reports the history
//!   snapshot's failure as a warning rather than as a failed save;
//! - and it snapshots history, which is what makes an agent's edit reversible with
//!   the same button as the user's own.
//!
//! A second path to the filesystem would silently discard all four, which is what
//! T2b's §8.1 warning is about: 「直接访问文件系统会静默丢弃限制、写锁与历史」.

use crate::agent_runtime::VaultFiles;
use crate::storage::{file_store, save_store};

/// The vault, as the agent's file capability asks for it.
pub struct AgentVaultFiles;

impl VaultFiles for AgentVaultFiles {
    fn read(&self, vault_root: &str, path: &str) -> Result<String, String> {
        file_store::read_file(vault_root, path)
    }

    fn write(&self, vault_root: &str, path: &str, content: &str) -> Result<Option<String>, String> {
        // `None` for `max_history` is the same default the editor's own saves get when the caller
        // does not cap it (`history_snapshot::DEFAULT_MAX_HISTORY`). An agent's writes carry no
        // policy of their own: which versions of a note survive is the vault's rule, and a second
        // one here would mean two answers to it.
        save_store::write_file(vault_root, path, content, None)
    }
}
