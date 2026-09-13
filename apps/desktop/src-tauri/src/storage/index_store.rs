//! Vault search index (reserved).
//!
//! The vault's persistent full-text index is owned by the FRONTEND, not by this
//! module: it is stored inside the vault at `.nekowite/index/` as sharded JSON
//! (`.nekowite/index/shard-*.json` plus `.nekowite/index.meta.json`) and is
//! written through the frontend fs gateway — see `services/searchIndex.ts` and
//! `features/vault/services/indexPersistence.ts`, which reconcile it
//! incrementally (mtime/size tokens, per-shard checksums, atomic temp+swap).
//!
//! This module is the reserved home for a future RUST-side index. Nothing here
//! reads or writes those files today, so a Rust index would be an addition
//! rather than a replacement. A future index should be keyed by vault root and
//! stay confined to it.
