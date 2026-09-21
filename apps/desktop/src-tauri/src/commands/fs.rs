//! Filesystem commands: the `#[tauri::command]` IPC surface for vault file
//! operations, vault registration, native dialogs, the folder watcher and the
//! media grant.
//!
//! Each command deserializes its snake_case args, proves the vault was opened
//! this session, calls one storage/domain function, and maps the error. All
//! command names, request/response DTOs and error strings are unchanged from
//! the pre-split layout.
//!
//! **This file was split, and what is left of it is the seam.** It had reached
//! 713 lines against the 600-line budget `docs/dev.md:286` puts on a business
//! file, and the split is by *reason to change* — the criterion that same
//! section states — rather than by arithmetic. Six subjects came out of it,
//! each in a file of its own beside this one:
//!
//! - `files.rs` — a path inside the vault and the operation asked of it: read,
//!   stat, save, create, delete, list, rename, save_attachment and
//!   import_attachment. Changes when an operation or its refusal does.
//! - `vaults.rs` — the authority that makes a root servable: `register_vault`,
//!   what the user's pick means and what is remembered. Changes when that
//!   authority changes.
//! - `dialogs.rs` — the native choosers and each one's filter policy:
//!   `open_folder_dialog`, `save_file_dialog`, `pick_image_files`. Changes when
//!   a dialog's shape or its filter does.
//! - `media.rs` — the asset protocol's allow-set: `MEDIA_STAGING_DIR`,
//!   `asset_media_grant`, `authorized_media_grant`, `allow_media_file` and
//!   `resolve_media_path`. Security-relevant, with its reasoning verbatim;
//!   changes when the protocol's scope behaviour or a hidden-name/extension
//!   rule does.
//! - `watch.rs` — the folder watcher and its lifecycle: `watch_folder`,
//!   `emit_fs_change`, `schedule_pending_flush`. Changes when the watcher's
//!   lifecycle or `notify`'s callback shape does.
//! - `coalescing.rs` — the burst bookkeeping the watcher decides with:
//!   `COALESCE_WINDOW`, `should_emit_change`, `PendingBurst`,
//!   `take_settled_pending`, and the tests that pin them. Pure, so it changes
//!   when the coalescing rule does.
//!
//! **Why the commands are re-exported rather than left where they now live.**
//! `lib.rs`'s `generate_handler!` names each one as `commands::fs::<name>`,
//! `build.rs`'s `COMMANDS` and the capability files hold the bare names, and
//! two test targets import `commands::fs::{…}`. Those paths are part of this
//! module's contract, so every command moved out is re-exported below together
//! with the two macros `#[tauri::command]` emits beside it. That last part is
//! not tidiness: `generate_handler!` builds its path by renaming only the *last*
//! segment of the path written in `lib.rs`, so a command that moved without its
//! `__cmd__*` and `__tauri_command_name_*` macros leaves that handler list
//! failing to compile while the command itself still resolves — the one failure
//! mode a re-export exists to prevent. They are `#[macro_export]`, which is what
//! makes the `pub use` of a macro legal in the first place.
//!
//! Registering a handler is `lib.rs`'s line and not this file's: a command added
//! to that handler list, to `build.rs`'s `COMMANDS` or to a capability file is
//! reported to whoever owns those lists rather than appended to them from here.

// The children are declared in an inline module carrying `#[path]`, and NOT as bare
// `mod <name>;` here, because of how rustc resolves a file reached through `#[path]`.
//
// `tests/save_precondition_ipc_test.rs` compiles this file with
// `#[path = "../src/commands/fs.rs"] mod fs_commands;` so that its `generate_handler!` can register
// the real commands. rustc resolves a `#[path]`-included file's own children against **the
// directory of the file that declared it** — the test root — not against this file's stem
// directory: a bare `mod files;` here is looked for at `src/commands/files.rs`, not at
// `src/commands/fs/files.rs`, and the target fails with six `E0583`s. rustfmt disagrees with rustc
// about the rule and reports the same six modules as unresolvable from
// `src/commands/coalescing.rs`, which broke `cargo fmt --all --check` the same way.
//
// An inline module whose `#[path]` names the directory relative to *this* file resolves in both
// readers, and in the library build, because the value is interpreted from the file that carries
// the attribute. The alternative — editing `save_precondition_ipc_test.rs` — was not this task's
// to make. `tests/module_tree_test.rs` still reaches every child: it honours a `#[path]` written
// under `src/`, and the bare `mod <name>;` declarations below are resolved against the directory
// this attribute names, which is where rustfmt and rustc look too.
//
// The path is on the module rather than on each `mod <name>;` on purpose: a `#[path]` string
// literal is deleted by `module_tree_test.rs`'s comment stripper, which would leave the children
// reported as orphans.
#[path = "fs"]
mod children {
    pub(super) mod coalescing;
    pub(super) mod dialogs;
    pub(super) mod files;
    pub(super) mod media;
    pub(super) mod vaults;
    pub(super) mod watch;
}

// The child modules are private and their items are `pub`: reachable only through these re-exports,
// which are the one spelling `lib.rs`'s handler list, `build.rs`'s `COMMANDS` and the test targets
// already use. A `pub` item in a private module is still `pub` for the purpose of `pub use`, so the
// re-export is what makes `commands::fs::<name>` reachable from outside the library while the
// module itself stays an implementation detail.
//
// `allow(unused_imports)`, for the reason `agent_runtime/process.rs` gives about its own
// re-exports: a test target that `#[path]`-includes this tree compiles these files into its own
// crate, where the commands the library's handler list reaches are called by nothing — so the
// re-export of a command that only `lib.rs` names reads as unused there while it is the whole point
// here. The attribute keeps the paths resolving without moving a pre-existing warning into a new
// file.
#[allow(unused_imports)]
pub use children::dialogs::{
    __cmd__open_folder_dialog, __cmd__pick_image_files, __cmd__save_file_dialog,
    __tauri_command_name_open_folder_dialog, __tauri_command_name_pick_image_files,
    __tauri_command_name_save_file_dialog, open_folder_dialog, pick_image_files, save_file_dialog,
};
#[allow(unused_imports)]
pub use children::files::{
    __cmd__create_dir, __cmd__create_new_file, __cmd__delete_file, __cmd__import_attachment,
    __cmd__list_dir, __cmd__read_file, __cmd__rename_entry, __cmd__save_attachment,
    __cmd__stat_file, __cmd__write_file, __tauri_command_name_create_dir,
    __tauri_command_name_create_new_file, __tauri_command_name_delete_file,
    __tauri_command_name_import_attachment, __tauri_command_name_list_dir,
    __tauri_command_name_read_file, __tauri_command_name_rename_entry,
    __tauri_command_name_save_attachment, __tauri_command_name_stat_file,
    __tauri_command_name_write_file, create_dir, create_new_file, delete_file, import_attachment,
    list_dir, read_file, rename_entry, save_attachment, stat_file, write_file,
};
#[allow(unused_imports)]
pub use children::media::{
    __cmd__resolve_media_path, __tauri_command_name_resolve_media_path, asset_media_grant,
    authorized_media_grant, resolve_media_path,
};
#[allow(unused_imports)]
pub use children::vaults::{
    __cmd__register_vault, __tauri_command_name_register_vault, register_vault,
};
#[allow(unused_imports)]
pub use children::watch::{__cmd__watch_folder, __tauri_command_name_watch_folder, watch_folder};
