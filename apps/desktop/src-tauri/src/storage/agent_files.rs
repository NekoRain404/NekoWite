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
//! So this adapter forwards and decides nothing. Every property a **delegated**
//! agent write needs is already in the two functions it calls — the writes this
//! adapter sees, and no others: a write the engine performs with its own tools
//! never reaches here, so none of the four below is a claim about it:
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
//!
//! The read is a DISK read: it forwards to the vault's own `read_file` and consults
//! no window's buffer, so it serves the file's saved text even while the user has
//! that note open with unsaved edits. `agent_runtime::fs_capability`'s module header
//! is where that divergence is stated in full, and this is a pointer rather than a
//! second account of it — a reader who needs the reasoning, and the one shared lookup
//! a fix would have to go through, should read it there.

use crate::agent_runtime::VaultFiles;
use crate::storage::{file_store, save_store};

/// The vault, as the agent's file capability asks for it.
pub struct AgentVaultFiles;

impl VaultFiles for AgentVaultFiles {
    fn frontend_path(&self, vault_root: &str, path: &str) -> Result<String, String> {
        // The app's own confinement, and the app's own rendering of a path for a window: the
        // same two calls `list_dir_entries` makes, which is what makes a live-note question's
        // key and an open tab's path one spelling rather than two that must be kept in step.
        let (resolved, _relative) =
            crate::domain::path_policy::resolve_within_rel(vault_root, path)?;
        Ok(crate::domain::path_policy::ipc_path(&resolved))
    }

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
