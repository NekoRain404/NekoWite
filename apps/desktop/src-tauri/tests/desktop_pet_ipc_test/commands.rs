//! The pet's command surface, driven through Tauri's own IPC entry.
//!
//! `windows.rs` and `access.rs` next door drive `PetWindowHost`'s methods; this file drives the
//! `#[tauri::command]` shims above them, which is the layer §7.1's identity rule actually lives
//! on. The difference matters and is the reason for a separate domain file: the host's methods
//! take a `CallerWindow` as an argument, so a test that hands them one is asserting about a value
//! it just built. Here the caller is a real `WebviewWindow` under `MockRuntime` and the request
//! goes through `tauri::test::get_ipc_response`, so the label the host sees is the one the
//! *windowing system* reports for the window the call came from — and a forged label has nowhere
//! to be sent.
//!
//! Four things are asserted here that no lower layer can assert:
//!
//! - **The main window cannot close a pet window**, and a pet window can close itself. Both are
//!   the same command with no window argument, invoked from two different windows.
//! - **`tauri.conf.json` declares no pet window.** §7.1 makes the pet 按需创建, and the config's
//!   window list is built unconditionally at startup — so an entry there is a pet window that
//!   exists while the feature is off. This is the counter-intuitive half of the wiring, and it is
//!   an assertion rather than a note in a report.
//! - **The page vocabulary is D1's.** `desktop_pet_open_settings` validates the page against a
//!   list compiled into this side, so the list is read off the TypeScript contract here. A page
//!   added on one side alone fails this test instead of opening nothing at runtime.
//! - **The care read answers what the ledger holds and no more.** An empty ledger is answered with
//!   no summary at all rather than with zeroes (§8's 「token 未知不是 0」), and asking is not
//!   writing: two reads leave the ledger — revision included — where they found it.

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::Listener;

use nekowite_lib::commands::desktop_pet as pet_commands;
use nekowite_lib::commands::desktop_pet::{
    PET_FEATURE_CHANNEL, PET_SETTINGS_CHANNEL, SETTINGS_PAGES,
};
use nekowite_lib::desktop_pet::care_ledger::{
    CareEvent, CareOrigin, CareOutcome, LocalDay, LocalTime,
};
use nekowite_lib::desktop_pet::{
    Closed, HostRefusal, PetInstance, TeardownReport, DESKTOP_PET_PAGE, MEAL_XP,
};
use nekowite_lib::state::DesktopPetState;
use tauri::Manager;

use crate::support::{FakeSurfaces, MAIN_WINDOW};

// ---------------------------------------------------------------------------
// The wire surface
// ---------------------------------------------------------------------------
//
// These ten wrappers exist because `generate_handler!` resolves a command through the
// `__cmd__<name>` macro `#[tauri::command]` emits next to it, and that macro is `pub(crate)` to
// the library — a test in a separate crate cannot register the library's commands, however
// public the functions are. So the registration happens here, with the same parameter names (the
// names *are* the wire contract: `@tauri-apps/api` passes the argument object verbatim, so
// `character_id` is what the front end must spell `characterId`), and each body is the
// library's own function. What is under test is the library's code; what is written here is the
// registration and nothing else.

#[tauri::command]
fn desktop_pet_state(
    state: tauri::State<'_, DesktopPetState>,
) -> Result<pet_commands::PetFeatureState, String> {
    pet_commands::desktop_pet_state(state)
}

#[tauri::command]
fn desktop_pet_windows(
    state: tauri::State<'_, DesktopPetState>,
) -> Result<Vec<PetInstance>, String> {
    pet_commands::desktop_pet_windows(state)
}

#[tauri::command]
fn desktop_pet_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DesktopPetState>,
    character_id: String,
) -> Result<PetInstance, HostRefusal> {
    pet_commands::desktop_pet_open(app, state, character_id)
}

#[tauri::command]
fn desktop_pet_disable<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DesktopPetState>,
) -> Result<TeardownReport, String> {
    pet_commands::desktop_pet_disable(app, state)
}

#[tauri::command]
fn desktop_pet_set_visible<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DesktopPetState>,
    visible: bool,
) -> Result<pet_commands::PetFeatureState, HostRefusal> {
    pet_commands::desktop_pet_set_visible(app, state, visible)
}

#[tauri::command]
fn desktop_pet_close_own<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DesktopPetState>,
) -> Result<Closed, HostRefusal> {
    pet_commands::desktop_pet_close_own(window, app, state)
}

#[tauri::command]
fn desktop_pet_set_click_through<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, DesktopPetState>,
    ignore: bool,
) -> Result<(), HostRefusal> {
    pet_commands::desktop_pet_set_click_through(window, state, ignore)
}

#[tauri::command]
fn desktop_pet_capabilities(
    state: tauri::State<'_, DesktopPetState>,
) -> Result<Vec<nekowite_lib::desktop_pet::CapabilityReport>, String> {
    pet_commands::desktop_pet_capabilities(state)
}

#[tauri::command]
fn desktop_pet_care_read(
    state: tauri::State<'_, DesktopPetState>,
) -> Result<pet_commands::PetCareRead, String> {
    pet_commands::desktop_pet_care_read(state)
}

#[tauri::command]
fn desktop_pet_open_settings<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    page: String,
) -> Result<(), String> {
    pet_commands::desktop_pet_open_settings(app, page)
}

/// The app under test: the pet's command surface, over the same fake window system the host's
/// own tests use.
struct Pet {
    app: tauri::App<tauri::test::MockRuntime>,
    surfaces: FakeSurfaces,
}

fn app() -> Pet {
    let surfaces = FakeSurfaces::new();
    let app = mock_builder()
        // The state the commands address, built with a substitute window system: `PetSurfaces`
        // is the port the real adapter implements, so what is substituted is the product's own
        // shape rather than a smaller one written for the test.
        .manage(DesktopPetState::with_surfaces(Box::new(surfaces.clone())))
        .invoke_handler(tauri::generate_handler![
            desktop_pet_state,
            desktop_pet_windows,
            desktop_pet_open,
            desktop_pet_disable,
            desktop_pet_set_visible,
            desktop_pet_close_own,
            desktop_pet_set_click_through,
            desktop_pet_capabilities,
            desktop_pet_care_read,
            desktop_pet_open_settings,
        ])
        .build(mock_context(noop_assets()))
        .expect("the pet's command surface builds");
    Pet { app, surfaces }
}

/// A window the IPC can arrive from, under the label the caller is identified by.
fn window(pet: &Pet, label: &str) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
    tauri::WebviewWindowBuilder::new(&pet.app, label, tauri::WebviewUrl::default())
        .build()
        .expect("a window")
}

/// One invoke, as the webview sends it: the command name and a JSON body.
///
/// The URL is local because an app command from a remote origin is refused by Tauri's ACL check
/// before any of this crate runs — and every window here is a local page, which is what makes
/// the refusals below *this* code's rather than the framework's.
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

fn ok(window: &tauri::WebviewWindow<tauri::test::MockRuntime>, cmd: &str, body: Value) -> Value {
    call(window, cmd, body).unwrap_or_else(|error| panic!("{cmd} refused: {error}"))
}

#[test]
fn a_pet_window_closes_itself_and_the_main_window_is_refused_by_name() {
    let pet = app();
    let main = window(&pet, MAIN_WINDOW);
    // The character window the host mints is real to the fake, and the webview that answers as
    // it is created with that label — which is the only way this test can be about *the*
    // window rather than about a string it chose.
    let opened = ok(&main, "desktop_pet_open", json!({ "characterId": "cat" }));
    assert_eq!(opened["label"], "pet-1");
    assert_eq!(opened["characterId"], "cat");
    let character = window(&pet, "pet-1");

    let refused = call(&main, "desktop_pet_close_own", Value::Null)
        .expect_err("the main window must not be able to close a pet window");
    assert_eq!(
        refused,
        json!({ "reason": "unrecognized-caller", "observed": MAIN_WINDOW })
    );
    assert_eq!(
        pet.surfaces.live(),
        vec!["pet-1".to_string()],
        "a refused close must leave the window alone"
    );

    let closed = ok(&character, "desktop_pet_close_own", Value::Null);
    assert_eq!(closed["label"], "pet-1");
    assert!(pet.surfaces.live().is_empty());
    assert_eq!(pet.surfaces.state().closed, vec!["pet-1".to_string()]);
}

#[test]
fn click_through_is_the_callers_own_property_and_nobody_elses() {
    let pet = app();
    let main = window(&pet, MAIN_WINDOW);
    ok(&main, "desktop_pet_open", json!({ "characterId": "cat" }));
    let character = window(&pet, "pet-1");

    let refused = call(
        &main,
        "desktop_pet_set_click_through",
        json!({ "ignore": true }),
    )
    .expect_err("the main window is not a pet window");
    assert_eq!(refused["reason"], "unrecognized-caller");
    assert!(
        !pet.surfaces.state().click_through.contains_key("pet-1"),
        "a refused request must not reach the window system"
    );

    ok(
        &character,
        "desktop_pet_set_click_through",
        json!({ "ignore": true }),
    );
    assert_eq!(pet.surfaces.state().click_through.get("pet-1"), Some(&true));
}

#[test]
fn the_feature_state_is_published_when_it_changes() {
    // The hole D3 reported: `feature()` answers when asked, and nothing told a mounted window
    // that the answer had changed. §7.1 makes the settings page the way back to a hidden pet, so
    // a hide has to arrive at the window rather than wait for it to ask again.
    let pet = app();
    let seen: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    pet.app.listen(PET_FEATURE_CHANNEL, move |event| {
        // `Event::payload()` is the serialized frame, so what a listener reads here is the same
        // JSON a window's `listen` hands its callback.
        sink.lock()
            .expect("the listener's lock")
            .push(parse(event.payload()));
    });
    let main = window(&pet, MAIN_WINDOW);

    ok(&main, "desktop_pet_open", json!({ "characterId": "cat" }));
    let state = ok(
        &main,
        "desktop_pet_set_visible",
        json!({ "visible": false }),
    );
    assert_eq!(state, json!({ "enabled": true, "visible": false }));
    let report = ok(&main, "desktop_pet_disable", Value::Null);

    assert_eq!(
        report["closed"],
        json!([{ "label": "pet-1", "characterId": "cat" }])
    );
    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            json!({ "enabled": true, "visible": true }),
            // Hide is not disable: the instance is still there, so the feature is still on and only
            // the drawing stopped (§7.1).
            json!({ "enabled": true, "visible": false }),
            json!({ "enabled": false, "visible": false }),
        ]
    );
}

#[test]
fn the_window_list_is_a_read_and_says_nothing_a_request_could_name() {
    let pet = app();
    let main = window(&pet, MAIN_WINDOW);
    assert_eq!(ok(&main, "desktop_pet_windows", Value::Null), json!([]));
    ok(&main, "desktop_pet_open", json!({ "characterId": "cat" }));
    assert_eq!(
        ok(&main, "desktop_pet_windows", Value::Null),
        json!([{ "id": 1, "label": "pet-1", "characterId": "cat" }])
    );
    assert_eq!(
        ok(&main, "desktop_pet_state", Value::Null),
        json!({ "enabled": true, "visible": true })
    );
}

#[test]
fn a_capability_that_was_not_measured_is_not_reported_as_supported() {
    let pet = app();
    let main = window(&pet, MAIN_WINDOW);
    let report = ok(&main, "desktop_pet_capabilities", Value::Null);
    let entries = report.as_array().expect("a list of findings").clone();
    assert_eq!(entries.len(), 11, "§7.2's eleven rows");
    // Nothing was measured on this machine (D13's matrix is where that happens), so the honest
    // answer is `unverified` for the ten a compositor decides, and `unavailable` for the one this
    // app does not offer at all — never `available`, and never a finding without a fallback.
    let statuses: Vec<&str> = entries
        .iter()
        .map(|entry| entry["finding"]["status"].as_str().unwrap_or_default())
        .collect();
    assert!(!statuses.contains(&"available"));
    for entry in &entries {
        if entry["finding"]["status"] != "available" {
            assert!(
                entry["finding"]["fallback"].is_string() && entry["finding"]["detail"].is_string(),
                "an unavailable capability that omits its fallback leaves the user to guess: {entry}"
            );
        }
    }
    let climb = entries
        .iter()
        .find(|entry| entry["capability"] == "window-climb")
        .expect("window-climb is one of the rows");
    assert_eq!(climb["finding"]["status"], "unavailable");
}

#[test]
fn a_settings_request_names_a_page_the_host_knows() {
    let pet = app();
    let main = window(&pet, MAIN_WINDOW);
    let asked: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&asked);
    main.listen(PET_SETTINGS_CHANNEL, move |event| {
        sink.lock()
            .expect("the listener's lock")
            .push(parse(event.payload()));
    });

    let refused = call(
        &main,
        "desktop_pet_open_settings",
        json!({ "page": "wallet" }),
    )
    .expect_err("a page that is not one of §5.1's is refused");
    assert!(
        refused.as_str().unwrap_or_default().contains("wallet"),
        "the refusal names what it refused: {refused}"
    );
    assert!(asked.lock().unwrap().is_empty());

    ok(
        &main,
        "desktop_pet_open_settings",
        json!({ "page": "character" }),
    );
    assert_eq!(*asked.lock().unwrap(), vec![json!({ "page": "character" })]);
}

#[test]
fn the_page_vocabulary_is_the_typescript_one() {
    // Read off disk rather than trusted, the way `capabilities.rs` reads §7.2's two vocabularies:
    // the two lists are the same decision, and a page added on one side alone would otherwise be
    // a right-click that opens nothing.
    let config = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/platform/gateways/pet-contracts/config.ts");
    let text = fs::read_to_string(&config).unwrap_or_else(|error| panic!("{config:?}: {error}"));
    let pages = quoted(&slice_between(
        &text,
        "PET_SETTINGS_PAGES = [",
        "] as const",
    ));
    assert_eq!(pages, SETTINGS_PAGES.to_vec());
}

#[test]
fn the_config_declares_no_pet_window() {
    // The counter-intuitive half of this task's wiring. `lib.rs` builds every window
    // `tauri.conf.json` declares, unconditionally, at startup — so a pet entry there would be a
    // pet window that exists while the feature is off, which is the "second application" §7.1
    // forbids. The window the host opens is created on demand instead, and this is what says so.
    let app = mock_builder()
        .build(tauri::generate_context!())
        .expect("the app's own tauri.conf.json builds a context");
    let windows = &app.config().app.windows;
    assert_eq!(
        windows.len(),
        1,
        "the config declares the editor window and nothing else"
    );
    for window in windows {
        assert_eq!(window.label, MAIN_WINDOW);
        let url = format!("{:?}", window.url);
        assert!(
            !url.contains("desktop-pet"),
            "the pet's page must not be a config window: {url}"
        );
    }
    // And the page it *does* open exists, so "created on demand" is a window that loads
    // something rather than a window that loads nothing.
    let page = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../{DESKTOP_PET_PAGE}"));
    assert!(page.is_file(), "the pet's page is missing: {page:?}");
}

#[test]
fn a_ledger_nothing_settled_into_answers_with_no_totals_at_all() {
    // §8's 「token 未知不是 0」 at the read: an empty ledger has totals (`xp: 0`, `meals: 0`) and
    // sending them would have the care page draw level 0 for a user who has completed hundreds of
    // runs. The assertion is not "the numbers are zero" but "there are no numbers on this wire" —
    // the payload is the status and nothing else, so a surface cannot draw a total it was not
    // given.
    let pet = app();
    let main = window(&pet, MAIN_WINDOW);

    let read = ok(&main, "desktop_pet_care_read", Value::Null);

    assert_eq!(read, json!({ "status": "empty" }));
    let keys: Vec<&String> = read.as_object().expect("an object").keys().collect();
    assert_eq!(keys, ["status"], "an empty ledger must carry no summary");
}

#[test]
fn what_the_ledger_settled_is_what_the_read_carries() {
    let pet = app();
    let main = window(&pet, MAIN_WINDOW);
    settle_one_completion(&pet);

    let read = ok(&main, "desktop_pet_care_read", Value::Null);

    // The nesting is the contract's: a status, and the summary as the ledger's own `summary()`
    // serialized it. `local.rs` pins its key set exactly (camelCase, and no `level`, `stage` or
    // price); what this asserts is that the read hands that object on unmodified rather than
    // reshaping it into something a page would have to un-know.
    assert_eq!(read["status"], "current");
    let summary = &read["summary"];
    assert_eq!(summary["xp"], MEAL_XP);
    assert_eq!(summary["meals"], 1);
    assert_eq!(summary["streakDays"], 1);
    assert_eq!(summary["unlocked"], json!([]));
    assert_eq!(
        summary["days"],
        json!([{ "day": "2026-09-16", "completions": 1, "tokens": 4200 }])
    );
    assert_eq!(summary["reportedTokens"], 4200);
    assert_eq!(summary["unreportedRuns"], 0);
    assert_eq!(summary["lastSettledAt"], 1_789_000_000_000i64);
    assert_eq!(summary["revision"], 1);
}

#[test]
fn the_care_read_is_a_read_and_not_a_write() {
    // A read that bumped the revision would turn every look at the care page into a conflict for
    // whatever else writes the ledger, and a read that settled something would pay a run twice if
    // it were asked twice. Both are asserted here rather than reasoned about: the ledger is
    // compared with itself across two reads, revision included.
    let pet = app();
    let main = window(&pet, MAIN_WINDOW);
    settle_one_completion(&pet);
    let before = revision(&pet);

    let first = ok(&main, "desktop_pet_care_read", Value::Null);
    let second = ok(&main, "desktop_pet_care_read", Value::Null);

    assert_eq!(first, second);
    assert_eq!(revision(&pet), before);
    assert_eq!(first["summary"]["revision"], before);
}

/// One trusted completion in the state's ledger, as the settlement path would deliver it.
fn settle_one_completion(pet: &Pet) {
    let state = pet.app.state::<DesktopPetState>();
    let mut ledger = state.ledger.lock().expect("the ledger's lock");
    ledger
        .settle(CareEvent {
            key: "run-1",
            outcome: CareOutcome::TurnFinished,
            at: LocalTime {
                day: LocalDay {
                    year: 2026,
                    month: 9,
                    day: 16,
                },
                hour: 9,
                at_ms: 1_789_000_000_000,
            },
            tokens: Some(4_200),
            origin: CareOrigin::Real,
        })
        .expect("a real completion settles");
}

/// The state's ledger revision, read the way the read command reads it.
fn revision(pet: &Pet) -> u64 {
    let state = pet.app.state::<DesktopPetState>();
    let ledger = state.ledger.lock().expect("the ledger's lock");
    ledger.revision()
}

/// One event frame, as JSON.
fn parse(payload: &str) -> Value {
    serde_json::from_str(payload).unwrap_or_else(|error| panic!("{payload}: {error}"))
}

/// The text between two markers, or a panic naming the marker that moved.
fn slice_between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
    let from = text
        .find(start)
        .unwrap_or_else(|| panic!("the contract no longer contains {start:?}"))
        + start.len();
    let to = text[from..]
        .find(end)
        .unwrap_or_else(|| panic!("{start:?} is no longer closed by {end:?}"));
    &text[from..from + to]
}

/// Every single-quoted name in a slice, in order.
fn quoted(slice: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = slice;
    while let Some(open) = rest.find('\'') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('\'') else { break };
        names.push(after[..close].to_string());
        rest = &after[close + 1..];
    }
    names
}
