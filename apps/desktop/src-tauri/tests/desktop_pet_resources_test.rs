//! R4 — imported characters: what a pack may contain, and what the library is once it does (§8).
//!
//! §8 is the one part of the plan that takes files from outside the app and turns them into things
//! the app draws, so the cases below are written against the four ways that goes wrong rather than
//! against the happy path:
//!
//! - **Transaction.** An import that fails halfway must leave neither a broken character nor a
//!   half-written one. Asserting that against a comment is impossible, so what is asserted is the
//!   *shape*: a refused import leaves the library exactly as it was, down to the directory
//!   listing, and the staging name it used is gone. The failure is reached from the outside —
//!   a pack with one bad file after several good ones, an install whose sheet is too large, a
//!   second install over the same id — and never by calling an internal step.
//! - **Security.** An imported resource is untrusted content, which is why the refusals here are
//!   about *paths* rather than about pixels: a symlink, a subdirectory, a name with a separator,
//!   an archive, a document, a file whose type cannot be established. Each has a case, and the
//!   strongest of them is the one that never reaches a check — a character id of `..` cannot name
//!   a directory because the id is validated as a component, and a pack cannot point outside
//!   itself because nothing here ever joins a pack name onto a path.
//! - **Cache.** A cache that can disagree with its source without either being wrong is a bug
//!   generator, so the rule is written down and tested: the manifest says what a character should
//!   be, the directory says what it is, and a disagreement is reported as a state — `incomplete`,
//!   `resized` — rather than resolved. The case that proves a changed source is *seen* edits an
//!   installed file and reads the library again.
//! - **Offline.** Nothing in the module reaches the network, and the one thing that would —
//!   the online catalogue — has no endpoint. The case for that is not a comment: it is that
//!   `remote_fetch_plan` refuses every URL with `NotConfigured`, and that the library reads
//!   correctly with nothing configured at all.
//!
//! The cases are divided by behaviour domain rather than kept in one file (§13.1's rule for a test
//! that outgrows a page): `imports` for the transaction, `security` for what a pack may not carry,
//! `cache` for the manifest-against-directory rule, `confinement` for what a manifest on disk may
//! name when the library reads it back, `removal` for the one deletion this module performs, and
//! `offline` for §8's network half. They are one target and one command —
//! `cargo test --test desktop_pet_resources_test` — because a test in a file nobody runs is not
//! evidence.
//!
//! Module inclusion: `desktop_pet/mod.rs` does not declare `resources` — that registration is the
//! integrator's serialized change, and D12 holds `mod.rs` — so the tree is declared here by path,
//! the convention `desktop_pet_ipc_test.rs` established. `resources::library` uses two functions
//! from `storage::atomic_write`, and this root reaches them through the library rather than by
//! compiling a second copy of the storage tree: a copy would be a second implementation of the
//! publish this module's transaction is built on, and the rule under test would stop being the
//! rule the app runs.

// The crate's own publish path, compiled from the same sources the library compiles — the six
// files `storage::atomic_write` is built from and nothing else of `storage`. It is here rather
// than reached through `nekowite_lib` because `move_no_clobber` is `pub(crate)`: the transaction's
// commit point is that function, and a test that used a different one would be testing a different
// transaction. `agent_settings_ipc_test.rs` declares its tree for the same reason.
#[path = "../src/errors.rs"]
mod errors;
// Only the paths `storage::atomic_write` reaches are live in this crate; the rest of these two
// trees is reported as dead rather than being dead, the same note `agent_settings_ipc_test.rs`
// carries.
#[path = "../src/domain"]
#[allow(dead_code, unused_imports)]
mod domain {
    pub mod app_owned;
    pub mod path_encoding;
    pub mod path_policy;
}
#[path = "../src/storage"]
#[allow(dead_code)]
mod storage {
    pub mod atomic_write;
    pub mod destination_file;
    pub mod temp_files;
}

#[path = "../src/desktop_pet"]
mod desktop_pet {
    pub mod resources;
}

// `#[path]` rather than a bare `mod`, because this target's root is `tests/desktop_pet_resources_test.rs`
// and a plain `mod cache;` would resolve to `tests/cache.rs` — a file cargo would then discover as
// a *target of its own*, five of them, none of which compiles alone. The directory holds
// behaviour, not targets, and there is deliberately no `main.rs` in it.
#[path = "desktop_pet_resources_test/cache.rs"]
mod cache;

#[path = "desktop_pet_resources_test/catalogue.rs"]
mod catalogue;
#[path = "desktop_pet_resources_test/confinement.rs"]
mod confinement;
#[path = "desktop_pet_resources_test/imports.rs"]
mod imports;
#[path = "desktop_pet_resources_test/offline.rs"]
mod offline;
#[path = "desktop_pet_resources_test/removal.rs"]
mod removal;
#[path = "desktop_pet_resources_test/security.rs"]
mod security;
#[path = "desktop_pet_resources_test/support.rs"]
mod support;
