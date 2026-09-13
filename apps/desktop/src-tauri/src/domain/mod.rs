//! Vault rules, state machines and policy — pure decisions, plus the traits the
//! storage layer implements.
//!
//! Nothing here reads or writes the disk through a concrete implementation:
//! `domain` takes the trait it needs as a parameter and `storage` supplies the
//! adapter (roadmap §10.2 module ownership, §13.11). The key-file port
//! [`key_files::KeyFileIo`] is the one the crash-safe recovery sequence uses.

pub mod key_files;
pub mod path_policy;
pub mod plugin_policy;
pub mod recovery;
pub mod vault;
