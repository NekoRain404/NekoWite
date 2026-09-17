//! §7.1's 「后端 IPC 验证调用窗口身份」, driven through the real authorisation entry.
//!
//! The plan's rule is one sentence with a second half that is the whole point: 「仅限制前端按钮或
//! 只写 capabilities 文件不能替代自定义命令授权检查」. A capability file grants permissions, and a
//! `#[tauri::command]` that nothing declares has none to grant — so before `build.rs` carried an
//! app manifest, `capabilities/desktop-pet.json` scoped the pet to two `core:event` permissions and
//! governed none of this app's own commands. A pet window could call `agent_stop`, `fs_*` and
//! `desktop_pet_open`, and the capability file said nothing about it because it had nothing to say.
//!
//! ## Why the real entry, and not a policy function
//!
//! There is no `may_call(window, command)` in this crate for a test to call, deliberately: the
//! authorisation is Tauri's, and what has to be proven is that Tauri consults it. So every test
//! below builds the app from `tauri::generate_context!()` — the same context `lib.rs` builds, ACL
//! manifest and capability files included — creates real `WebviewWindow`s under `MockRuntime`, and
//! sends a real `InvokeRequest` through `tauri::test::get_ipc_response`. The refusal the tests
//! read is `Webview::on_message`'s own, produced before any command of ours runs.
//!
//! That distinction is not academic here. `mock_context`, which the pet's own IPC tests use, has
//! an empty ACL and no app manifest, so a command is dispatched with no check at all; a test built
//! on it would pass with the manifest deleted from `build.rs`. This target is the one that fails
//! when it is.
//!
//! ## What makes a refusal a refusal
//!
//! An `Err` from `get_ipc_response` is not evidence on its own — a command that is refused and a
//! command that has no handler are both errors. Two things separate them:
//!
//! - The tests **register handlers** for the commands the pet is refused, so the invoke would be
//!   answered if the ACL let it through. A window that is merely unable to *reach* a command is
//!   not being refused by anything.
//! - The assertions read the message. Tauri's refusal names the window that was refused and the
//!   windows that would have been allowed (`… not allowed on window "pet-1" … allowed on: [windows:
//!   "main", URL: local]`), so `is_not_allowed_on` is a statement about *this* command and *this*
//!   window rather than about the invoke having failed.
//!
//! ## The other direction
//!
//! `main` is asserted to still reach what it always reached. A boundary that refuses the
//! legitimate caller is a regression, not a fix, and the main window's permissions are listed
//! in `capabilities/default.json` one command at a time — so a command that goes missing there is
//! a test failure here rather than a broken editor at runtime.
//!
//! ## Where the other half went
//!
//! The two tests that compare the four hand-kept lists against each other — `build.rs`'s
//! `COMMANDS`, `lib.rs`'s `invoke_handler!`, and the two capability files — are in
//! `tests/command_surface_test.rs`. They moved, not changed: this file had reached 809 lines
//! against a budget of 800, and the seam is between the two kinds of evidence rather than between
//! two sizes. Everything here drives the real IPC entry and observes Tauri's own refusal; those
//! read source text and compare lists. Adding a command still means touching both, and forgetting
//! the second is still caught — just one target over.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::Listener;

use nekowite_lib::state::VaultRegistry;

// ---------------------------------------------------------------------------
// The surface under test
// ---------------------------------------------------------------------------
//
// `generate_handler!` resolves a command through the `__cmd__<name>` macro `#[tauri::command]`
// emits, and that macro is `pub(crate)` to the library — so this crate cannot register the
// library's commands however public the functions are. The wrappers below re-register the handful
// the tests invoke, under the names the ACL is keyed on (the names ARE the wire contract, and the
// name is all the authorisation consults).
//
// ## Why most of these are stand-ins
//
// A refusal happens before any command body runs, so what a test of the boundary needs from a
// registered command is that it would answer **if** the ACL let the call through — a handler that
// cannot be reached proves the ACL refused *it*, and a handler that can proves the call was
// allowed. Whether the body is the library's own function or a sentence saying it was reached is
// therefore not what this target measures.
//
// The ones that call the library are the ones whose module is settled and whose refusals are
// interesting in their own right (`read_file` answers a vault refusal once it has run, which is a
// second way to tell "it ran" from "it was refused"). The rest are stand-ins on purpose: the
// agent's and the pet's command modules are being edited by other tasks as this lands, and a
// fixture that bound itself to their parameter lists would break for a reason that has nothing to
// do with authorisation — which is the failure this repository has had twice. `build.rs`'s manifest
// and the two capability files are what name the commands; nothing here needs their signatures.

use nekowite_lib::commands;

#[tauri::command]
fn take_pending_open(
    state: tauri::State<'_, nekowite_lib::open_file::PendingOpen>,
) -> Option<nekowite_lib::open_file::OpenFileRequest> {
    commands::open::take_pending_open(state)
}

#[tauri::command]
async fn system_accent_color() -> Option<commands::system::SystemAccent> {
    commands::system::system_accent_color().await
}

#[tauri::command(rename_all = "snake_case")]
async fn read_file(
    vault_root: String,
    path: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    commands::fs::read_file(vault_root, path, state).await
}

/// The command a pet window must never reach, answering `Ok` if it ever does.
///
/// This one is the whole brief, so it is worth being explicit about the shape: it takes no
/// arguments and succeeds unconditionally. A pet window that reached it would *stop the user's
/// agent*, and this body would report that it had — which is why the assertion below is that the
/// call was refused, not merely that it failed.
#[tauri::command]
async fn agent_stop() -> Result<(), String> {
    Ok(())
}

/// The two commands that read and remove a lasting permission, as stand-ins.
///
/// Stand-ins for the reason `agent_stop` is: a refusal proves something about the ACL only when
/// the command would have answered, and what is being asserted here is that a pet window cannot
/// reach the surface that takes a permission back. A body that called the library would need a
/// live engine to say anything, and would be measuring that instead.
#[tauri::command]
async fn agent_permission_grants() -> Result<Value, String> {
    Ok(json!({ "reached": "agent_permission_grants" }))
}

#[tauri::command]
async fn agent_permission_grant_revoke(grant_id: String) -> Result<Value, String> {
    Ok(json!({ "reached": "agent_permission_grant_revoke", "grantId": grant_id }))
}

/// The three session-history commands, as stand-ins.
///
/// Stand-ins for the reason the two above are: a refusal proves something about the ACL only when
/// the command *would* have answered, and `is_not_allowed_on` fails outright on a "not found"
/// message — which is exactly the guard that keeps a missing registration from passing as a
/// refusal. What the real ones do needs a live engine for anything to be true of it, and the
/// boundary being measured here is upstream of that. Their signatures are deliberately *not*
/// copied: `build.rs`'s manifest and the capability files are what name a command, and the
/// authorisation reads the name alone, so a fixture bound to a parameter list would break for a
/// reason that has nothing to do with authorisation.
#[tauri::command]
async fn agent_list_sessions() -> Result<Value, String> {
    Ok(json!({ "reached": "agent_list_sessions" }))
}

#[tauri::command]
async fn agent_load_session() -> Result<Value, String> {
    Ok(json!({ "reached": "agent_load_session" }))
}

#[tauri::command]
async fn agent_close_session() -> Result<Value, String> {
    Ok(json!({ "reached": "agent_close_session" }))
}

/// The four skills commands, as stand-ins.
///
/// Stand-ins for the reason the three above are, and the sharpest of them is
/// `agent_skills_import`: it takes a folder path and writes into this app's own profile, so a
/// decoration that could reach it would be a second way to install something the engine will later
/// run. Their signatures are deliberately *not* copied — `build.rs`'s manifest and the capability
/// files are what name a command, and the authorisation reads the name alone.
#[tauri::command]
async fn agent_skills_read() -> Result<Value, String> {
    Ok(json!({ "reached": "agent_skills_read" }))
}

#[tauri::command]
async fn agent_skills_preview() -> Result<Value, String> {
    Ok(json!({ "reached": "agent_skills_preview" }))
}

#[tauri::command]
async fn agent_skills_import() -> Result<Value, String> {
    Ok(json!({ "reached": "agent_skills_import" }))
}

#[tauri::command]
async fn agent_skills_set_enabled() -> Result<Value, String> {
    Ok(json!({ "reached": "agent_skills_set_enabled" }))
}

/// The runtime page's one read, as a stand-in.
///
/// Registered for the reason the four above are: a refusal proves something about the ACL only
/// when the command would have answered. It is the read that says what this app's engine
/// connection *is* — the negotiated protocol version, the engine's own name for itself, the
/// authentication it advertises, and the capability report — so a decoration that could call it
/// would be reading the state of an engine it does not own.
#[tauri::command]
async fn agent_runtime_read() -> Result<Value, String> {
    Ok(json!({ "reached": "agent_runtime_read" }))
}

/// The pet's five granted commands, each answering whether it was reached.
#[tauri::command]
async fn desktop_pet_state() -> Result<Value, String> {
    Ok(json!({ "reached": "desktop_pet_state" }))
}

#[tauri::command]
async fn desktop_pet_set_visible() -> Result<Value, String> {
    Ok(json!({ "reached": "desktop_pet_set_visible" }))
}

#[tauri::command]
async fn desktop_pet_close_own() -> Result<Value, String> {
    Ok(json!({ "reached": "desktop_pet_close_own" }))
}

#[tauri::command]
async fn desktop_pet_set_click_through() -> Result<Value, String> {
    Ok(json!({ "reached": "desktop_pet_set_click_through" }))
}

#[tauri::command]
fn desktop_pet_open_settings<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    page: String,
) -> Result<Value, String> {
    // The one of the five that is delegated, because its effect is observable and worth reading
    // back: it raises `main` and publishes the page at it, which is the difference between "the
    // pet's call was allowed" and "the pet's call was allowed *and did what it is for*".
    commands::desktop_pet::desktop_pet_open_settings(app, page.clone())?;
    Ok(json!({ "reached": "desktop_pet_open_settings", "page": page }))
}

/// The switch itself, for the main window's direction: it answers whether it was reached.
#[tauri::command]
async fn desktop_pet_update_settings(write: Value) -> Result<Value, String> {
    Ok(json!({ "reached": "desktop_pet_update_settings", "write": write }))
}

/// The three the pet window's own page makes, and the two the settings page makes.
///
/// Registered for the same reason as the five above: a refusal only proves something about the ACL
/// when the command *would* have answered. The pet's three are asserted to be reached, which is the
/// direction that keeps "the pet holds the task feed" from being a claim about the text of a JSON
/// file, and the picker's two are asserted to be refused for the pet in the same breath — a
/// boundary that let those through would be the one defect this change could still introduce.
#[tauri::command]
async fn desktop_pet_tasks() -> Result<Value, String> {
    Ok(json!({ "reached": "desktop_pet_tasks" }))
}

#[tauri::command]
async fn desktop_pet_appearance() -> Result<Value, String> {
    Ok(json!({ "reached": "desktop_pet_appearance" }))
}

#[tauri::command]
async fn desktop_pet_open_task() -> Result<Value, String> {
    Ok(json!({ "reached": "desktop_pet_open_task" }))
}

#[tauri::command]
async fn desktop_pet_library() -> Result<Value, String> {
    Ok(json!({ "reached": "desktop_pet_library" }))
}

#[tauri::command]
async fn desktop_pet_import_character() -> Result<Value, String> {
    Ok(json!({ "reached": "desktop_pet_import_character" }))
}

/// The app, built the way `lib.rs` builds it: the real context, and therefore the real ACL.
struct App {
    app: tauri::App<tauri::test::MockRuntime>,
}

const SETTINGS_CHANNEL: &str = nekowite_lib::commands::desktop_pet::PET_SETTINGS_CHANNEL;

fn app() -> App {
    let app = mock_builder()
        // The two states the delegated commands address, managed here for the reason `lib.rs`
        // manages them: something has to answer before a command that needs them can run.
        .manage(nekowite_lib::open_file::PendingOpen::default())
        .manage(VaultRegistry::default())
        .invoke_handler(tauri::generate_handler![
            take_pending_open,
            system_accent_color,
            read_file,
            agent_stop,
            agent_permission_grants,
            agent_permission_grant_revoke,
            agent_list_sessions,
            agent_load_session,
            agent_close_session,
            agent_skills_read,
            agent_skills_preview,
            agent_skills_import,
            agent_skills_set_enabled,
            agent_runtime_read,
            desktop_pet_state,
            desktop_pet_set_visible,
            desktop_pet_close_own,
            desktop_pet_set_click_through,
            desktop_pet_open_settings,
            desktop_pet_update_settings,
            desktop_pet_tasks,
            desktop_pet_appearance,
            desktop_pet_open_task,
            desktop_pet_library,
            desktop_pet_import_character,
        ])
        // The real one. `mock_context(noop_assets())` would compile and would pass every test
        // below for the wrong reason: `Resolved::default()` carries no app ACL, so an app command
        // is dispatched unchecked.
        .build(tauri::generate_context!())
        .expect("the app builds from its own tauri.conf.json, capabilities included");
    App { app }
}

/// A window the IPC can arrive from, under the label the capabilities key on.
fn window(app: &App, label: &str) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
    tauri::WebviewWindowBuilder::new(&app.app, label, tauri::WebviewUrl::default())
        .build()
        .expect("a window")
}

/// One invoke, as the webview sends it: the command name and a JSON body.
///
/// The URL is local. It has to be: a remote origin is refused by Tauri's ACL check whatever the
/// capabilities say, and every window here is a local page — which is what makes the refusals
/// below about *this* policy rather than about the framework's remote-origin rule.
fn call(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    body: Value,
) -> Result<Value, Value> {
    let request = InvokeRequest {
        cmd: cmd.to_string(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .expect("a local URL"),
        body: if body.is_null() {
            InvokeBody::default()
        } else {
            InvokeBody::Json(body)
        },
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    get_ipc_response(window, request).map(|body| {
        body.deserialize::<Value>()
            .expect("every command answers JSON")
    })
}

/// The ACL's refusal of `cmd` for `window`, asserted to be that and not something else.
///
/// Tauri's message for an app command names the command, the window it was refused on and the
/// windows it would have been allowed on — so this asserts on the window label rather than on the
/// invoke having failed. The `not found` check is the one that keeps the suite honest: without it
/// a target that stopped registering handlers would pass by refusing everything.
fn is_not_allowed_on(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    label: &str,
) {
    let error = call(window, cmd, json!({}))
        .expect_err(&format!("{cmd} must be refused for a window lab: {label}"));
    let message = error
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| error.to_string());
    assert!(
        message.contains(&format!("not allowed on window \"{label}\"")),
        "{cmd} was refused, but not by the ACL for window \"{label}\": {message}"
    );
    assert!(
        !message.contains("not found"),
        "{cmd} has no handler registered, so this proves nothing about authorisation: {message}"
    );
}

// ---------------------------------------------------------------------------
// The pet window is refused the app
// ---------------------------------------------------------------------------

/// §11's 「桌宠窗口伪造授权/文件写入 IPC 被拒」 — the row the plan names, and the one that closes
/// the gap the D12 report found without fixing.
///
/// `agent_stop` is the sharpest of these: it takes `AgentRuntimeState` and nothing else, so before
/// the app manifest existed a pet window could reach it with one invoke and stop the user's agent.
/// It is registered above, which is what makes the refusal the ACL's own rather than an artefact
/// of the handler list.
#[test]
fn a_pet_window_cannot_stop_or_start_the_users_agent() {
    let app = app();
    let pet = window(&app, "pet-1");
    for cmd in [
        "agent_stop",
        "agent_start",
        "agent_prompt",
        "agent_permission_answer",
        "agent_cancel_run",
        "agent_registry_add",
        "agent_registry_set_enabled",
        "agent_session_capabilities",
        // Session history. The sharpest of the three for a decoration to hold would be
        // `agent_list_sessions`: it needs no session id at all, so one invoke from a pet window
        // would read the user's whole engine-side session table — every working directory they
        // have worked in, and the engine's own auto-generated title for each. `agent_load_session`
        // and `agent_close_session` are the same boundary one step further in: one would put a
        // session this app did not open in front of a window, and the other would take a session
        // out of the host's table and free it on the engine.
        "agent_list_sessions",
        "agent_load_session",
        "agent_close_session",
        "agent_profile_write",
        "agent_credentials_write",
        // The rest of the agent surface: reading a session, opening one, changing its
        // configuration, reading the registry and the two settings documents. None of them is
        // "stop the agent", and all of them are the app's business rather than a decoration's.
        "agent_open_session",
        "agent_set_config_option",
        "agent_session_snapshot",
        "agent_registry_read",
        "agent_profile_read",
        "agent_config_document",
        "agent_config_edit",
        // The runtime readout: the protocol version this app negotiated with the engine, the
        // engine's own name for itself, the authentication it advertises and the eleven capability
        // rows. Nothing on it is a credential and nothing on it moves a file, which is why the
        // boundary has to be the ACL rather than taste — it describes the user's engine, and the
        // pet is a decoration.
        "agent_runtime_read",
        // The grant surface. A decoration that could revoke the user's own answers would be
        // acting on the consent record itself rather than on the work it decorates.
        "agent_permission_grants",
        "agent_permission_grant_revoke",
        // The skills page. It writes into this app's own profile — an import installs a folder the
        // engine may later run, and the switch moves a directory out of the engine's reach — which
        // is the app's business and not a decoration's.
        "agent_skills_read",
        "agent_skills_preview",
        "agent_skills_import",
        "agent_skills_set_enabled",
    ] {
        is_not_allowed_on(&pet, cmd, "pet-1");
    }
}

/// The filesystem half of the same row: 「文件写入 IPC 被拒」.
#[test]
fn a_pet_window_cannot_read_or_write_the_vault() {
    let app = app();
    let pet = window(&app, "pet-1");
    for cmd in [
        "read_file",
        "write_file",
        "create_new_file",
        "delete_file",
        "list_dir",
        "register_vault",
        "open_folder_dialog",
        "save_file_dialog",
        "import_attachment",
        "watch_folder",
        "clear_trash",
        "restore_history",
        // The whole vault surface, because "the pet may read one file" and "the pet may read the
        // vault" are the same permission: stat, list the trash and the history, resolve a path for
        // `asset://`, save and import attachments, create and rename entries, and pick files with
        // a native dialog.
        "stat_file",
        "list_trash",
        "restore_from_trash",
        "list_history",
        "read_history",
        "save_attachment",
        "resolve_media_path",
        "create_dir",
        "rename_entry",
        "pick_image_files",
    ] {
        is_not_allowed_on(&pet, cmd, "pet-1");
    }
}

/// The pet's own family, minus the five it holds.
///
/// These are the commands it could reach *before* the manifest, and two of them are the switch
/// itself: `desktop_pet_open` creates character windows (and is how the cap is reached) and
/// `desktop_pet_update_settings` writes `general.enabled`, which is what opens and closes them. A
/// decoration that could do either would be a second, unguarded way to drive the feature.
#[test]
fn a_pet_window_cannot_drive_the_features_own_lifecycle() {
    let app = app();
    let pet = window(&app, "pet-1");
    for cmd in [
        "desktop_pet_open",
        "desktop_pet_disable",
        "desktop_pet_windows",
        "desktop_pet_capabilities",
        "desktop_pet_care_read",
        "desktop_pet_read_settings",
        "desktop_pet_update_settings",
    ] {
        is_not_allowed_on(&pet, cmd, "pet-1");
    }
}

/// The floating ball's window is governed by the pet's capability, and this is where "the label
/// decides which capability a window gets" is measured rather than asserted in prose.
///
/// The host mints exactly one label for the ball — `pet-ball` (`window_host.rs`) — and
/// `capabilities/desktop-pet.json` selects its windows with the glob `pet-*`. Two things have to
/// hold for the ball, and each fails silently if it does not:
///
/// - **the glob has to match the label.** A label no capability matched would be a window whose
///   every invoke is refused, which the first assertion rules out by reaching a command the pet
///   capability grants;
/// - **it has to hand out the pet's eight commands rather than the main window's.** The refusals
///   below are the same ones a `pet-1` window gets, read against the ball's own label — so a
///   future label that quietly matched `main` (or a capability that listed `pet-ball` in
///   `default.json` as well) fails here instead of shipping a launcher with the editor's ACL.
#[test]
fn the_ball_window_is_governed_by_the_pets_capability() {
    let app = app();
    let ball = window(&app, "pet-ball");

    let reached = call(&ball, "desktop_pet_state", Value::Null)
        .expect("a pet window may read the feature state");
    assert_eq!(reached, json!({ "reached": "desktop_pet_state" }));

    for cmd in [
        // The lifecycle: creating and tearing down pet windows is the settings switch's job.
        "desktop_pet_open",
        "desktop_pet_disable",
        "desktop_pet_windows",
        "desktop_pet_capabilities",
        "desktop_pet_care_read",
        "desktop_pet_read_settings",
        "desktop_pet_update_settings",
        // And the app beyond the pet, one from each family the pet's boundary withholds — plus
        // session history, because it is the one command in this file that reads the user's
        // engine-side session table and needs no argument to do it.
        "agent_stop",
        "agent_list_sessions",
        "read_file",
        "take_pending_open",
    ] {
        is_not_allowed_on(&ball, cmd, "pet-ball");
    }
}

/// The rest of the app: the AI providers, the key store and the host integration.
#[test]
fn a_pet_window_cannot_reach_the_providers_or_the_keys() {
    let app = app();
    let pet = window(&app, "pet-1");
    for cmd in [
        "ai_complete",
        "ai_cancel",
        "ai_list_models",
        "store_ai_key",
        "load_ai_key",
        // The key vault's state, and the two commands that change it. A decoration that could
        // read the first would learn whether the user has a master password at all, which is the
        // one fact the window state exists to keep on the window side of this boundary.
        "key_vault_status",
        "set_master_password",
        "unlock_vault",
        "system_accent_color",
        "take_pending_open",
    ] {
        is_not_allowed_on(&pet, cmd, "pet-1");
    }
}

// ---------------------------------------------------------------------------
// The refusal is about the caller, not about the command
// ---------------------------------------------------------------------------

/// The same two commands, from the app's own window: both run.
///
/// This is the control the rest of the suite needs. `take_pending_open` answers, which is a command
/// that ran; `read_file` answers a *vault* refusal — a different message from the ACL's, produced
/// by the command's own first line. One command that succeeds and one that fails for its own
/// reason is what makes "the pet was refused" a statement about the window.
#[test]
fn the_main_window_reaches_the_commands_the_pet_is_refused() {
    let app = app();
    let main = window(&app, "main");

    let taken = call(&main, "take_pending_open", Value::Null).expect("the main window may ask");
    assert_eq!(
        taken,
        Value::Null,
        "nothing was pending, and that is an answer"
    );

    let error = call(
        &main,
        "read_file",
        json!({ "vault_root": "/nonexistent-vault", "path": "note.md" }),
    )
    .expect_err("an unopened vault is refused by the command, not by the ACL");
    let message = error.as_str().unwrap_or_default().to_string();
    assert!(
        !message.contains("not allowed on window"),
        "the main window must not be refused by the ACL: {message}"
    );

    // And the pet's own surface, for the same window: the switch the settings page writes is the
    // one command here that opens and closes character windows, so "main may call it" is worth
    // asserting directly rather than inferring from the pet being refused it.
    let answered = call(&main, "desktop_pet_update_settings", json!({ "write": {} }))
        .expect("the main window holds the pet's switch");
    assert_eq!(answered["reached"], "desktop_pet_update_settings");
}

/// The pet window's five granted commands are reachable, and one of them is observable.
///
/// A grant that nothing can exercise would leave "the boundary refuses the pet" indistinguishable
/// from "the boundary refuses everything", which is the failure this whole change risks. So the
/// pet's settings deep link is invoked here and its effect — the page it published on the host
/// channel — is read back.
#[test]
fn the_pet_window_can_still_do_the_five_things_it_is_for() {
    let app = app();
    // The app's own window, because the deep link is addressed to it: `desktop_pet_open_settings`
    // raises `main` and then `emit_to`s the page at that window, and it refuses when `main` is not
    // open. Creating it first is what makes the success below the host's answer rather than the
    // command's own guard — and the listener is on the window rather than on the app because that
    // is the target the event names, so an app-wide listener would see nothing either way.
    let main = window(&app, "main");
    let pages: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&pages);
    main.listen(SETTINGS_CHANNEL, move |event| {
        sink.lock()
            .expect("the listener's lock")
            .push(event.payload().to_string())
    });
    let pet = window(&app, "pet-1");

    call(
        &pet,
        "desktop_pet_open_settings",
        json!({ "page": "character" }),
    )
    .expect("the pet's menu may ask the host to open a settings page");

    let pages = pages.lock().expect("lock").clone();
    assert_eq!(
        pages.len(),
        1,
        "the page must have been published once: {pages:?}"
    );
    assert!(
        pages[0].contains("character"),
        "the page the window named is the page that was published: {pages:?}"
    );

    // The other four are granted, and each one answers. That is the direction this test exists
    // for: a boundary that refused the pet everything would also pass every refusal test above,
    // and would leave the pet's window unable to say what it is or to hide itself.
    for cmd in [
        "desktop_pet_state",
        "desktop_pet_set_visible",
        "desktop_pet_close_own",
        "desktop_pet_set_click_through",
    ] {
        let answered = call(&pet, cmd, json!({}))
            .unwrap_or_else(|error| panic!("the pet holds {cmd} and must reach it: {error}"));
        assert_eq!(answered["reached"], cmd);
    }
}

/// The three the task feed added to the pet's side, and the two that stayed on `main`'s.
///
/// These five commands landed after the boundary did, which is exactly the moment the boundary's
/// own note warns about: a command declared in `build.rs`'s manifest has a permission for a
/// capability to name, and one that is missing from the manifest has none — so a capability naming
/// it fails the build. What that leaves unstated is the *other* half, which is the silent one: the
/// manifest can declare all five while a capability forgets to hand one out, and the window that
/// needs it is refused with nothing in `lib.rs` explaining why. So the pet's three are invoked
/// here rather than read off the JSON, and main's two are invoked for the same reason.
///
/// The refusal of the picker's two for the pet is the half of this that is a boundary rather than a
/// wiring check: choosing and importing a character is the settings page's business, and the pet's
/// three grants are the task list, what it draws, and the click on a bubble — not the library.
#[test]
fn the_pet_window_reaches_the_task_feed_and_not_the_character_picker() {
    let app = app();
    let pet = window(&app, "pet-1");
    let main = window(&app, "main");

    for cmd in [
        "desktop_pet_tasks",
        "desktop_pet_appearance",
        "desktop_pet_open_task",
    ] {
        let answered = call(&pet, cmd, json!({})).unwrap_or_else(|error| {
            panic!("the pet's own page calls {cmd} and must reach it: {error}")
        });
        assert_eq!(answered["reached"], cmd);
    }

    // The other direction, and the reason this is a boundary test and not a registration check:
    // both are registered above, so a refusal here is the ACL's and not a missing handler.
    for cmd in ["desktop_pet_library", "desktop_pet_import_character"] {
        is_not_allowed_on(&pet, cmd, "pet-1");
    }

    for cmd in ["desktop_pet_library", "desktop_pet_import_character"] {
        let answered = call(&main, cmd, json!({})).unwrap_or_else(|error| {
            panic!("the settings page calls {cmd} and must reach it: {error}")
        });
        assert_eq!(answered["reached"], cmd);
    }
}

/// A window no capability names.
///
/// §7.1's rule read as an absence: the check has to answer "nothing is known about this caller"
/// with a refusal rather than with a pass. The front end never creates a window under this label —
/// and the point of the test is that it would not help if it did.
#[test]
fn a_window_no_capability_names_may_call_nothing() {
    let app = app();
    let stranger = window(&app, "stranger");
    for cmd in ["take_pending_open", "agent_stop", "desktop_pet_state"] {
        is_not_allowed_on(&stranger, cmd, "stranger");
    }
}
