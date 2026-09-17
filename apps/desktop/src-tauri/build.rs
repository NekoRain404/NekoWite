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
//! | `main` | `capabilities/default.json` | all seventy below, except the two that are the pet window's own |
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

use std::{env, path::PathBuf};

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
    // The permissions the engine has written down because the user answered "always": read from
    // the engine's own route, and removed through it.
    "agent_permission_grants",
    "agent_permission_grant_revoke",
    "agent_cancel_run",
    // The engine registry.
    "agent_registry_read",
    "agent_registry_add",
    "agent_registry_set_enabled",
    // The ACP catalogue: what the public registry publishes, which other clients support many
    // engines from. Declared here like any other command — a handler registered without a
    // declaration is a command no window can reach, and the refusal names a permission that
    // does not exist.
    "agent_catalogue_read",
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
    "desktop_pet_catalogue",
    "desktop_pet_adopt_character",
    "desktop_pet_open_task",
    "desktop_pet_read_settings",
    "desktop_pet_update_settings",
    "desktop_pet_open_settings",
];

fn main() {
    check_sidecar();
    tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(COMMANDS)))
        .expect("Tauri's build helpers (config, ACL app manifest, resources) succeed");
}

/// The file `bundle.externalBin` names, at the path Tauri looks for it.
///
/// `tauri.conf.json` says `binaries/opencode`, and Tauri appends the target triple itself — plus
/// `.exe` on Windows — in `tauri_utils::resources::external_binaries`, which `tauri-build` does not
/// re-export, so the rule is mirrored here instead of imported. A wrong path here is not silent:
/// the check below names the file it looked for, and `tauri-build`'s own copy step would still fail
/// on the file the config really names.
fn sidecar_path() -> PathBuf {
    let triple = env::var("TARGET").expect("cargo sets TARGET for build scripts");
    let extension = if triple.contains("windows") {
        ".exe"
    } else {
        ""
    };
    PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("opencode-{triple}{extension}"))
}

/// Whether the engine has to be on disk for *this* build: that is, whether a package could be cut
/// from it. Two signals, and either is enough to answer yes.
///
/// - `DEP_TAURI_DEV` is the value behind `tauri-build`'s own `is_dev()`, and it is `"false"` exactly
///   when the Tauri CLI compiled this with `tauri/custom-protocol` — which `tauri build` does and
///   `tauri dev` does not. Unset is treated as "unknown" rather than as a failure, so a Tauri that
///   renames this metadata cannot break a checkout that builds today.
/// - `PROFILE` is cargo's name for the profile being compiled, and a package is cut from `release`.
///   It is the signal that catches `cargo build --release` run without the CLI: that is the same
///   binary `tauri build` would have produced, but it enables no feature, so the first signal calls
///   it dev.
///
/// Each signal alone has a hole — `tauri build --debug` packages from a debug profile, a bare
/// `cargo build --release` is production without the CLI — and the failure this file exists to
/// prevent, a package that ships without its engine, is the one direction worth erring in: a release
/// build nobody meant to bundle is asked for the engine and told how to get it.
fn is_production_build() -> bool {
    let cli_says_production = env::var("DEP_TAURI_DEV").is_ok_and(|dev| dev == "false");
    let release_profile = env::var("PROFILE").is_ok_and(|profile| profile != "debug");
    cli_says_production || release_profile
}

/// The engine is a build input, and its absence is the expected state of a fresh checkout.
///
/// Those two facts have to be reconciled, because `tauri-build` copies `externalBin`'s input in
/// *every* build — `cargo check`, `cargo test` and `cargo clippy` included — and fails the build
/// when it is not there. That is how CI died: a clean checkout has no engine (184 MB, deliberately
/// gitignored, produced by a pipeline), so `cargo test` never reached a test, `cargo build` never
/// ran, and `cargo clippy` and `cargo fmt` were skipped behind it. A gate nobody can reach is not a
/// gate.
///
/// So the absence is fatal only where it means something — a build a package can be cut from — and
/// everywhere else it is a warning naming the script that fixes it, with `externalBin` dropped from
/// the config `tauri-build` is about to read so its copy step does not look for a file that is not
/// there. Nothing is smuggled past the check: there is no file to copy, so no copy is skipped, and
/// an absence that *would* reach a package is still a failed build.
///
/// The alternative was having CI run `scripts/fetch-opencode-linux.sh`. It would work, and it would
/// cost 184 MB per run to satisfy a step that builds no package, leave a fresh clone unable to run
/// `cargo test` until the download finished, and make CI depend on the npm registry answering.
fn check_sidecar() {
    let sidecar = sidecar_path();
    if sidecar.exists() {
        return;
    }
    if is_production_build() {
        panic!(
            "the bundled engine is missing: {path} does not exist.\n\
             \n\
             `bundle.externalBin` in tauri.conf.json names that file, and the package built from \
             this tree is meant to carry an engine — a user gets the bundled one whether or not \
             they have one of their own. Nothing here can invent it: it is a pinned 184 MB download \
             that is deliberately not in git.\n\
             \n\
             Install it with:  bash scripts/fetch-opencode-linux.sh\n\
             \n\
             That script downloads the version the release pins and verifies its sha512 before \
             extracting it. This check runs for builds a package can be cut from (`tauri build`, or \
             a release profile); `cargo check`, `cargo test`, `cargo clippy` and `tauri dev` build \
             without the engine and warn instead.",
            path = sidecar.display()
        );
    }

    // A fetch script run after this build is what makes the file appear, and cargo only re-runs a
    // build script when a watched path *changes*: a path that was missing when the fingerprint was
    // recorded is not seen to change when it arrives, so watching the file itself would leave the
    // engine uncopied beside the binary until something unrelated was edited. The directory it
    // would land in does change, so that is what is watched — and created first, because a fresh
    // checkout has no `binaries/` at all (nothing in an empty gitignored directory is tracked, and
    // the fetch script creates it too).
    let binaries = sidecar.parent().expect("the sidecar path has a parent");
    let _ = std::fs::create_dir_all(binaries);
    println!("cargo:rerun-if-changed={}", binaries.display());
    println!(
        "cargo:warning=the bundled engine is not on disk ({path}) — this build is not a production \
         one, so it proceeds without an engine; run `bash scripts/fetch-opencode-linux.sh` before \
         building a package",
        path = sidecar.display()
    );

    // The one knob that reaches the config before `tauri-build` reads `externalBin`. It is a JSON
    // merge patch, so `null` removes the key. When it is already set, the Tauri CLI is passing a
    // `--config` override of the caller's own, which is merged *after* anything put here and would
    // bring `externalBin` straight back — so clobbering it would either drop their override or fail
    // anyway with a message that no longer explains why. Saying so, and letting `tauri-build` report
    // the missing file, is the honest half of that trade.
    if env::var_os("TAURI_CONFIG").is_some() {
        println!(
            "cargo:warning=TAURI_CONFIG is already set, so this build cannot leave \
             `bundle.externalBin` out of the config and will fail in tauri-build's copy step; the \
             engine above is the thing to fix"
        );
        return;
    }
    env::set_var("TAURI_CONFIG", r#"{"bundle":{"externalBin":null}}"#);
}
