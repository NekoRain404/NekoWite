//! The pet's IPC surface: the names both sides of every window boundary agree on, the three items
//! both halves of the surface share, and the paths every one of its commands is reached by.
//!
//! **This file was split, and what is left of it is the seam.** It had reached 814 lines against the
//! 600-line budget `docs/dev.md:286` puts on a business file, and the split is by *reason to change*
//! — the criterion that same section states — rather than by arithmetic. Five subjects came out of
//! it, each in a file of its own beside this one:
//!
//! - `window_surface.rs` — the pet as it is running: the windows that exist, whether they show, and
//!   what this machine was verified able to do with them (§7.1, §7.2). Changes when a window
//!   operation changes.
//! - `character_appearance.rs` — what a pet window draws of its character: the sheet, the grid and
//!   the stored policies one frame needs (§5.1, §5.2). Changes when a frame's inputs change.
//! - `host_appearance.rs` — the app's own palette, read by a pet window and published by the main
//!   one (§1). Changes when that relay changes, not when a character does.
//! - `character_library.rs` — §8's characters, the two ways one arrives, and the sentence a refused
//!   install is answered with. Changes when a source or an install transaction changes.
//! - `runtime_reads.rs` — §8's ledger and §6's tasks, as a window may read them. Changes when what
//!   the runtime holds changes.
//!
//! What stays here is what none of them may own. The **channel names and the page vocabulary** are
//! one decision written twice — once in Rust, once in TypeScript — and have to sit where both the
//! commands that emit on them and the surface tests that read them can find them. The **three items
//! the settings half reaches for** across the boundary are here for the same reason:
//! [`PetFeatureState`], `host` and `publish_feature` are what an applied `general` write *is* the
//! switch through, and `desktop_pet_surface.rs` imports them from this path today. The rule that
//! separates the two halves — a window operation is authorised here, a settings write is a record
//! with a revision — is argued in that file's header, and the §7.1 argument for the window commands
//! is in `window_surface.rs`.
//!
//! **Why the commands are re-exported rather than left where they now live.** `lib.rs`'s
//! `generate_handler!` names each one as `commands::desktop_pet::<name>`, `build.rs`'s `COMMANDS`
//! holds the bare names, and several test targets import `commands::desktop_pet::{…}`. Those paths
//! are part of this module's contract, so every command moved out is re-exported below together with
//! the two macros `#[tauri::command]` emits beside it. That last part is not tidiness:
//! `generate_handler!` builds its path by renaming only the *last* segment of the path written in
//! `lib.rs`, so a command that moved without its `__cmd__*` and `__tauri_command_name_*` macros
//! leaves that handler list failing to compile while the command itself still resolves — the one
//! failure mode a re-export exists to prevent. They are `#[macro_export]`, which is what makes the
//! `pub use` of a macro legal in the first place.
//!
//! **Wording.** The refusals in these commands are sentences rather than codes for the reason
//! `commands/agent.rs` gives: they reach the user with no form and no mapper in between.
//!
//! **Why these commands are generic over the runtime**, unlike their neighbours in this directory.
//! §7.1's checking is the thing that has to be tested, and testing it means driving the command from
//! a *real* window rather than from a `CallerWindow` a test built — which is `MockRuntime`, which a
//! signature naming `tauri::AppHandle` (i.e. `AppHandle<Wry>`) cannot be called with. What a test in
//! another crate cannot do is register the library's commands, so the test target's `commands.rs`
//! (`tests/desktop_pet_ipc_test/`) registers one-line wrappers with the same parameter names over
//! these functions; `R: tauri::Runtime` is what lets the wrapper's `MockRuntime` instance reach the
//! body under test.
//! It costs nothing at build time beyond the monomorphisation the app would do anyway, and nothing in
//! these bodies is Wry-specific — the one Wry-specific thing in the pet's backend is `TauriSurfaces`,
//! and it lives in `PetWindowHost`.
//!
//! Registering a handler is `lib.rs`'s line and not this file's: every command here and in
//! `desktop_pet_surface.rs` is in that handler list and in `build.rs`'s `COMMANDS`, and a command
//! added to either file is reported to whoever owns those two lists rather than appended to them
//! from here.

mod character_appearance;
mod character_library;
mod host_appearance;
mod runtime_reads;
mod window_surface;

use serde::Serialize;

use crate::desktop_pet::PetWindowHost;
use crate::state::DesktopPetState;

pub use super::desktop_pet_navigation::{
    __cmd__desktop_pet_open_settings, __cmd__desktop_pet_open_task,
    __tauri_command_name_desktop_pet_open_settings, __tauri_command_name_desktop_pet_open_task,
    desktop_pet_open_settings, desktop_pet_open_task,
};

// Re-exported from `desktop_pet_surface` so that the paths naming them do not move: `lib.rs`'s
// handler list, `build.rs`'s `COMMANDS`, and the test targets importing `commands::desktop_pet::{…}`.
// A second spelling of one command is how a handler list and the command behind it drift apart.
//
// The two `__cmd__*` and `__tauri_command_name_*` names are `#[tauri::command]`'s own output, and
// they have to travel with the function: `generate_handler!` builds its path from the one written
// in `lib.rs`, renaming only the last segment, so a command that moved without them leaves that
// list failing to compile while the command itself still resolves — the one failure mode a
// re-export is supposed to prevent. They are `#[macro_export]`, which is what makes this `pub use`
// of a macro legal in the first place.
pub use super::desktop_pet_surface::{
    __cmd__desktop_pet_read_settings, __cmd__desktop_pet_update_settings,
    __tauri_command_name_desktop_pet_read_settings,
    __tauri_command_name_desktop_pet_update_settings, apply_feature_switch,
    apply_notification_switch, apply_window_style, desktop_pet_read_settings,
    desktop_pet_update_settings, PET_SETTINGS_CHANGED_CHANNEL, UNSELECTED_CHARACTER,
};

// The same arrangement for the five files this module was split into: the command and the two
// macros beside it travel together, so `commands::desktop_pet::<name>` names the same function — and
// the same `__cmd__` macro — that it did before the move.
pub use character_appearance::{
    __cmd__desktop_pet_appearance, __tauri_command_name_desktop_pet_appearance,
    desktop_pet_appearance,
};
pub use character_library::{
    __cmd__desktop_pet_adopt_character, __cmd__desktop_pet_catalogue,
    __cmd__desktop_pet_import_character, __cmd__desktop_pet_library,
    __tauri_command_name_desktop_pet_adopt_character, __tauri_command_name_desktop_pet_catalogue,
    __tauri_command_name_desktop_pet_import_character, __tauri_command_name_desktop_pet_library,
    desktop_pet_adopt_character, desktop_pet_catalogue, desktop_pet_import_character,
    desktop_pet_library,
};
pub use host_appearance::{
    __cmd__desktop_pet_host_appearance, __cmd__desktop_pet_publish_host_appearance,
    __tauri_command_name_desktop_pet_host_appearance,
    __tauri_command_name_desktop_pet_publish_host_appearance, desktop_pet_host_appearance,
    desktop_pet_publish_host_appearance,
};
pub use runtime_reads::{
    __cmd__desktop_pet_care_read, __cmd__desktop_pet_tasks,
    __tauri_command_name_desktop_pet_care_read, __tauri_command_name_desktop_pet_tasks,
    desktop_pet_care_read, desktop_pet_tasks, PetCareRead,
};
pub use window_surface::{
    __cmd__desktop_pet_capabilities, __cmd__desktop_pet_close_own, __cmd__desktop_pet_disable,
    __cmd__desktop_pet_open, __cmd__desktop_pet_set_click_through, __cmd__desktop_pet_set_visible,
    __cmd__desktop_pet_state, __cmd__desktop_pet_windows,
    __tauri_command_name_desktop_pet_capabilities, __tauri_command_name_desktop_pet_close_own,
    __tauri_command_name_desktop_pet_disable, __tauri_command_name_desktop_pet_open,
    __tauri_command_name_desktop_pet_set_click_through,
    __tauri_command_name_desktop_pet_set_visible, __tauri_command_name_desktop_pet_state,
    __tauri_command_name_desktop_pet_windows, desktop_pet_capabilities, desktop_pet_close_own,
    desktop_pet_disable, desktop_pet_open, desktop_pet_set_click_through, desktop_pet_set_visible,
    desktop_pet_state, desktop_pet_windows,
};

/// The channel a pet window hears a change in the feature's state on (§7.1).
///
/// It exists because of a hole D3 reported and left open: `PetGateway` has `feature()` and
/// `setVisible()`, but its only push channel carried tasks — so a hide performed from the
/// settings page reached the window on its next `feature()` call, which nothing was going to
/// make. §7.1 makes the settings page the way *back* to a hidden pet on a desktop with no tray
/// (「无托盘的 Linux 环境仍能从主设置恢复隐藏桌宠」), and a way back that only works when the
/// window happens to ask again is not one. `tauri-pet.ts` listens on this name; the two
/// spellings are one decision.
pub const PET_FEATURE_CHANNEL: &str = "pet-feature";

/// The channel a pet window's 设置 opens the main window on (§5.1).
///
/// The main window's listener is `platform/pet-settings-request.ts`, which `app/pet-settings-link.ts`
/// attaches from the shell — written, and no longer reported. The payload is a page and nothing
/// else — no section id, no window label, no URL — so the section this app opens is named once, in
/// TypeScript, by `PET_SETTINGS_SECTION`.
pub const PET_SETTINGS_CHANNEL: &str = "pet-open-settings";

/// The channel the host publishes the task list on (§6).
///
/// Declared in `desktop_pet/task_feed.rs`, where the list is published, and re-exported here
/// because this module is where a channel's *name* lives for the two sides to agree on. The window
/// that reads it is `tauri-pet.ts`'s `PET_TASKS_CHANNEL`.
pub use crate::desktop_pet::PET_TASKS_CHANNEL;

/// The channel the pet's click on a task reaches the main window on (§6.2's 点击返回任务).
///
/// The payload is D1's `PetTaskKey` and nothing else — no session URL, no path, no command. §6.3
/// requires a notification's action to be a host-issued, limited target, and the key is exactly
/// that: the main window re-validates it against the sessions it holds, and the pet cannot name
/// anything the host did not mint. Both halves of that sentence are now code rather than intent —
/// `platform/pet-task-request.ts` reads the payload and refuses what is not a key, and
/// `app/pet-task-link.ts` focuses the session only when this window is holding it.
pub const PET_TASK_OPEN_CHANNEL: &str = "pet-open-task";

/// The channel the host relays the app's own appearance on (§1's 「保留现有主题、强调色」).
///
/// The fifth channel of the same shape, and the direction is the one that matters: the *app*
/// publishes over a command (`desktop_pet_publish_host_appearance`, which is §5.3's rule that an
/// event may not be an unauthorised config write), this host holds the value, and a pet window that
/// is already mounted hears the new one here. `tauri-pet.ts` listens on this name; the two
/// spellings are one decision.
pub const PET_HOST_APPEARANCE_CHANNEL: &str = "pet-host-appearance";

/// §5.1's pet sub-pages, as this side validates them.
///
/// Duplicated from D1's `PET_SETTINGS_PAGES` (`pet-contracts/config.ts`) rather than trusted from
/// the request for the reason above: the value crosses a window boundary, so a string a caller
/// invented would otherwise be handed to the main window's listener as a page to open. The two
/// lists are held together by `the_page_vocabulary_is_the_typescript_one` in
/// `tests/desktop_pet_ipc_test/commands.rs`, which reads the contract off disk — a page added on
/// one side alone fails that test rather than opening nothing.
pub const SETTINGS_PAGES: [&str; 7] = [
    "general",
    "character",
    "bubble",
    "notification",
    "care",
    "project",
    "advanced",
];

/// Whether the feature is on, and whether a pet is on screen right now.
///
/// D1's `PetFeatureState` (`pet-contracts/gateway.ts:29-33`), for the reason it gives for having
/// two fields rather than one: "the feature is off" means no window, no animation and no timers
/// while "hidden" is a pet that is running with its drawing stopped — collapsing them would make
/// a temporary hide indistinguishable from a disable, and the user's way back would be the wrong
/// one.
///
/// `enabled` is answered from the host's own state — a character window exists only because the
/// enable path opened one, and [`desktop_pet_disable`] is what takes them away — and the settings
/// *are* that enable path: [`desktop_pet_update_settings`] turns an applied `general.enabled` into
/// windows through [`apply_feature_switch`], so the two agree because one is the cause of the
/// other and not because they are checked against each other. The direction that is not enforced
/// is the other one: a direct [`desktop_pet_open`] still opens a window while the switch is off,
/// because refusing it would need a refusal arm `HostRefusal` does not have. Reported rather than
/// papered over.
///
/// It is declared here rather than in `window_surface.rs`, where [`desktop_pet_state`] answers with
/// it, because the settings half reads it too: an applied `general` write *is* the switch, and
/// `desktop_pet_surface.rs` has imported it from this path all along.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetFeatureState {
    pub enabled: bool,
    pub visible: bool,
}

impl PetFeatureState {
    pub(super) fn of(host: &PetWindowHost) -> Self {
        // A disabled feature has nothing to show, so `visible` is not merely "the flag is set":
        // reporting a hidden-but-enabled pet for a feature with no windows would be a state a
        // window could act on and be wrong about.
        //
        // "Something is showing" counts the ball as well as the character windows. The two are
        // separate surfaces with separate switches (§5.1), so the table can be in the state where
        // 显示角色窗口 is off and 显示悬浮球 is on — the pet is on screen and the feature is on, and a
        // state that answered `enabled: false` there would be this field disagreeing with the
        // switch it is named after. Nothing reads it in that state today (the only subscriber is a
        // *character* window, and there is none), which is why the answer has to be right rather
        // than merely harmless.
        let enabled = !host.instances().is_empty() || host.ball().is_some();
        Self {
            enabled,
            visible: enabled && host.is_visible(),
        }
    }
}

/// The window state, or the sentence that says it could not be read.
///
/// A poisoned lock is reported rather than panicked through: a panic in a Tauri command is a
/// rejected promise on the other side with no explanation, and a lock this process poisoned once
/// is a fact the user's next click has to survive.
///
/// It stays here rather than moving to `window_surface.rs` with the window commands because both
/// halves of the surface take it: the window operations judge a caller through it, and an applied
/// `general` write opens or closes windows through it
/// (`desktop_pet_surface.rs` imports it beside [`PetFeatureState`]). One lock, one guard, one
/// place the poisoned case is spelled.
pub(super) fn host(
    state: &DesktopPetState,
) -> Result<std::sync::MutexGuard<'_, PetWindowHost>, String> {
    state
        .host
        .lock()
        .map_err(|_| "the pet's window state was poisoned by a panic".to_string())
}

/// Tell every window what the feature state is now.
///
/// Broadcast rather than addressed to the pet windows, because the address would be the labels —
/// which this surface hands out and never accepts. The channel is the pet's own, so the frames
/// cost the main window a listener it never registered. A failed emit is not an error:
/// it means no window is listening, which is what the shutdown path looks like, and the state is
/// readable on request in any case.
///
/// Shared for the same reason [`host`] is: a window operation moves the feature state, and so does
/// an applied settings write, and both have to tell the windows the same way.
pub(super) fn publish_feature<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: PetFeatureState,
) {
    let _ = tauri::Emitter::emit(app, PET_FEATURE_CHANNEL, state);
}
