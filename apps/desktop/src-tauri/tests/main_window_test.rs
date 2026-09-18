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
//! launch's exit, and whether a window really reaches the screen — is not here. That half is
//! `main_window_relaunch_test.rs`, which drives two real processes and skips when this tree has no
//! packaged build to drive. What runs everywhere is this file, so what has to be right here is the
//! rule itself: the label the config declares, the declaration a raise builds from, and the
//! difference between "there is a window" and "there is not".

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
