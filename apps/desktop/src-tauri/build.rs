//! The ACL's app manifest: which commands exist, and therefore which window may reach them.
//!
//! `tauri_build::build()` alone declares nothing, and a custom `#[tauri::command]` that nothing
//! declares has no permission to grant or refuse — so every window could invoke it, the pet's
//! included. That was this tree's state: `capabilities/desktop-pet.json` scoped the pet to two
//! `core:event` permissions and governed none of our own commands, because there were none of
//! ours for it to govern. §7.1 asks for the other thing — 「后端 IPC 验证调用窗口身份」 — and the
//! note beside it says the capability file cannot be the whole of it. It cannot, because a
//! capability file can only hand out permissions, and an undeclared command has none.
//!
//! Declaring the commands below is what makes Tauri itself the check. `tauri-build` autogenerates
//! an `allow-<command>` / `deny-<command>` permission for each name, `tauri-build`'s ACL
//! validation refuses to build a capability that names a permission which does not exist, and
//! `Webview::on_message` consults `RuntimeAuthority::resolve_access` for **every** app command as
//! soon as an app manifest exists — refusing before the command runs, with a message that names
//! the window that was refused and the windows that would have been allowed. So the policy itself
//! is written where Tauri already keeps it, per window:
//!
//! | Window | Capability | May call |
//! | --- | --- | --- |
//! | `main` | `capabilities/default.json` | all sixty-five below, except the two that are the pet window's own |
//! | `pet-*` | `capabilities/desktop-pet.json` | `desktop_pet_state`, `desktop_pet_set_visible`, `desktop_pet_close_own`, `desktop_pet_set_click_through`, `desktop_pet_open_settings`, `desktop_pet_tasks`, `desktop_pet_appearance`, `desktop_pet_open_task`, and the two `core:event` permissions it already held |
//!
//! Two consequences worth knowing before editing either list:
//!
//! - **A command that is not named here cannot be reached by any window.** It has no `allow-`
//!   permission for a capability to reference. Adding a command therefore means naming it twice —
//!   here, and in the capability of the window that may call it — and the failure mode of
//!   forgetting the second is a refusal at the invoke rather than a silent grant.
//! - **Naming it here grants it to nobody.** The manifest declares the surface; the capabilities
//!   hand it out per window. The pet is the least trusted window in the app — it renders a
//!   character the user chose and receives engine events — so it holds the eight commands its own
//!   page and menu call and none of the `agent_*`, `fs_*`, `ai_*`, `keys` or recovery surface.
//!   `tests/command_authorisation_test.rs` drives the real IPC entry with the real context and
//!   asserts both directions, so this table is executable rather than a note.
//!
//! New dependencies: none. `AppManifest` and `try_build` are `tauri-build`'s own, already a
//! build-dependency.

use tauri_build::{AppManifest, Attributes};

/// Every command in `lib.rs`'s `invoke_handler!`, in the same order and grouped the same way.
///
/// One list, and it is meant to stay the handler list's mirror: a name here that is not registered
/// there is a permission for a command nothing answers, and a name there that is missing here is a
/// command no window can reach. The two are kept side by side deliberately — the handler list is
/// what exists, this is what may be called, and neither can be edited without the other.
const COMMANDS: &[&str] = &[
    // Vault files, history and the native dialogs.
    "read_file",
    "stat_file",
    "write_file",
    "create_new_file",
    "delete_file",
    "list_trash",
    "restore_from_trash",
    "clear_trash",
    "list_history",
    "read_history",
    "restore_history",
    "list_dir",
    "save_attachment",
    "resolve_media_path",
    "create_dir",
    "rename_entry",
    "register_vault",
    "open_folder_dialog",
    "save_file_dialog",
    "pick_image_files",
    "import_attachment",
    "watch_folder",
    // The AI providers and the key store.
    "ai_complete",
    "ai_cancel",
    "ai_list_models",
    "store_ai_key",
    "load_ai_key",
    "set_master_password",
    "unlock_vault",
    // Host integration.
    "system_accent_color",
    "take_pending_open",
    // The agent session.
    "agent_start",
    "agent_stop",
    "agent_open_session",
    "agent_set_config_option",
    "agent_prompt",
    "agent_session_snapshot",
    "agent_session_capabilities",
    "agent_permission_answer",
    "agent_cancel_run",
    // The engine registry.
    "agent_registry_read",
    "agent_registry_add",
    "agent_registry_set_enabled",
    // The agent's settings documents.
    "agent_profile_read",
    "agent_profile_write",
    "agent_config_document",
    "agent_config_edit",
    "agent_credentials_write",
    // The desktop pet (§7.1). None of these is declared here to *grant* it anything: the
    // capability files are where a window is given one.
    "desktop_pet_state",
    "desktop_pet_windows",
    "desktop_pet_open",
    "desktop_pet_disable",
    "desktop_pet_set_visible",
    "desktop_pet_close_own",
    "desktop_pet_set_click_through",
    "desktop_pet_capabilities",
    "desktop_pet_care_read",
    "desktop_pet_tasks",
    "desktop_pet_appearance",
    "desktop_pet_library",
    "desktop_pet_import_character",
    "desktop_pet_open_task",
    "desktop_pet_read_settings",
    "desktop_pet_update_settings",
    "desktop_pet_open_settings",
];

fn main() {
    tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(COMMANDS)))
        .expect("the application's ACL manifest builds");
}
