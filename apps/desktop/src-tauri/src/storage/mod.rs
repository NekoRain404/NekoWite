//! The vault storage layer, split by responsibility.
//!
//! Dependency direction is one-way, from the facade down to the leaf:
//!
//! ```text
//! file_store       facade: vault-facing base IO, and the public surface
//!   +- save_store        <- history_snapshot, atomic_write, temp_files
//!   +- rename_store      <- metadata_store, trash_store, atomic_write
//!   +- attachment_store  <- atomic_write
//!   +- metadata_store    <- history_snapshot, atomic_write
//!   +- history_snapshot  <- atomic_write, temp_files, history_prune
//!   +- trash_store       <- trash_clear, trash_restore, path_policy
//!   +- atomic_write      <- temp_files, destination_file
//!   +- temp_files        (leaf: what a temp file is called, and sweeping it)
//!   +- destination_file  (leaf: what a publish carries over from the file it
//!                         replaces, and whether it may replace it at all)
//!   +- history_prune     (leaf: the retention rule — which stored version is
//!                         the oldest, and dropping the ones past `max`)
//!   +- trash_clear       (leaf: emptying the trash, and reporting a pass that
//!                         destroyed some of it)
//!   +- trash_restore     (leaf: putting one entry back, claiming a destination
//!                         that may already be taken)
//! ```
//!
//! `metadata_store` is the history KEY (which directory a vault path maps to,
//! and the listing/reading/restoring a panel asks for) and `history_snapshot`
//! is the history FILE (how one version is named, staged, settled), with the
//! RETENTION rule in `history_prune`. The seam is there because the eviction
//! belongs to a version's lifecycle and only the caller that staged one knows
//! whether the save it belongs to happened; and the retention rule is one step
//! further out because its ordering policy — a same-millisecond group sorted by
//! name keeps the WRONG version — is a data-loss defect on its own.
//!
//! `trash_store` is the trash as a place things go (delete, list, follow a
//! rename); `trash_clear` and `trash_restore` are the two verbs that are each a
//! policy of their own.
//!
//! `file_store` re-exports what the split moved out, so the command layer and
//! the integration tests keep their `file_store::{...}` imports unchanged for
//! this stage (roadmap 10.4: thin forwarders). Nothing below the facade imports
//! it back.
//!
//! [`atomic_write::write_lock`] is the crate's ONLY write lock. The save, the
//! create-only writes, the history restore and the rename all wait on that one
//! mutex, which is why it is defined once (in `atomic_write`) and handed out by
//! reference instead of being declared per module: separate locks would each
//! look correct on their own and still let two writers snapshot each other's
//! predecessor.
//!
//! [`key_file_io::DiskKeyFiles`] adapts the key files for the port
//! `domain::recovery` declares, and [`agent_files::AgentVaultFiles`] does the
//! same for the one `agent_runtime::fs_capability` declares. That direction is
//! the point: the crash-safe swap, and the agent's confinement and history, are
//! policies of the modules that declare the traits, so those take the trait and
//! storage supplies the implementation, never the other way round.
//!
//! [`key_file_store`] is the master key file itself — format, KDF, and the
//! state a missing file puts the vault in — and [`key_store`] is the vault
//! lifecycle it opens plus the provider-key store, re-exporting the file half
//! so no consumer of the key store had to move with the split.

pub mod agent_files;
pub mod atomic_write;
pub mod attachment_store;
pub mod destination_file;
pub mod file_store;
pub mod history_prune;
pub mod history_snapshot;
pub mod index_store;
pub mod key_file_io;
pub mod key_file_store;
pub mod key_store;
pub mod metadata_store;
pub mod rename_store;
pub mod save_store;
pub mod temp_files;
pub mod trash_clear;
pub mod trash_restore;
pub mod trash_store;
