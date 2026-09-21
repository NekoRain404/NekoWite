//! The pet as it is running: which windows exist, whether they are showing, and what this machine
//! was verified able to do with them (§7.1's window operations, §7.2's evidence).
//!
//! **Why this is a module and not commands on `desktop_pet.rs`.** The parent had reached 814 lines
//! against the 600-line budget `docs/dev.md:286` puts on a business file, and the split is by
//! *reason to change* — the criterion that same section states. What makes this file change is a
//! window operation: a new one, a new refusal arm on `PetWindowHost`, a different property of a live
//! window. Nothing about a stored settings record or a character on disk makes it change, and those
//! are what the files beside this one are for. The parent keeps the channels and the three items
//! both halves of the surface share — [`host`](super::host),
//! [`publish_feature`](super::publish_feature) and [`PetFeatureState`](super::PetFeatureState) — so
//! the settings half reaches them at the path it always did.
//!
//! §7.1 puts two rules on the surface this file is the window half of, and both are about *this*
//! layer rather than the one below it:
//!
//! - 「前端不能自选任意 label 去关闭主窗口」 — a front end chooses no window. Two commands here take
//!   a `tauri::WebviewWindow`, and their first act is `CallerWindow::from_window_label` on the
//!   label the *windowing system* reports for the caller. No command in the pet's surface has a
//!   parameter that names a window, so there is nothing to forge: a request body cannot say who it
//!   is, and `PetWindowHost` offers no operation that accepts a label either.
//! - 「仅限制前端按钮或只写 capabilities 文件不能替代自定义命令授权检查」 — the capability file
//!   (`capabilities/desktop-pet.json`) says which *plugin* permissions a pet window has; it says
//!   nothing about these commands, because app commands are not ACL-gated at all (Tauri checks the
//!   ACL for app commands only when the app defines its own permission manifest, which this app
//!   does not). The authorization for every privileged operation is therefore the check *here* and
//!   in `window_host::PetWindowHost::authorized`, and the capability file is the second,
//!   independent layer rather than the only one.
//!
//! [`desktop_pet_capabilities`] is the read that reports the other side of the same question: what
//! this machine was *measured* to support, rather than what §7.1 permits. It is here rather than in
//! a file of its own because it answers about the same subject — these windows, on this desktop —
//! and because the alternative, a module of one read, would put the §7.1 argument and the §7.2
//! evidence for it on opposite sides of a file boundary.

use crate::desktop_pet::{
    CallerWindow, CapabilityReport, Closed, HostRefusal, LinuxEnvironment, PetInstance,
    TeardownReport, WindowAction,
};
use crate::state::DesktopPetState;

use super::{host, publish_feature, PetFeatureState};

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

/// A poisoned window lock, in the shape the window operations refuse with.
///
/// The lock can only be poisoned by a panic while it was held, and every method it guards returns
/// rather than panics — so this is the "something else went wrong" arm, and it is reported as a
/// failure of *this* operation rather than folded into a success. The action is the caller's, so a
/// refusal names the thing the user asked for and the detail names what actually happened.
fn window_state_refusal(action: WindowAction, detail: String) -> HostRefusal {
    HostRefusal::Window { action, detail }
}
