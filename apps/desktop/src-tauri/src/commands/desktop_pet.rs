//! The pet's IPC surface: the commands a window may call, and the one place a caller's identity
//! is read.
//!
//! §7.1 puts two rules on this file, and both are about *this* layer rather than the one below
//! it:
//!
//! - 「前端不能自选任意 label 去关闭主窗口」 — a front end chooses no window. Two commands here take
//!   a `tauri::WebviewWindow`, and their first act is `CallerWindow::from_window_label` on the
//!   label the *windowing system* reports for the caller. No command in this file has a
//!   parameter that names a window, so there is nothing to forge: a request body cannot say who
//!   it is, and `PetWindowHost` offers no operation that accepts a label either.
//! - 「仅限制前端按钮或只写 capabilities 文件不能替代自定义命令授权检查」 — the capability file
//!   (`capabilities/desktop-pet.json`) says which *plugin* permissions a pet window has; it says
//!   nothing about these commands, because app commands are not ACL-gated at all (Tauri checks
//!   the ACL for app commands only when the app defines its own permission manifest, which this
//!   app does not). The authorization for every privileged operation is therefore the check
//!   *here* and in `window_host::PetWindowHost::authorized`, and the capability file is the
//!   second, independent layer rather than the only one.
//!
//! **What is not here, and why it refuses loudly instead.** D1's `PetGateway` also reads and
//! writes the settings domains and lists the tasks; neither has a backend yet (`settings.rs` and
//! `task_projection.rs` are their own tasks, D6's Rust half and D4). No command is invented for
//! them, so a window calling one is answered by Tauri itself — "command desktop_pet_read_settings
//! not found" — which names the call that is missing and needs no error code invented here to
//! say so. The seam is already on the front end (`tauri-pet.ts`), so the day those land only this
//! side changes.
//!
//! **Wording.** The refusals below are sentences rather than codes for the reason
//! `commands/agent.rs` gives: they reach the user with no form and no mapper in between.
//!
//! **Why these commands are generic over the runtime**, unlike their neighbours in this
//! directory. The checking above is the thing §7.1 asks for, and testing it means driving the
//! command from a *real* window rather than from a `CallerWindow` a test built — which is
//! `MockRuntime`, which a signature naming `tauri::AppHandle` (i.e. `AppHandle<Wry>`) cannot be
//! called with. What a test in another crate cannot do is register the library's commands, so
//! `tests/desktop_pet_ipc_test/commands.rs` registers one-line wrappers with the same parameter
//! names over these functions; `R: tauri::Runtime` is what lets the wrapper's `MockRuntime`
//! instance reach the body under test. It costs nothing at build time beyond the monomorphisation
//! the app would do anyway, and nothing in these bodies is Wry-specific — the one Wry-specific
//! thing in the pet's backend is `TauriSurfaces`, and it lives in `PetWindowHost`, not here.

use serde::Serialize;

use crate::desktop_pet::{
    CallerWindow, CapabilityReport, Closed, HostRefusal, LinuxEnvironment, PetInstance,
    PetWindowHost, TeardownReport, WindowAction,
};
use crate::state::DesktopPetState;

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
/// The main window's listener is the integrator's other half (reported, not written: it lands
/// with the `desktop-pet` settings section). The payload is a page and nothing else — no section
/// id, no window label, no URL — so the section this app opens is named once, in TypeScript, by
/// `PET_SETTINGS_SECTION`.
pub const PET_SETTINGS_CHANNEL: &str = "pet-open-settings";

/// The main window's label, as the app builds it from `tauri.conf.json`.
///
/// Spelled here rather than taken from a request for the reason the whole file is about: which
/// window the pet's 设置 raises is the host's decision, and `open_file.rs` already names this
/// label for the same purpose (a second launch raises the same window).
const MAIN_WINDOW: &str = "main";

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
/// `enabled` is answered from the host's own state and not from the settings record, because
/// that record has no backend on this side yet: a character window exists only because the
/// enable path opened one, and {@link desktop_pet_disable} is what takes them away. The day
/// `settings.rs` lands, this is where its `general.enabled` joins, and the two must agree — a
/// window the settings say is off is a window to close, not a state to report.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetFeatureState {
    pub enabled: bool,
    pub visible: bool,
}

impl PetFeatureState {
    fn of(host: &PetWindowHost) -> Self {
        // A disabled feature has nothing to show, so `visible` is not merely "the flag is set":
        // reporting a hidden-but-enabled pet for a feature with no windows would be a state a
        // window could act on and be wrong about.
        let enabled = !host.instances().is_empty();
        Self {
            enabled,
            visible: enabled && host.is_visible(),
        }
    }
}

/// A settings page a pet window asked the main window to open.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsRequest {
    page: String,
}

/// The window state, or the sentence that says it could not be read.
///
/// A poisoned lock is reported rather than panicked through: a panic in a Tauri command is a
/// rejected promise on the other side with no explanation, and a lock this process poisoned once
/// is a fact the user's next click has to survive.
fn host(state: &DesktopPetState) -> Result<std::sync::MutexGuard<'_, PetWindowHost>, String> {
    state
        .host
        .lock()
        .map_err(|_| "the pet's window state was poisoned by a panic".to_string())
}

/// The current feature state, for a window that is mounting.
#[tauri::command]
pub fn desktop_pet_state(
    state: tauri::State<'_, DesktopPetState>,
) -> Result<PetFeatureState, String> {
    let host = host(&state)?;
    Ok(PetFeatureState::of(&host))
}

/// The character windows that are open.
///
/// Read-only, and the only place a label is handed outward. That is not the rule §7.1 states —
/// a front end that can *read* a label still cannot name one in a request, and no command here
/// accepts one — but it is worth saying, because a future command that took a label would have
/// to justify itself against this.
#[tauri::command]
pub fn desktop_pet_windows(
    state: tauri::State<'_, DesktopPetState>,
) -> Result<Vec<PetInstance>, String> {
    Ok(host(&state)?.instances().to_vec())
}

/// Create the window for a character, on demand (§7.1).
///
/// The caller names a *character*, never a window: the label is minted by the host and never
/// reused, so a character that is closed and re-enabled gets a new identity rather than
/// inheriting the authority of the window that closed. A second request for a character that is
/// already showing returns the window that exists rather than opening another one.
#[tauri::command]
pub fn desktop_pet_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DesktopPetState>,
    character_id: String,
) -> Result<PetInstance, HostRefusal> {
    let (instance, feature) = {
        let mut host =
            host(&state).map_err(|detail| window_state_refusal(WindowAction::Open, detail))?;
        let instance = host.open(&character_id)?;
        (instance, PetFeatureState::of(&host))
    };
    publish_feature(&app, feature);
    Ok(instance)
}

/// The feature switch going off: every pet window closes, and the report says which (§4).
///
/// What it does not do is the point of the return type. `TeardownReport`'s fields are windows
/// and nothing else — no cancelled run, no deleted character, no cleared ledger — and a window
/// the compositor would not close stays in the registry and is reported in `failed` rather than
/// being forgotten.
#[tauri::command]
pub fn desktop_pet_disable<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DesktopPetState>,
) -> Result<TeardownReport, String> {
    let (report, feature) = {
        let mut host = host(&state)?;
        let report = host.disable();
        (report, PetFeatureState::of(&host))
    };
    publish_feature(&app, feature);
    Ok(report)
}

/// Show or hide every pet window, answering with the state the host ended up in.
///
/// It answers rather than returning nothing because that is the contract's own shape (D1): a
/// request to show a disabled feature does nothing, and the caller has to be able to tell. Hide
/// is not disable — every instance stays, the windows stay, and showing them again is this
/// command with `true` from the settings page, which §7.1 makes the way back on a desktop with
/// no tray.
#[tauri::command]
pub fn desktop_pet_set_visible<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DesktopPetState>,
    visible: bool,
) -> Result<PetFeatureState, HostRefusal> {
    let feature = {
        let mut host =
            host(&state).map_err(|detail| window_state_refusal(WindowAction::Show, detail))?;
        host.set_visible(visible)?;
        PetFeatureState::of(&host)
    };
    publish_feature(&app, feature);
    Ok(feature)
}

/// Close the window that is asking, and only that one.
///
/// The `WebviewWindow` is Tauri's, not the request's: it is the window the IPC arrived from, and
/// its label is read for the identity check. No parameter names a window, so §7.1's 「前端不能自选
/// 任意 label 去关闭主窗口」 is not an extra check that a later edit could drop — there is no
/// argument to pass, and a caller from the main window is refused by name
/// (`HostRefusal::UnrecognizedCaller { observed: "main" }`).
#[tauri::command]
pub fn desktop_pet_close_own<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DesktopPetState>,
) -> Result<Closed, HostRefusal> {
    let caller = CallerWindow::from_window_label(window.label());
    let (closed, feature) = {
        let mut host =
            host(&state).map_err(|detail| window_state_refusal(WindowAction::Close, detail))?;
        let closed = host.close_own(&caller)?;
        (closed, PetFeatureState::of(&host))
    };
    publish_feature(&app, feature);
    Ok(closed)
}

/// Whether clicks that land on the caller's own window reach the pet or pass through (§7.2).
///
/// Identity-checked like [`desktop_pet_close_own`] and for the same reason: it is a property of
/// the caller's own window, and a window that could set it on another window could make a
/// different one stop receiving input. Deliberately *not* presented as pixel hit-testing — that
/// is the renderer's business, and §7.2 forbids one standing in for the other.
#[tauri::command]
pub fn desktop_pet_set_click_through<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, DesktopPetState>,
    ignore: bool,
) -> Result<(), HostRefusal> {
    let caller = CallerWindow::from_window_label(window.label());
    let mut host =
        host(&state).map_err(|detail| window_state_refusal(WindowAction::ClickThrough, detail))?;
    host.set_click_through(&caller, ignore)
}

/// What this machine was verified to do, each finding with what happens instead (§7.2).
///
/// The environment is read here rather than stored: `XDG_CURRENT_DESKTOP` and the session type
/// are facts about the process that started, and a cached copy would survive a session the user
/// restarted into something else.
#[tauri::command]
pub fn desktop_pet_capabilities(
    state: tauri::State<'_, DesktopPetState>,
) -> Result<Vec<CapabilityReport>, String> {
    let observations = state
        .observations
        .lock()
        .map_err(|_| "the pet's capability state was poisoned by a panic".to_string())?;
    Ok(crate::desktop_pet::linux_capabilities::report(
        &LinuxEnvironment::observe(),
        &observations,
    ))
}

/// Bring the main window up on one of §5.1's pet pages.
///
/// Two steps, in this order, and the order is the requirement: §5.1's 「主窗口隐藏时先安全唤起，不
/// 依赖 DOM 是否已挂载」. The window is raised first, so the event lands on a listener that is
/// mounted — a request delivered to a hidden window's page is a request answered by nothing.
/// The main window is never *created* here: if it is gone, that is a closed app, and a pet window
/// does not get to reopen it.
#[tauri::command]
pub fn desktop_pet_open_settings<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    page: String,
) -> Result<(), String> {
    if !SETTINGS_PAGES.contains(&page.as_str()) {
        return Err(format!(
            "{page} is not one of the pet's settings pages: {}",
            SETTINGS_PAGES.join(", ")
        ));
    }
    raise_main(&app)?;
    tauri::Emitter::emit_to(
        &app,
        MAIN_WINDOW,
        PET_SETTINGS_CHANNEL,
        SettingsRequest { page },
    )
    .map_err(|error| format!("the settings request could not be delivered: {error}"))
}

/// Raise the main window, or say why it cannot be raised.
///
/// Each step is reported rather than swallowed: "the settings did not open" is a dead-looking
/// right-click, and which of the three failed is what tells the difference between a window that
/// is minimized and one the session manager took away.
fn raise_main<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    use tauri::Manager;
    let window = app.get_webview_window(MAIN_WINDOW).ok_or_else(|| {
        "the main window is not open, so there is nowhere to show the settings".to_string()
    })?;
    window
        .unminimize()
        .map_err(|error| format!("the main window could not be restored: {error}"))?;
    window
        .show()
        .map_err(|error| format!("the main window could not be shown: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("the main window could not be focused: {error}"))
}

/// Tell every window what the feature state is now.
///
/// Broadcast rather than addressed to the pet windows, because the address would be the labels —
/// and a label is the one thing this module does not hand out. The channel is the pet's own, so
/// the frames cost the main window a listener it never registered. A failed emit is not an error:
/// it means no window is listening, which is what the shutdown path looks like, and the state is
/// readable on request in any case.
fn publish_feature<R: tauri::Runtime>(app: &tauri::AppHandle<R>, state: PetFeatureState) {
    let _ = tauri::Emitter::emit(app, PET_FEATURE_CHANNEL, state);
}

/// A poisoned window lock, in the shape the window operations refuse with.
///
/// The lock can only be poisoned by a panic while it was held, and every method it guards returns
/// rather than panics — so this is the "something else went wrong" arm, and it is reported as a
/// failure of *this* operation rather than folded into a success. The action is the caller's, so a
/// refusal names the thing the user asked for and the detail names what actually happened.
fn window_state_refusal(action: WindowAction, detail: String) -> HostRefusal {
    HostRefusal::Window { action, detail }
}
