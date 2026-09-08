//! Plugin-host path policy.
//!
//! Placeholder for the confinement rules that would govern which paths a
//! third-party plugin is allowed to read/write on the host vault. Today the
//! vault's plugin contract lives in the frontend plugin host, so no Rust
//! policy exists yet; a future plugin sandbox should route its path checks
//! through [`super::path_policy`] so there remains a single implementation of
//! "is this path inside the vault?".
