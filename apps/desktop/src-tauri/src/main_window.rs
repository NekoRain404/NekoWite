//! What "the main window" is, and how a launch brings it back.
//!
//! **The state this exists for.** The main window is *destroyed* when the user closes it, and the
//! process does not end with it whenever the pet is on: the wry runtime exits only when its window
//! map empties (`tauri-runtime-wry-2.11.4/src/lib.rs:4310-4322`), and the pet's windows are in that
//! map. So a closed main window is a process that still holds the single-instance D-Bus name, still
//! runs the engine and the watchers, and has nothing to show — and the handoff callback, which was
//! `if let Some(window) = app.get_webview_window("main") { … }`, then did nothing at all. The user
//! clicked the icon again and the launch exited 0 with no window and no sentence anywhere.
//!
//! **Why a closed window is *destroyed* rather than hidden, including from the app's own X button.**
//! Every close ends in a JS `destroy()`, so no Rust-side `CloseRequested` hook can keep the window:
//!
//! ```text
//! TitleBar.vue:158  the app's own close button
//!   → getWindowControls().close()                        platform/window.ts
//!   → Tauri window close                                 WindowMessage::Close
//!   → tauri's manager: a JS listener exists, so the NATIVE close is prevented
//!     and `tauri://close-requested` is emitted           tauri-2.11.5/src/manager/window.rs:170-175
//!   → the app's handler returns without preventing       app/app-lifecycle.ts:190-201
//!   → `await this.destroy()`                             @tauri-apps/api@2.11.1/window.js:1632-1641
//!   → the window is gone; the pet's windows keep the process alive
//! ```
//!
//! Hiding it on `CloseRequested` would therefore be a hook that runs and is then destroyed anyway.
//! What is left is to build the window again when something asks for it, which is this module.
//!
//! **The declaration stays singular.** There is one definition of the main window and it is
//! `tauri.conf.json`'s entry — the same entry `setup` builds, by the same builder call
//! ([`build`]), so the clipboard setting that only exists as a builder option cannot drift between
//! the first build and a later one. Nothing here writes down a size, a title or a label of its own:
//! [`LABEL`] is the name Tauri itself defaults an entry to, and a test asserts the config declares
//! exactly that.
//!
//! **A launch never does nothing.** [`raise`] answers `Err` with a sentence instead of returning
//! quietly, and every caller reports it. The second process's *exit code* is not ours to change:
//! the single-instance plugin calls this process and then leaves with `std::process::exit(0)`
//! (`tauri-plugin-single-instance 2.4.4`, `platform_impl/linux.rs:84-90`), so the log of the
//! instance that received the request is where the reason is legible.

use tauri::utils::config::WindowConfig;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

/// The label the main window is declared under.
///
/// The app's `tauri.conf.json` entry carries no `label`, and Tauri's default for one is exactly
/// this (`tauri-utils-2.9.3/src/config.rs:1919-1920`, `default_window_label`). It is written here
/// rather than derived so that a window this module rebuilds and the window `setup` builds are
/// addressed by one name — and `tests/main_window_test.rs` is what holds the config and this
/// constant together.
pub const LABEL: &str = "main";

/// The main window's declaration, out of the config Tauri already holds.
///
/// A pure function of the declarations, so the arm that matters — a config that declares no such
/// window — is a case a test can hand it rather than a state only a broken build can reach.
pub fn declared(windows: &[WindowConfig]) -> Option<&WindowConfig> {
    windows.iter().find(|window| window.label == LABEL)
}

/// Build one window its config declares.
///
/// The one place a config-declared window becomes a window, and deliberately the only one:
/// `enable_clipboard_access` has no key in `WindowConfig`, so a second build site would be a second
/// place to remember it. It is what makes the editor's right-click Paste possible at all — with the
/// setting off, `document.execCommand('paste')` returns false and `navigator.clipboard.readText()`
/// rejects `NotAllowedError`, a user gesture or not. `setup` builds every declared window through
/// this; [`raise`] builds the main one through this when it is gone.
pub fn build<R: Runtime>(
    app: &AppHandle<R>,
    config: &WindowConfig,
) -> tauri::Result<WebviewWindow<R>> {
    WebviewWindowBuilder::from_config(app, config)?
        .enable_clipboard_access()
        .build()
}

/// Bring the main window up — the one that is there, or one built again from its declaration.
///
/// The two arms are the two states the app can be in, and neither is silent about which one it
/// took. A window that exists is unminimized, shown and focused, each step reported rather than
/// swallowed: "the window did not come up" is a dead-looking click or a launch that seems to do
/// nothing, and which of the three refused is what tells a minimized window apart from one a
/// session manager took away.
pub fn raise<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return present(&window);
    }
    let config = declared(&app.config().app.windows).ok_or_else(|| {
        format!(
            "tauri.conf.json declares no window labelled {LABEL}, so there is no declaration to \
             build one from"
        )
    })?;
    // Built from the declaration and not from a hidden copy of the window's options: the size,
    // the title, `decorations` and `center` are the config's, which is the same config the window
    // at startup came from.
    let window = build(app, config).map_err(|error| {
        format!("the window {LABEL} is declared but could not be built: {error}")
    })?;
    present(&window)
}

/// Show a window and put it in front: what "bring the main window up" means, step by step.
fn present<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
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
