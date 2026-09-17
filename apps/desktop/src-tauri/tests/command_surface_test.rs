//! The policy table, read as the table it is: which commands exist, and which window holds each.
//!
//! Split out of `command_authorisation_test.rs`, which had reached 809 lines against a budget of
//! 800. The seam is the one that file's own section headings already drew, and it is a seam
//! between two kinds of evidence rather than between two sizes:
//!
//! - **That file drives the real IPC entry.** It builds the app from `tauri::generate_context!()`,
//!   creates real `WebviewWindow`s under `MockRuntime` and sends real `InvokeRequest`s, so what it
//!   proves is that *Tauri consults the ACL* — behaviour, observed through the framework.
//! - **This file reads three source files.** No app, no window, no invoke. What it proves is that
//!   the four hand-kept lists (`build.rs`'s `COMMANDS`, `lib.rs`'s `invoke_handler!` and the two
//!   capability files) agree with one another — a fact about the text of the repository, which is
//!   the only place it can be seen and which no amount of IPC driving can reach.
//!
//! The second is the weaker kind of evidence and it is the one that catches the silent direction:
//! a command in the handler list that `build.rs` omits is **a command no window can reach**, and
//! the app still builds, the command still exists, and only its caller notices. A permission
//! added to the wrong capability file is the same shape. So both tests are kept exactly as they
//! were — moved, not rewritten, with every assertion intact.
//!
//! ## Why the counts below are asserted rather than bounded
//!
//! `70` and the pet's eight are not round numbers to relax when the surface grows. Each is a
//! statement that the *whole* surface was enumerated rather than sampled, and a count that was
//! quietly lowered to let a change through would take the enumeration with it: a list read short
//! passes every other assertion here, because the other assertions compare two derivations of the
//! same truncated read. When the surface genuinely grows the number moves with it, in the same
//! change, and the diff says so.

use serde_json::Value;

/// Every command `build.rs` declares, in the order the manifest lists them.
///
/// Read from the source rather than from the generated ACL, because the generated ACL is derived
/// from this file: reading it back would compare `build.rs` with itself.
fn declared_commands() -> Vec<String> {
    let source =
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("build.rs"))
            .expect("build.rs declares the surface");
    let list = source
        .split("const COMMANDS: &[&str] = &[")
        .nth(1)
        .and_then(|rest| rest.split("];").next())
        .expect("build.rs's command list");
    list.lines()
        .filter_map(|line| line.trim().strip_prefix('"'))
        .filter_map(|line| line.split('"').next())
        .map(str::to_string)
        .collect()
}

/// One capability file, parsed.
fn capability(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("capabilities")
        .join(name);
    serde_json::from_str(
        &std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} is part of the policy: {e}", path.display())),
    )
    .unwrap_or_else(|e| panic!("{} is not JSON: {e}", path.display()))
}

/// The `allow-` permissions one capability hands out, in the order it lists them.
fn allows(value: &Value) -> Vec<String> {
    value["permissions"]
        .as_array()
        .expect("a capability's permissions")
        .iter()
        .filter_map(|p| p.as_str())
        .filter(|p| p.starts_with("allow-"))
        .map(str::to_string)
        .collect()
}

/// The two lists that have to stay each other's mirror.
///
/// `build.rs`'s `COMMANDS` and `lib.rs`'s `invoke_handler!` are two spellings of one surface, and
/// each can be wrong in its own direction:
///
/// - A name in `build.rs` that no handler registers is an `allow-` permission for a command
///   nothing answers — a capability could hand a window a door onto a wall.
/// - A name in the handler list that `build.rs` omits is a command **no window can reach**, and
///   the failure surfaces at runtime as an invoke refused for a reason nothing in the handler list
///   explains. That is the direction a change to the surface can introduce, and it is silent by
///   construction: the app still builds, the command still exists, and only its caller notices.
///
/// So the two are compared here rather than trusted. This is a text read, which is a weaker kind
/// of evidence than the IPC tests in the sibling target — but the fact it guards is about the
/// source files themselves, and those are the only place it can be seen.
#[test]
fn the_manifest_and_the_handler_list_name_the_same_commands() {
    let source = |name: &str| -> String {
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(name))
            .unwrap_or_else(|e| panic!("{name} is part of the surface: {e}"))
    };

    let declared: Vec<String> = {
        let build = source("build.rs");
        let list = build
            .split("const COMMANDS: &[&str] = &[")
            .nth(1)
            .and_then(|rest| rest.split("];").next())
            .expect("build.rs's command list");
        list.lines()
            .filter_map(|line| line.trim().strip_prefix('"'))
            .filter_map(|line| line.split('"').next())
            .map(str::to_string)
            .collect()
    };

    let registered: Vec<String> = {
        let lib = source("src/lib.rs");
        let list = lib
            .split("generate_handler![")
            .nth(1)
            .and_then(|rest| rest.split("])").next())
            .expect("lib.rs's handler list");
        // The handler list is commented — most of its entries carry a paragraph explaining why
        // they are registered where they are — so the extraction keeps the entries and drops
        // everything else rather than the other way round. A line qualifies by being a
        // `commands::<module>::<name>,` entry, which is also what makes a renamed module fail
        // here instead of being silently skipped.
        list.lines()
            .filter_map(|line| line.trim().strip_suffix(','))
            .filter(|line| line.starts_with("commands::"))
            .filter_map(|line| line.rsplit("::").next())
            .map(str::to_string)
            .collect()
    };

    assert_eq!(
        declared, registered,
        "every declared command is registered, and every registered command is declared"
    );
}

/// `capabilities/` read as the table it is, one row per command.
///
/// The IPC tests in the sibling target are the evidence that the policy is consulted; this one is
/// the evidence that it is the policy somebody meant. It is the same two facts stated from the
/// other side — the pet's permissions are exactly the eight, and the main window's are every
/// declared command except the two that belong to a pet window alone — so a permission added to
/// the wrong file fails here even if no test happens to invoke that command.
///
/// The eight are the *app commands*; the pet's windows also hold two `core:event` permissions and
/// one `core:window` one, and those three are the only thing in these files that is not this app's
/// own surface. The window one is asserted below by name, because it is the permission the pet's
/// drag is made of and it is the one a second `core:window:` line would quietly enlarge.
#[test]
fn the_capability_files_are_the_policy_and_nothing_else() {
    // Every name `build.rs` declares, read from the manifest that declares them. A permission
    // outside this set does not exist, so listing one fails the build long before this runs.
    let declared: Vec<String> = declared_commands()
        .iter()
        .map(|command| format!("allow-{}", command.replace('_', "-")))
        .collect();
    assert_eq!(
        declared.len(),
        79,
        "the declared surface is seventy-nine commands"
    );

    let pet: Vec<String> = allows(&capability("desktop-pet.json"));
    assert_eq!(
        pet,
        vec![
            "allow-desktop-pet-state",
            "allow-desktop-pet-set-visible",
            "allow-desktop-pet-close-own",
            "allow-desktop-pet-set-click-through",
            "allow-desktop-pet-open-settings",
            // The three the pet's own page makes and nothing else does: the task list it renders
            // (`tauri-pet.ts`'s `tasks`, read by `use-pet-window.ts:176`), the appearance it draws
            // (`connection.appearance()`, `:108`), and the click on a bubble that asks the app's
            // window to open the task (`connection.openTask`, `:196`). The picker's two —
            // `desktop_pet_library` and `desktop_pet_import_character` — are *not* here: the
            // settings page in `main` is what chooses a character, and the pet draws the one it
            // was already told to draw.
            "allow-desktop-pet-tasks",
            "allow-desktop-pet-appearance",
            "allow-desktop-pet-open-task",
        ],
        "the pet window holds eight of this app's commands and no others"
    );

    // The pet's own file, read for the one permission in it that is not an app command. It is the
    // whole of what either of the pet's windows may do to a *window*, and both of them hold it:
    // the orb since the drag landed, and the character window since its sprite became a drag
    // handle (`DesktopPetRoot.vue`). A second `core:window:` permission here fails this case and
    // has to be argued in the same change — which is what keeps "the drag costs one permission and
    // no position, geometry or monitor read" a fact about the file rather than a paragraph about
    // the design.
    let window_permissions: Vec<String> = capability("desktop-pet.json")["permissions"]
        .as_array()
        .expect("a capability's permissions")
        .iter()
        .filter_map(|permission| permission.as_str())
        .filter(|permission| permission.starts_with("core:window:"))
        .map(str::to_string)
        .collect();
    assert_eq!(
        window_permissions,
        vec!["core:window:allow-start-dragging"],
        "the pet's windows may start a drag of themselves, and move a window no other way"
    );

    // The ball's own file, named by the label `ball.rs` mints. It was a *widening* of the pet's
    // boundary when it was written — the character window could move nothing, so granting
    // `start-dragging` to the ball alone kept `pet-*` as tight as it was — and it is a **subset**
    // of the pet's now: the same permission is in `desktop-pet.json` for both surfaces, and this
    // file grants it to one named window. Asserted here so neither array can grow quietly — the
    // next permission added to this file fails this case and has to be argued in the same commit.
    let ball = capability("desktop-pet-ball.json");
    assert_eq!(
        ball["windows"],
        serde_json::json!(["pet-ball"]),
        "one window, named: the ball's own file still states the ball's boundary"
    );
    assert_eq!(
        ball["permissions"],
        serde_json::json!(["core:window:allow-start-dragging"]),
        "one permission, and it is not an app command: the compositor does the moving"
    );

    let main: Vec<String> = allows(&capability("default.json"));
    let expected: Vec<String> = declared
        .iter()
        .filter(|permission| {
            !matches!(
                permission.as_str(),
                "allow-desktop-pet-close-own" | "allow-desktop-pet-set-click-through"
            )
        })
        .cloned()
        .collect();
    assert_eq!(
        main, expected,
        "the main window holds every declared command except the two that are a pet window's own"
    );
}
