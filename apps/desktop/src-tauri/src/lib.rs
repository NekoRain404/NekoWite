//! NekoWite Tauri backend.
//!
//! This crate is split into layered modules (see `docs/dev.md` §5.5):
//! - [`agent_runtime`]: the agent engine — its process, the ACP connection, the
//!   sessions, the permission table. It knows nothing about Tauri; the commands
//!   below are the only thing that reaches it from a window.
//! - [`desktop_pet`]: the pet's windows and what this machine can do with them
//!   (§7.1–7.2). Same shape as `agent_runtime`: the module's rules are Tauri-free
//!   and the commands are the only thing that reaches them from a window.
//! - [`commands`]: the `#[tauri::command]` IPC surface — thin args/DTO/error
//!   mapping only.
//! - [`main_window`]: what the main window is — the label the config declares it
//!   under, the one builder call every declared window is built by, and the
//!   raise that builds it again when the user closed it and the pet kept the
//!   process alive.
//! - [`instance_guard`]: whether this process's single-instance guard actually armed — the
//!   plugin's D-Bus name either exists or it does not, and the launch that has none is the one
//!   that used to say nothing at all.
//! - [`domain`]: path-confinement policy, vault rules, crash recovery.
//! - [`storage`]: file, trash, index and key stores.
//! - [`providers`]: the AI providers (client, Gemini, OpenAI-compatible).
//! - [`state`]: managed app state ([`state::VaultRegistry`], watcher, AI, keys).
//! - [`errors`]: shared user-facing error helpers.
//!
//! [`lib.rs`] itself only assembles app state, builds the main window and
//! registers commands.

pub mod agent_runtime;
pub mod commands;
pub mod desktop_pet;
pub mod domain;
pub mod errors;
#[cfg(target_os = "linux")]
pub mod instance_guard;
pub mod main_window;
pub mod open_file;
pub mod providers;
pub mod state;
pub mod storage;

// Re-exported at the crate root for convenience/back-compat: the vault
// registry is the authority that path-confined commands consult (and it is what
// `tests/vault_auth_test.rs` exercises).
use std::path::Path;

use tauri::Manager;

use crate::domain::app_owned::AppDir;

pub use state::VaultRegistry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();

    // Tauri builds the windows declared in `tauri.conf.json` itself, through a
    // builder this crate never gets to see. The editor's right-click Paste needs
    // that builder: WebKit gates the clipboard behind
    // `WebKitSettings:javascript-can-access-clipboard`, which surfaces as
    // `enable_clipboard_access()` — a builder-only method, with no key in
    // `WindowConfig` to reach it from the config file. Marking the config windows
    // as not auto-created hands the build to `setup` below, so the definition
    // itself (title, size, decorations) stays where it is and only the build
    // moves.
    for window in &mut context.config_mut().app.windows {
        window.create = false;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // **The window this raises is not assumed to exist.** It is destroyed when the user
            // closes it, and while the pet is on the process outlives it — the wry runtime exits
            // only when its window map empties (`tauri-runtime-wry-2.11.4/src/lib.rs:4310-4322`),
            // and the pet's windows are in that map. With the window gone this callback used to
            // match nothing, so every launch while the app was in that state exited 0 with no
            // window and nothing said anywhere. `main_window::raise` shows the window that is
            // there and *builds it again from `tauri.conf.json`'s own entry* when it is not; the
            // sentence is for the case where even that fails, because it is the only thing this
            // process can do about it — the second launch's exit code belongs to the plugin, which
            // exits 0 before its caller could change it (`platform_impl/linux.rs:84-90`).
            if let Err(detail) = main_window::raise(app) {
                eprintln!(
                    "nekowite: a launch asked this instance to show its main window and it could \
                     not: {detail}"
                );
            }
            // A second launch is how a file manager opens a `.md` in an app that
            // is already running, so this `argv` is where the file is. It used to
            // be thrown away here, and with it every double-click made while the
            // app was open.
            //
            // It is NOT this process's `argv`, though, and the difference is the
            // whole of what the arguments may do. The plugin serves
            // `ExecuteCallback(argv, cwd)` at the session bus with no
            // peer-credential check, so any process running as this user can call
            // it with any path at all — an assertion by the caller, where the
            // command line below is a fact about what launched this process.
            // `SessionBus` says exactly that: a file inside a vault the user has
            // already authorised opens, and one from outside every vault is
            // refused rather than adopting its folder as a new root.
            open_file::handle_launch(
                app,
                args,
                Path::new(&cwd),
                open_file::LaunchChannel::SessionBus,
            );
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(open_file::PendingOpen::default())
        .manage(state::WatcherState::default())
        .manage(state::VaultRegistry::default())
        .manage(state::AiState::default())
        .manage(state::KeyVault::default())
        // The agent subsystem's two handles: the engine definitions and the one
        // running engine, and the session the commands above address. Both are
        // empty until a session is started, and both are registered here rather
        // than by whoever starts it: this file is the app's assembly point, and
        // `manage` sets a type's state once — so a start path that tried to
        // install its own would work exactly once and then have nowhere to put
        // the second runtime. What `agent_start` does is *fill* the slots these
        // two already have.
        .manage(state::AgentRuntimeState::default())
        .manage(commands::agent::AgentIpcState::default())
        .setup(|app| {
            // The single-instance plugin has already made its claim by the time this runs — the
            // builder initializes plugins, and Tauri calls this hook later, on `RunEvent::Ready`
            // — so "the guard did not arm" is a fact to report here and not a guess. It comes
            // first in this hook on purpose: the window loop below returns early with `?` when a
            // window cannot be built, and of everything this hook does, this is the one line
            // nothing else in the app records. When the guard held, it says nothing.
            #[cfg(target_os = "linux")]
            instance_guard::report(app.handle());

            // The folders the app's own files live in, before a window exists
            // to ask for them: the config directory the remembered-vault record
            // is written in, and the data directory the key files are written
            // in. Each is named by the module that owns it rather than by a
            // second list here — a vault can CONTAIN either (the folder dialog
            // returns `~/.config` as readily as a notes directory), and every
            // path-confined command serves whatever lies inside the vault it was
            // given, so those two files would be ordinary vault files to a
            // window that went looking for them. `domain::app_owned` is where
            // they are refused.
            let mut owned = Vec::new();
            match state::remembered_vault_dir(app.handle()) {
                Some(dir) => owned.push((AppDir::Configuration, dir)),
                // Reported rather than swallowed: a folder that does not make
                // it into this list is not refused. The app is already degraded
                // without it — the record cannot be read or written either — but
                // which of the two happened is worth a line in the log.
                None => eprintln!("could not resolve the app configuration directory"),
            }
            match storage::key_store::data_dir(app.handle()) {
                Ok(dir) => {
                    // The settings surface's store, built here because it needs the data
                    // directory and there is exactly one moment at which that is known and a
                    // window does not yet exist to ask. It is a path and nothing else — no open
                    // files — so nothing here has to be kept in sync with a disk that may change
                    // under it.
                    app.manage(commands::agent_settings::AgentSettingsState::new(&dir));
                    // The character library (§8's 受管缓存) is the same shape one directory
                    // over, and from the *same* resolved root rather than from
                    // `app.path().app_data_dir()` a second time: two calls to one question are
                    // two answers waiting to differ, and this is the directory
                    // `domain::app_owned::install` marks as the app's own.
                    //
                    // A library that cannot be built is reported rather than fatal — the app
                    // runs without a pet just as it runs without an engine — and the four
                    // character commands D8 proposed are what will read this state. Nothing is
                    // added to `tauri.conf.json`'s `assetProtocol.scope` for it: that scope is
                    // empty on purpose, and `commands/fs.rs` already settled the rule as one
                    // `allow_file` per resolved file and never a directory. A
                    // `desktop-pet/characters/**` entry would hand the whole library to
                    // `asset://` in one line, and nothing would fail — it would simply be
                    // readable.
                    match desktop_pet::CharacterLibrary::new(&dir) {
                        Ok(library) => {
                            // The character this build ships, offered to this data directory
                            // once — see `desktop_pet::bundled`, which is where the sheet's
                            // provenance, the licence position and the once-only rule are
                            // argued. Before `manage`, so a window that opens on the first
                            // frame already has a library holding something to draw. A failure
                            // is reported and not fatal: the app runs without a pet just as it
                            // runs without an engine, and the marker is left unwritten so the
                            // next launch tries again.
                            if let Err(detail) =
                                desktop_pet::seed(&library, &dir, desktop_pet::system_clock()())
                            {
                                eprintln!(
                                    "the desktop pet's shipped character is missing: {detail}"
                                );
                            }
                            app.manage(library);
                        }
                        Err(refusal) => eprintln!(
                            "the desktop pet's character library is unavailable: {refusal:?}"
                        ),
                    }
                    owned.push((AppDir::Data, dir));
                }
                Err(e) => eprintln!("could not resolve the app data directory: {e}"),
            }
            domain::app_owned::install(owned);

            // The desktop pet's backend, built here because it is the first moment an
            // `AppHandle` exists (its window system holds one) and because `manage` sets a
            // type's state once. What it does *not* do is build a window: §7.1 makes the pet
            // window 按需创建, so this installs the thing that can open one and nothing is on
            // screen until a settings page asks. That is also why `desktop-pet.html` is not in
            // `app.windows` — the loop below builds every entry in that list unconditionally, so
            // a config entry would be the pet existing while the feature is off. `tauri.conf.json`
            // needs no entry for the pet at all: the page is served out of `frontendDist` like
            // the editor's, and the pet window's permissions live in `capabilities/`, which
            // `tauri-build` picks up by directory.
            app.manage(state::DesktopPetState::new(app.handle()));

            // The windows `run` above took over from Tauri's own pass, built
            // from their config so nothing about them is duplicated here — and
            // through `main_window::build`, which is the one place a declared
            // window becomes a window, so the clipboard setting that builder
            // carries cannot be forgotten by whichever site builds the next one
            // (`main_window::raise` is the other, and it rebuilds the main window
            // the user has closed).
            for config in app.config().app.windows.iter().filter(|w| !w.create) {
                main_window::build(app.handle(), config)?;
            }
            // `nekowite notes.md`: the first launch's file arrives in our own
            // `argv`, before any window or listener exists. That is this
            // process's own command line — evidence only whatever started this
            // process could have produced — which is what makes it enough to
            // adopt an outside file's folder as the vault. It is resolved and
            // left in managed state — which is also where a later launch's file
            // goes — for the window to collect once its startup has settled.
            let cwd = std::env::current_dir().unwrap_or_default();
            open_file::handle_launch(
                app.handle(),
                std::env::args_os(),
                &cwd,
                open_file::LaunchChannel::CommandLine,
            );
            Ok(())
        })
        // Registering a command here is half of what makes it callable. The other half is
        // `build.rs`'s app manifest, which declares the command to Tauri's ACL so that a window
        // has to be *given* it by a capability file — and a command that is not declared there has
        // no `allow-` permission for any capability to name, so no window can reach it however it
        // is registered here. §7.1's 「后端 IPC 验证调用窗口身份」 is enforced at that layer, and
        // `tests/command_authorisation_test.rs` is where both halves are asserted. So a command
        // added below is a command added in two places, and the failure mode of stopping at one is
        // a refusal at the invoke rather than a window that should not have had it.
        .invoke_handler(tauri::generate_handler![
            commands::fs::read_file,
            commands::fs::stat_file,
            commands::fs::write_file,
            commands::fs::create_new_file,
            commands::fs::delete_file,
            commands::recovery::list_trash,
            commands::recovery::restore_from_trash,
            commands::recovery::clear_trash,
            commands::recovery::list_history,
            commands::recovery::read_history,
            commands::recovery::restore_history,
            commands::fs::list_dir,
            commands::fs::save_attachment,
            commands::fs::resolve_media_path,
            commands::fs::create_dir,
            commands::fs::rename_entry,
            commands::fs::register_vault,
            commands::fs::open_folder_dialog,
            commands::fs::save_file_dialog,
            commands::fs::pick_image_files,
            commands::fs::import_attachment,
            commands::fs::watch_folder,
            commands::ai::ai_complete,
            commands::ai::ai_cancel,
            commands::ai::ai_list_models,
            commands::keys::store_ai_key,
            commands::keys::load_ai_key,
            // The key vault's state, read before either of the two below is offered. Registered
            // here for the reason above: a read no window may make would leave the master-password
            // controls drawing a state nobody could ask about.
            commands::key_vault::key_vault_status,
            commands::keys::set_master_password,
            commands::keys::unlock_vault,
            commands::system::system_accent_color,
            commands::open::take_pending_open,
            // The agent commands. All eight address `AgentIpcState`, whose one
            // slot is empty until `agent_start` fills it, so an invoke before a
            // start is refused with this side's own sentence ("no agent session
            // is running: start one first") rather than with Tauri's missing-state
            // error — which is why the state is managed here, at startup, and not
            // by the start path that fills it.
            commands::agent::agent_start,
            commands::agent::agent_stop,
            commands::agent::agent_open_session,
            commands::agent::agent_set_config_option,
            commands::agent::agent_prompt,
            commands::agent::agent_session_snapshot,
            commands::agent_capabilities::agent_session_capabilities,
            // Session history: the sessions the engine already holds, reopening one, and freeing
            // one. Registered here for the reason above — a command in no handler list is a
            // permission onto a wall — and declared in `build.rs` in the same change, because the
            // two lists are each other's mirror and `command_authorisation_test` compares them.
            commands::agent_sessions::agent_list_sessions,
            commands::agent_sessions::agent_load_session,
            commands::agent_sessions::agent_close_session,
            // Putting a change back that this host performed — the one write on the agent surface
            // that needs no tab, for the notes an agent changed while no window held them.
            // Registered here for the reason above, and gated on the same `main` capability as the
            // rest: the pet window holds none of the `agent_*` surface, and this is the command
            // that writes a vault file.
            commands::agent_recovery::agent_recover_change,
            commands::agent::agent_permission_answer,
            commands::agent::agent_permission_grants,
            commands::agent::agent_permission_grant_revoke,
            commands::agent::agent_cancel_run,
            // The registry (T13a's page): which engines exist, and the two changes a window may
            // make — add a local executable, switch a registration on or off. Registered here for
            // the reason above; its state is the same `AgentRuntimeState` the session commands use,
            // because the definitions a start reads and the definitions a settings page edits must
            // be one registry.
            commands::agent_registry::agent_registry_read,
            commands::agent_registry::agent_registry_add,
            commands::agent_registry::agent_registry_set_enabled,
            // The runtime page (§3.1.4): what this app's engine connection is — the negotiated
            // protocol version, the engine's own name for itself, the authentication it advertises,
            // and the capability report — for a caller with **no session**. Its own file rather
            // than a fifth method on `agent_capabilities.rs`, because the two are different
            // subjects: that one answers about a session this host opened (and refuses an id it did
            // not), and this one about the incarnation the settings dialog can see without one.
            commands::agent_runtime::agent_runtime_read,
            // The ACP catalogue: what the public registry publishes, which other clients support
            // many engines from. A *read* and nothing else — it parses and describes, and the
            // §3.3 checks a download would owe travel with it so the page can say why it offers no
            // install action. Registered here for the reason above.
            commands::agent_catalogue::agent_catalogue_read,
            // The configuration surface (T12): the profile a settings page manages, and the
            // documents it edits. Registered here for the reason above — this file is the one
            // place the handler list is written — and its state is managed in `setup`, where the
            // data directory it is built from first exists.
            commands::agent_settings::agent_profile_read,
            commands::agent_settings::agent_profile_write,
            commands::agent_settings::agent_config_document,
            commands::agent_settings::agent_config_edit,
            commands::agent_settings::agent_credentials_write,
            // The skills page (§8.2): what the engine finds, what an import would install, and the
            // switch that moves one skill out of the engine's reach. Registered here for the reason
            // above, and its state is the same `AgentSettingsState` the profile commands use — the
            // roots these scopes are built from are that profile's, so a second store of profiles
            // would be a second answer about which directories the page is describing.
            commands::agent_skills::agent_skills_read,
            commands::agent_skills::agent_skills_preview,
            commands::agent_skills::agent_skills_import,
            commands::agent_skills::agent_skills_set_enabled,
            // The desktop pet's window surface (§7.1). Every one of these answers from
            // `DesktopPetState`, whose host is the only thing that mints a window label — and
            // the two that act on a window take it as the caller Tauri reports rather than as
            // an argument, which is where §7.1's 「前端不能自选任意 label」 is enforced. The
            // settings half of D1's `PetGateway` is served by the two commands below,
            // `desktop_pet_care_read` answers from the ledger, which is not a file but the
            // process's own state — so that read is an answer this build can give in full — and
            // the other three of its calls are answered here too rather than refused: the
            // **task** half is `desktop_pet_tasks`, which reads the projection the runtime's own
            // frames feed (`desktop_pet/task_feed.rs`) instead of the "command not found" it
            // used to be; `desktop_pet_appearance` is what the window draws, and it grants the
            // one sheet file it resolves rather than a directory; and `desktop_pet_open_task`
            // raises `main` and publishes the key the window read from the list above.
            // `desktop_pet_library` and `desktop_pet_import_character` are the settings page's
            // character picker. Nothing the pet's own contract asks for is unanswered now.
            //
            // Which of them a given window may actually call is not decided here and not by
            // this list. Registering a command is what makes it callable at all; the
            // capability files are what hand it out, and the pet window holds eight — the
            // three added to this list with the task feed, the five it already had, and no more.
            //
            // `desktop_pet_update_settings` is the pet's switch: writing `general.characterWindow`
            // or `general.ball` is what opens and closes a window, and the same write carries the
            // two sizes the windows are built at. That is why `desktop_pet_open` — which had no
            // caller until it landed — is only ever reached through it.
            commands::desktop_pet::desktop_pet_state,
            commands::desktop_pet::desktop_pet_windows,
            commands::desktop_pet::desktop_pet_open,
            commands::desktop_pet::desktop_pet_disable,
            commands::desktop_pet::desktop_pet_set_visible,
            commands::desktop_pet::desktop_pet_close_own,
            commands::desktop_pet::desktop_pet_set_click_through,
            commands::desktop_pet::desktop_pet_capabilities,
            commands::desktop_pet::desktop_pet_care_read,
            commands::desktop_pet::desktop_pet_tasks,
            commands::desktop_pet::desktop_pet_appearance,
            commands::desktop_pet::desktop_pet_host_appearance,
            commands::desktop_pet::desktop_pet_publish_host_appearance,
            commands::desktop_pet::desktop_pet_library,
            commands::desktop_pet::desktop_pet_import_character,
            commands::desktop_pet::desktop_pet_catalogue,
            commands::desktop_pet::desktop_pet_adopt_character,
            commands::desktop_pet::desktop_pet_open_task,
            commands::desktop_pet::desktop_pet_read_settings,
            commands::desktop_pet::desktop_pet_update_settings,
            commands::desktop_pet::desktop_pet_open_settings,
            commands::desktop_pet_navigation::desktop_pet_take_settings_requests,
            commands::desktop_pet_navigation::desktop_pet_take_task_requests,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            // **Closing the main window ends the pet with it.**
            //
            // `main_window.rs`'s header states the state this arm exists for, and states it as the
            // reason that module was written: the wry runtime leaves only when its window map is
            // empty, and the pet's windows are in that map. So closing the main window used to
            // leave a process with nothing to show — still holding the single-instance name, still
            // running the engine and the watchers, with a pet on the desktop the reader could no
            // longer reach a setting for. The maintainer reported it as 「软件退出的时候桌宠没有退出」,
            // which is what that state looks like from the outside.
            //
            // The main window is *destroyed* rather than hidden (`main_window.rs` traces the whole
            // path, ending in the API's own `destroy()`), so `Destroyed` is the event that fires
            // exactly once per close and cannot be prevented — which makes it the one honest hook
            // for this. `CloseRequested` would not do: a JS listener exists for it, so Tauri
            // prevents the native close and the window is destroyed a moment later anyway.
            //
            // The pet is closed through `PetWindowHost::disable`, the same call the feature switch
            // makes when it goes off, so "every pet window is gone" has one implementation. The
            // ball goes first there and the character windows after, which is the order that call
            // documents.
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = &event
            {
                if label == crate::main_window::LABEL {
                    if let Some(pet) = app.try_state::<state::DesktopPetState>() {
                        match pet.host.lock() {
                            Ok(mut host) => {
                                let report = host.disable();
                                // Reported and not fatal, for the reason the commands give: a
                                // window the compositor refused to close is worth a line in the
                                // log, and by this point there is no window left to show it in.
                                for refusal in &report.failed {
                                    eprintln!(
                                        "nekowite: a pet window outlived the main window: {refusal:?}"
                                    );
                                }
                            }
                            Err(_) => eprintln!(
                                "nekowite: the pet's window host was poisoned, so its windows \
                                 outlive the main window"
                            ),
                        }
                    }
                }
            }

            // **The engine is stopped here, and nowhere else on this path.**
            //
            // `App::run` finishes by calling `std::process::exit` — Tauri's own documentation for
            // it says so, and the call is at `tauri-2.11.5/src/app.rs:1346`. `process::exit` does
            // not run destructors, so the managed `AgentRuntimeState` is never dropped and
            // `AgentInstance`'s `Drop` — which releases the registration and signals the engine's
            // process group (§6.2) — never runs.
            //
            // **What that costs, measured rather than argued.** This paragraph used to say 「every
            // quit left an `opencode` behind」, and that was wrong. `tests/agent_exit_teardown_test.rs`
            // closed the real app twice, once with this arm and once without it: the engine was
            // gone 1.00–1.60s after the quit with the arm and 0.80–1.00s without, and the two
            // distributions overlap. `opencode` 1.18.29 leaves on its own when its stdin closes,
            // which the app's exit does. So this is not what stops an orphan engine, and a reader
            // should not believe it is.
            //
            // What it does do is the thing that had no owner: **release the registration and reap
            // the child, inside the event loop, before the process goes.** Those were the two
            // halves that were missing — the engine died unnoticed, so its claim stayed held and
            // the next start was refused with `AlreadyRunning` until the app was quit, and its
            // process was never collected. What reaches them is this callback: Tauri calls it
            // before `cleanup_before_exit` and before the process exits (`app.rs:1430-1437`).
            //
            // The teardown is synchronous. It asks the connection to stop — which drops the senders
            // and returns; the engine itself leaves 0.1–0.3s later, and the bounded `SIGTERM`/
            // `SIGKILL` sequence behind it is for an engine that does not — so the process leaves
            // shortly afterwards rather than waiting on a signal that is never needed.
            //
            // The work is `agent_stop`'s, called through the same function for the reason that
            // function's own doc gives: two callers that spell the teardown separately are two
            // teardowns that come apart. Nothing here is reported to a window — at this point
            // there is no window to report to — so a refusal is written where the next reader of
            // a log will find it and the process still leaves.
            if let tauri::RunEvent::Exit = event {
                let Some(runtime_state) = app.try_state::<state::AgentRuntimeState>() else {
                    return;
                };
                let Some(ipc) = app.try_state::<commands::agent::AgentIpcState>() else {
                    return;
                };
                if let Err(failure) =
                    commands::agent::stop_running_engine(app, &runtime_state, &ipc)
                {
                    eprintln!(
                        "nekowite: the engine was not stopped on the way out: {}",
                        failure.message
                    );
                }
            }
        });
}
