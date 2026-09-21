//! What the app calls "the main window", and what bringing it up does — on a mock runtime.
//!
//! **What this file is for, and what it is not.** `main_window::raise` is the one function a second
//! launch and the pet's 设置 both go through, and its two arms are the two states the app can be
//! in: a window that is there (unminimize, show, focus) and a window that is gone, which is built
//! again from the declaration `tauri.conf.json` holds. Those two arms are what these cases pin,
//! through the real builders and the real `Manager` calls, on a runtime that records windows
//! without a display.
//!
//! It is not the whole path, and it does not pretend to be: a mock runtime has no X server, no
//! session bus and no second process, so the *handoff* — the plugin's D-Bus name, the second
//! launch's exit, and whether a window really reaches the screen — is not here. That half was
//! `main_window_relaunch_test.rs`, deleted in `e326a8b` together with the state it drove, which was
//! a destroyed main window the process outlived; what drives a real binary now is
//! `main_window_close_pet_test.rs`, and it skips when this tree has no packaged build to drive,
//! exactly as that one did. What runs everywhere is this file, so what has to be right here is the
//! rule itself: the label the config declares, the declaration a raise builds from, and the
//! difference between "there is a window" and "there is not".
//!
//! **What the rebuilt window does not show.** `build`'s reason for existing is
//! `enable_clipboard_access`, which has no key in `WindowConfig` and so lives only in that one
//! builder call — and no state under `MockRuntime` reflects it: `WebviewBuilder`'s attributes are
//! `pub(crate)` (`tauri-2.11.5/src/webview/mod.rs:984`), `WebviewWindowBuilder` exposes no getter
//! for them (`:48-51`), and `MockRuntime::create_webview` drops the whole `PendingWebview` it is
//! handed, keeping only its id, url and last evaluated script (`src/test/mock_runtime.rs:193-213`).
//! A window is therefore proven here to come back with the declaration's *label*, and nothing about
//! it beyond that; that the clipboard setting cannot drift between the first build and a later one
//! rests on `build` being the one build site, not on a reading taken here.

use tauri::utils::config::WindowConfig;
use tauri::Manager;

use nekowite_lib::main_window;

/// The app's own config, as `lib.rs` receives it.
fn app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .build(tauri::generate_context!())
        .expect("the app's own tauri.conf.json builds a context")
}

/// A declaration list, spelled the way `tauri.conf.json` spells one.
fn declarations(json: &str) -> Vec<WindowConfig> {
    serde_json::from_str(json).expect("a window declaration parses")
}

/// The window every raise is about is the one the config declares, and it declares exactly one.
///
/// The assertion this file exists for, in the direction that matters: `main_window::LABEL` is a
/// string in this crate and the window is an entry in a config file, and the only thing holding
/// them together is this case. A window renamed in the config — or a second window added beside
/// it, which would make "the main window" ambiguous — fails here rather than at the next handoff,
/// where the symptom would be a launch that raises nothing.
#[test]
fn the_config_declares_exactly_one_window_and_it_is_the_main_one() {
    let app = app();
    let windows = &app.config().app.windows;
    assert_eq!(
        windows.len(),
        1,
        "the app declares one window, and 'the main window' has to mean one thing: {:?}",
        windows.iter().map(|w| w.label.clone()).collect::<Vec<_>>()
    );
    assert_eq!(
        windows[0].label,
        main_window::LABEL,
        "the declared window is the one every raise addresses"
    );
    assert_eq!(
        main_window::LABEL,
        "main",
        "the label is Tauri's own default for a window entry (tauri-utils, `default_window_label`) \
         — the config carries no `label` of its own, so this string is the whole of the window's \
         name"
    );
}

/// A declaration list with no such window is answered with `None`, not with the first entry.
///
/// The arm that a config cannot reach in this tree and that a test can hand over directly: the
/// caller is expected to *say* there is nothing to build from, which it cannot do if a raise
/// quietly picked something else.
#[test]
fn a_declaration_list_without_the_main_window_answers_nothing() {
    assert!(
        main_window::declared(&declarations(r#"[{"label":"other"}]"#)).is_none(),
        "a window that is not the main one is not the main one"
    );
    // The control, so the `None` above is about the label and not about a list that matches
    // nothing at all: the app's own spelling — an entry with no `label`, which Tauri defaults to
    // `main` — is found.
    let unlabelled = declarations(r#"[{}]"#);
    let declared =
        main_window::declared(&unlabelled).expect("an entry with no label is the main window");
    assert_eq!(declared.label, main_window::LABEL);
}

/// The `None` above is refused in words — what `raise` does with it, rather than the lookup itself.
///
/// The two are different failures. A `None` that was quietly skipped would leave a launch that
/// exits 0 with no window and no sentence anywhere, which is the defect `main_window.rs` was written
/// to end; the `Err` is what puts the reason in the log of the instance that received the launch
/// (`lib.rs`'s single-instance callback prints it). The state is one the app's own config cannot
/// produce and a test can hand over directly, which is why the arm is a function of the declarations
/// rather than a check on the running app.
#[test]
fn a_config_that_declares_no_window_makes_the_raise_refuse() {
    // `mock_context` here and the real context everywhere else in this file, deliberately: what this
    // case needs is the one input `raise` refuses on, and this is how a config declaring no window
    // is handed to it.
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("a context that declares no window still builds an app");
    assert!(
        app.config().app.windows.is_empty(),
        "this case is only about a config with nothing to build from: {:?}",
        app.config().app.windows
    );

    let error = main_window::raise(app.handle())
        .expect_err("with no declaration there is nothing to build, so this cannot succeed");

    // Pinned whole rather than in fragments: this sentence is what a user's log gets in place of a
    // window, so it is an account to keep rather than an internal detail to reword.
    assert_eq!(
        error,
        "tauri.conf.json declares no window labelled main, so there is no declaration to build \
         one from"
    );
    assert!(
        app.webview_windows().is_empty(),
        "the refusal must not build anything on its way out"
    );
}

/// A main window that is not there is built again — from its declaration, not from a copy of it.
#[test]
fn a_missing_main_window_is_built_again() {
    let app = app();
    assert!(
        app.get_webview_window(main_window::LABEL).is_none(),
        "nothing has built a window yet — this is the state a closed window leaves behind"
    );

    main_window::raise(app.handle()).expect("the declared window is built and shown");

    let window = app
        .get_webview_window(main_window::LABEL)
        .expect("the raise put a window back");
    let config = main_window::declared(&app.config().app.windows).expect("the config declares it");
    assert_eq!(
        window.label(),
        config.label,
        "the window that came back is the declared one"
    );
    assert_eq!(
        app.webview_windows().len(),
        1,
        "one window, not one per raise"
    );
}

/// A main window that IS there is the one raised — the other arm, so a raise cannot pass by always
/// building.
#[test]
fn an_existing_main_window_is_raised_rather_than_replaced() {
    let app = app();
    let config = main_window::declared(&app.config().app.windows)
        .expect("the config declares the main window")
        .clone();
    main_window::build(app.handle(), &config).expect("the window the setup builds");
    assert_eq!(app.webview_windows().len(), 1);

    main_window::raise(app.handle()).expect("an existing window has all three steps available");

    assert_eq!(
        app.webview_windows().len(),
        1,
        "a raise that built a second window would fail here: Tauri refuses a duplicate label, so \
         the case would have answered Err instead of Ok"
    );
    assert!(app.get_webview_window(main_window::LABEL).is_some());
}
