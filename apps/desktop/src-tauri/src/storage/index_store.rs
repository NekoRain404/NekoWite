//! Vault search index.
//!
//! Placeholder for a persisted search index that would let the vault be queried
//! without a full recursive walk (see [`super::file_store::search_notes`]).
//! Today the vault is small and search walks the tree at request time, so there
//! is no on-disk index to store here. A future index should be keyed by vault
//! root and stay confined to it.
