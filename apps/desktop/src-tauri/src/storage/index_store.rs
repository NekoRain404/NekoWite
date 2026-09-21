//! Vault search index (reserved).
//!
//! The vault's persistent full-text index is owned by the FRONTEND, not by this
//! module: it is stored inside the vault at `.nekowite/index/` as sharded JSON
//! (the metadata record `manifest.json` plus `shard-*.json`, with `<file>.json.tmp`
//! staged siblings) and is written through the frontend fs gateway — see
//! `features/search/services/index-storage.ts` for the key-to-file mapping and
//! `index-shard-store.ts` for the incremental reconcile (mtime/size tokens,
//! per-shard checksums, commit record written last).
//!
//! This module is the reserved home for a future RUST-side index. Nothing here
//! reads or writes those files today, so a Rust index would be an addition
//! rather than a replacement. A future index should be keyed by vault root and
//! stay confined to it.
