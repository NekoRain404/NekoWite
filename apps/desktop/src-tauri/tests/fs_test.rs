//! The filesystem surface of the backend: reading and stat, listing, creating and writing, the
//! version history, the trash and the key encoding behind it, rename, the attachment paths (paste
//! and picker), the media resolver, the watcher filter, the path policy, and the error text a
//! storage failure turns into.
//!
//! This target outgrew a single file (80 cases, 2460 lines), so its cases are divided by behaviour
//! domain into the modules below. The seams are the section headings and the doc comments the file
//! already carried, not a line count. They stay one cargo target: `cargo test --test fs_test`
//! still collects every one of them, because a test in a file nobody runs is not evidence.
//!
//! Each module is reached through `#[path]` rather than a bare `mod name;`. A `mod` declared in a
//! crate root resolves to `tests/name.rs` — rustc treats a crate root like `mod.rs`, so its
//! submodules sit BESIDE it, not in `fs_test/` — which would both miss this directory and leave
//! fourteen loose `tests/*.rs` files for cargo to discover as targets of their own. The
//! directory holds behaviour modules, not targets, and there is no `main.rs` in it.
//!
//! Fixtures more than one domain needs live in [`support`].

#[path = "fs_test/attachment_import.rs"]
mod attachment_import;
#[path = "fs_test/attachment_save.rs"]
mod attachment_save;
#[path = "fs_test/history.rs"]
mod history;
#[path = "fs_test/list_dir.rs"]
mod list_dir;
#[path = "fs_test/media.rs"]
mod media;
#[path = "fs_test/path_policy.rs"]
mod path_policy;
#[path = "fs_test/read_stat.rs"]
mod read_stat;
#[path = "fs_test/rename.rs"]
mod rename;
#[path = "fs_test/storage_errors.rs"]
mod storage_errors;
#[path = "fs_test/support.rs"]
mod support;
#[path = "fs_test/trash.rs"]
mod trash;
#[path = "fs_test/trash_keys.rs"]
mod trash_keys;
#[path = "fs_test/watcher.rs"]
mod watcher;
#[path = "fs_test/write.rs"]
mod write;
