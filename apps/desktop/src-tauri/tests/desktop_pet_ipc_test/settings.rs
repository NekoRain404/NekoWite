//! A settings write over the real IPC entry, and the window it resizes while that window is up.
//!
//! **Why this is a file of its own.** The target's header divides its cases by behaviour domain
//! (§13.1's rule for a test that outgrows a page), and this is the settings half of the surface
//! `commands.rs` drives: that file is about which windows *exist* — open, close, hide,
//! click-through — while the subject here is a stored record (§5.3), applied at the revision the
//! caller read, whose effect on the pet that is already on screen is a resize. A change to what a
//! stored setting does to a window is what makes this file change, and nothing here moves a
//! window's existence.
//!
//! **What no lower layer can see.** `desktop_pet_settings_test/geometry.rs` drives
//! `apply_window_geometry` with a record and a host it built itself, and it is where the arithmetic
//! is asserted. The *road* a real write travels is only reachable from here:
//! `desktop_pet_update_settings` resolving the app's data directory, applying the record at the
//! revision it was read, publishing it, moving the windows, and answering the caller — which is
//! where a size the user saved either reaches the window they are looking at or does not.
//!
//! **Who sends the write, and which window it moves.** The caller is `main`:
//! `capabilities/default.json` grants it `allow-desktop-pet-update-settings`, and
//! `capabilities/desktop-pet.json` withholds the command from `pet-*` on purpose — writing
//! `general.characterWindow` or `general.ball` *is* the switch (§5.1), so a decoration that could
//! send one would be a second, unguarded way to drive the feature (the ACL half is asserted in
//! `command_authorisation_test.rs`). The pet window is what the write *moves*, and it is the same
//! fake window system every case in this target uses.
//!
//! **What cannot be observed from here, said rather than implied.** The fake records the resizes
//! that landed; `refuse_resize` is the state a compositor that will not resize a window is in, and
//! the command's answer to it is still `applied`, with the refusal written to stderr — the setting
//! *was* saved and what could not follow it is a window, which is `apply_window_geometry`'s own
//! reason for logging rather than returning it. So the refusal case asserts what this wire and the
//! surface do carry: the record was applied, the window that refused is not among the resizes, the
//! windows after it still are, and the size the next window is opened at is the one the user chose.
//!
//! **Why `XDG_DATA_HOME` is redirected.** `desktop_pet_update_settings` resolves
//! `app.path().app_data_dir()` on every call — `dirs::data_dir()` joined with the config's
//! identifier, which is empty under `mock_context` — so without a redirect a case would read and
//! write the records of whoever runs the suite. Each case gets a scratch tree inside this crate's
//! git-ignored `target/` and holds it for the whole body: the variable is the process's, and
//! `cargo test` runs one binary's tests on threads of ONE process (`agent_skills_ipc_test.rs`'s
//! `with_home` is the same arrangement on `HOME`).
//!
//! The app under test and the two request helpers are `commands.rs`'s, imported rather than copied
//! — the reason `care.rs` gives for importing `wiring.rs`'s harness: a second copy is a second
//! place for the IPC request shape to drift.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

use nekowite_lib::desktop_pet::settings::values::defaults;
use nekowite_lib::desktop_pet::settings::{PetSettingsDomain, PET_SETTINGS_INITIAL_REVISION};
use nekowite_lib::desktop_pet::window_host::{character_window_size, BALL_LABEL};

use crate::commands::{app, ok, window};
use crate::support::MAIN_WINDOW;

// ---------------------------------------------------------------------------
// The write, and the data directory it resolves
// ---------------------------------------------------------------------------

/// One settings write, as the page that owns the record sends it: the domain's whole field set, at
/// the revision the caller read.
///
/// The values are the schema's own defaults with the fields under test moved, never a patch: §5.3's
/// write carries a domain, so a body assembled by hand here would be a second copy of the field
/// list the schema exists to be the only one of.
fn settings_write(domain: PetSettingsDomain, changes: &[(&str, Value)]) -> Value {
    let mut values = defaults(domain);
    for (field, value) in changes {
        values.insert((*field).to_string(), value.clone());
    }
    json!({
        "write": {
            "domain": domain.id(),
            "revision": PET_SETTINGS_INITIAL_REVISION,
            "values": Value::Object(values),
        }
    })
}

/// Open one character's window the way the settings page does, and answer the label the host minted.
fn open_character(
    main: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    character: &str,
) -> String {
    let opened = ok(
        main,
        "desktop_pet_open",
        json!({ "characterId": character }),
    );
    opened["label"]
        .as_str()
        .expect("the host answers with the label it minted")
        .to_string()
}

/// The process's `XDG_DATA_HOME`, which on Linux is the whole of where a data directory comes from.
///
/// The two cases below are the only ones in this target that need it: every other command here
/// answers from managed state, while `desktop_pet_update_settings` reads and writes a file under
/// the directory the app resolves — the one of whoever runs the suite, if nothing redirects it.
static DATA_HOME: Mutex<()> = Mutex::new(());

/// The redirect, put back when it goes out of scope — a case that fails included, or the next one
/// would resolve its records inside the tree the failing case left behind.
///
/// The mutex is a field rather than a local for the same reason: the variable is the process's, so
/// two cases must not be in a body at the same time.
struct RedirectedDataHome {
    previous: Option<OsString>,
    _turn: std::sync::MutexGuard<'static, ()>,
}

impl Drop for RedirectedDataHome {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(previous) => std::env::set_var("XDG_DATA_HOME", previous),
            None => std::env::remove_var("XDG_DATA_HOME"),
        }
    }
}

/// Run one case's body with the app's data directory pointed at a scratch tree of its own.
fn with_data_home<T>(label: &str, body: impl FnOnce() -> T) -> T {
    // The lock is taken before the previous value is read, and not after: read first, a second case
    // would capture the first case's scratch path as the value to restore.
    let turn = DATA_HOME.lock().unwrap_or_else(|error| error.into_inner());
    let redirect = RedirectedDataHome {
        previous: std::env::var_os("XDG_DATA_HOME"),
        _turn: turn,
    };
    std::env::set_var("XDG_DATA_HOME", scratch(label));
    let out = body();
    drop(redirect);
    out
}

/// A scratch data tree inside the repository — this crate's `target/`, which is git-ignored — named
/// after the case and removed on entry, so a record a killed run left behind cannot be what a case
/// passes on (the convention `desktop_pet_settings_test/support.rs` states for the same reason).
fn scratch(label: &str) -> PathBuf {
    let data = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/desktop-pet-ipc-settings")
        .join(format!("{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).expect("a scratch data directory");
    data
}

// ---------------------------------------------------------------------------
// The write that lands, and the one a compositor refuses
// ---------------------------------------------------------------------------

/// **A saved size reaches the window that is already up.** §5.2's slider is about the pet the user
/// can see, and before `apply_window_geometry` existed the stored number moved nothing: a window
/// was opened once at whatever the host held and stayed there.
///
/// The write in the middle is the real one — `desktop_pet_update_settings`, from a real window,
/// through the data directory the app resolves — and what it has to do is resize `pet-1` rather
/// than mint a second window or reload the page that window is drawing.
#[test]
fn a_saved_size_resizes_the_pet_window_that_is_already_open() {
    with_data_home("resize", || {
        let pet = app();
        let main = window(&pet, MAIN_WINDOW);
        let label = open_character(&main, "cat");
        let opens = pet.surfaces.opened().len();

        let applied = ok(
            &main,
            "desktop_pet_update_settings",
            settings_write(
                PetSettingsDomain::Character,
                &[("characterId", json!("cat")), ("size", json!(320))],
            ),
        );

        assert_eq!(applied["status"], "applied", "{applied}");
        assert_eq!(applied["record"]["domain"], "character");
        // The revision the store issued: the write was built on the one the caller read (§5.3), and
        // a record that came back at the initial revision would be one that was never persisted.
        assert_eq!(applied["record"]["revision"], 1);
        // The number that reached the window is the number the record now holds, read out of the
        // answer rather than written a second time here — a rule that resized to something of its
        // own would fail at this line.
        let saved = applied["record"]["values"]["size"]
            .as_f64()
            .expect("the record carries the size it was written with");
        assert_eq!(saved, 320.0);
        assert_eq!(
            pet.surfaces.state().resized,
            vec![(label.clone(), character_window_size(saved))]
        );

        // A resize is not an open: no window was minted, and the one that moved is the one that was
        // there, still drawing the page it was already drawing.
        assert_eq!(pet.surfaces.opened().len(), opens);
        assert_eq!(
            pet.surfaces.live(),
            vec![BALL_LABEL.to_string(), label.clone()]
        );
    });
}

/// **A refused resize is not a failed write, and it does not end the loop.**
///
/// The compositor is the one part of this that a fake can only be put in the state of, and
/// `refuse_resize` is that state: the branch `apply_window_geometry` answers by logging. What the
/// app does about it is asserted here rather than assumed — the record is applied, because the
/// setting *was* saved and the user's answer is the file's; the window that refused is not among
/// the resizes, because a refused resize is not one that landed; the window after it still is,
/// because one window's refusal says nothing about the next; and the size the following window is
/// opened at is the one the user chose, because the preference is the host's either way.
///
/// The refusal is planted on the **first** window on purpose: that is the arrangement in which an
/// early return is visible in what the fake recorded, the argument `windows.rs` makes for the hide
/// that refuses. Nothing on this wire names the refusal — the caller sees a saved setting — which is
/// the cost asserted at the end rather than a behaviour invented here.
#[test]
fn a_refused_resize_keeps_the_saved_size_and_still_asks_the_windows_after_it() {
    with_data_home("refused-resize", || {
        let pet = app();
        let main = window(&pet, MAIN_WINDOW);
        let first = open_character(&main, "cat");
        let second = open_character(&main, "dog");
        pet.surfaces.state().refuse_resize.push(first);

        let applied = ok(
            &main,
            "desktop_pet_update_settings",
            settings_write(
                PetSettingsDomain::Character,
                &[("characterId", json!("cat")), ("size", json!(320))],
            ),
        );

        assert_eq!(applied["status"], "applied", "{applied}");
        assert_eq!(applied["record"]["values"]["size"], 320);
        // What the surface recorded is what landed: the window that refused is not in it and the
        // window after it is — a loop that stopped at the refusal would leave this list empty.
        assert_eq!(
            pet.surfaces.state().resized,
            vec![(second, character_window_size(320.0))],
            "the window after the refusing one was not asked"
        );

        // And the preference survived, which is what the refusal costs the user: the window that
        // refused stays where it was, and the next one is opened at the size they chose.
        let third = open_character(&main, "fox");
        assert_eq!(third, "pet-3");
        assert_eq!(
            pet.surfaces.last_character_open().size,
            character_window_size(320.0)
        );
    });
}
