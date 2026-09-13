//! The vault storage layer, split by responsibility.
//!
//! Dependency direction is one-way, from the facade down to the leaf:
//!
//! ```text
//! file_store       facade: vault-facing base IO, and the public surface
//!   +- rename_store      <- metadata_store, trash_store, atomic_write
//!   +- attachment_store  <- atomic_write
//!   +- metadata_store    <- atomic_write, temp_files
//!   +- atomic_write      <- temp_files
//!   +- temp_files        (leaf: what a temp file is called, and sweeping it)
//! ```
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
//! `domain::recovery` declares. That direction is the point: the crash-safe
//! swap is domain policy, so the domain takes the trait and storage supplies
//! the implementation, never the other way round.

pub mod atomic_write;
pub mod attachment_store;
pub mod file_store;
pub mod index_store;
pub mod key_file_io;
pub mod key_store;
pub mod metadata_store;
pub mod rename_store;
pub mod temp_files;
pub mod trash_store;
