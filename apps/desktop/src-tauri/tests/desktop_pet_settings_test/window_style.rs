//! §5.2's 窗口行为: `view.alwaysOnTop` as the windows actually receive it.
//!
//! **This is the defect, restated as tests.** The checkbox on 常规与交互 stored a value the window
//! host never read: `PET_WINDOW_STYLE` had `always_on_top: true` baked in, which is upstream's own
//! constant (`references/desktop-pet/windows/src-tauri/src/lib.rs:295,368,463,557` — upstream has
//! no such setting at all), so the control wrote into a file. What hid it was §7.2's capability
//! gate: on a machine whose matrix has not run, `always-on-top` is `unverified` and the box is
//! disabled. On one where it *has* run — the state the plan is working towards — the box is live,
//! and a live box that changes nothing is the "looks available, turns out unsupported" defect
//! §5.2's second clause names.
//!
//! Two moments, and both are here because both are where the value can change:
//!
//! - **A launch.** `feature_switch::restore` reads the store once, and the windows it opens are
//!   opened with the preference — otherwise a pet that starts with the setting on would come up
//!   under it and stay there until the user found the page again.
//! - **An applied write.** `apply_window_style` moves the windows that are already open, which is
//!   what makes the control act on the pet the user is looking at.
//!
//! The default is upstream's: a store with nothing usable in it opens windows exactly as upstream
//! asked for them (`always_on_top: true`), which is what keeps this change from moving an existing
//! install's pet.

use std::fs;

use serde_json::{json, Value};

use nekowite_lib::commands::desktop_pet::{apply_feature_switch, apply_window_style};
use nekowite_lib::desktop_pet::feature_switch::restore;
use nekowite_lib::desktop_pet::settings::values::defaults;
use nekowite_lib::desktop_pet::settings::{
    PetSettingsDomain, PetSettingsRecord, PetSettingsStore, PetSettingsUpdate, PetSettingsWrite,
    PET_SETTINGS_INITIAL_REVISION, PET_SETTINGS_SCHEMA_VERSION,
};
use nekowite_lib::desktop_pet::window_host::{stored_always_on_top, BALL_LABEL, PET_WINDOW_STYLE};
use nekowite_lib::desktop_pet::{PetWindowHost, UNSELECTED_CHARACTER};

use crate::support;

/// One stored record, as a write that was just applied would have produced it.
fn record(domain: PetSettingsDomain, changes: &[(&str, Value)]) -> PetSettingsRecord {
    let mut values = defaults(domain);
    for (field, value) in changes {
        values.insert((*field).to_string(), value.clone());
    }
    PetSettingsRecord {
        domain,
        schema_version: PET_SETTINGS_SCHEMA_VERSION,
        revision: 1,
        values,
    }
}

/// Store one preference through the store's own revision-checked path, the way the page would.
fn write(store: &PetSettingsStore, changes: &[(&str, Value)]) {
    let mut values = defaults(PetSettingsDomain::View);
    for (field, value) in changes {
        values.insert((*field).to_string(), value.clone());
    }
    let outcome = store.apply(&PetSettingsWrite {
        domain: PetSettingsDomain::View,
        revision: PET_SETTINGS_INITIAL_REVISION as f64,
        values: Value::Object(values),
    });
    assert!(
        matches!(outcome, PetSettingsUpdate::Applied { .. }),
        "the write is the one the settings page makes: {outcome:?}"
    );
}

/// What every window was *opened* with, by label.
fn opened_styles(surfaces: &support::FakeSurfaces) -> Vec<(String, bool)> {
    surfaces
        .opened()
        .into_iter()
        .map(|(label, _page)| {
            let on_top = surfaces
                .style_of(&label)
                .expect("every open records the style it was asked for")
                .always_on_top;
            (label, on_top)
        })
        .collect()
}

#[test]
fn a_stored_preference_is_what_the_windows_are_opened_with() {
    let (store, _data) = support::store("style-stored");
    write(&store, &[("alwaysOnTop", json!(false))]);
    assert!(!stored_always_on_top(&store));

    let (mut host, surfaces) = support::host();
    restore(&mut host, &store);

    assert_eq!(host.instances().len(), 1, "the launch brings the pet up");
    let opened = opened_styles(&surfaces);
    // The ball comes up with the character window, and both carry the preference: §5.1's 悬浮球 is
    // one of the pet's windows, and a setting about "the pet's windows" that left one of them in the
    // top of the stack would be a rule with an exception nobody could see.
    assert!(
        opened.iter().any(|(label, _)| label == BALL_LABEL),
        "{opened:?}"
    );
    assert!(
        opened.iter().all(|(_, on_top)| !on_top),
        "every window the launch opened carries the stored preference: {opened:?}"
    );
}

#[test]
fn a_store_with_nothing_usable_in_it_opens_what_upstream_asked_for() {
    // No file at all: a fresh install, which is upstream's own state and its own flags. This is the
    // case that keeps the change from moving an existing install's pet out of the top of the stack.
    let (store, _data) = support::store("style-absent");
    assert!(stored_always_on_top(&store));
    assert!(PET_WINDOW_STYLE.always_on_top);

    let (mut host, surfaces) = support::host();
    restore(&mut host, &store);

    // The declared default of `general.enabled` is on, so a fresh install does come up — under the
    // style upstream asked for.
    let opened = opened_styles(&surfaces);
    assert!(!opened.is_empty(), "a fresh install shows its pet");
    assert!(opened.iter().all(|(_, on_top)| *on_top), "{opened:?}");
}

#[test]
fn a_view_record_from_a_newer_build_is_not_read_as_a_style() {
    let (store, _data) = support::store("style-newer");
    fs::create_dir_all(store.root()).expect("the records directory");
    fs::write(
        store.path_of(PetSettingsDomain::View),
        json!({
            "domain": "view",
            "schemaVersion": PET_SETTINGS_SCHEMA_VERSION + 1,
            "revision": 9,
            "values": { "alwaysOnTop": false, "roam": "stay" },
        })
        .to_string(),
    )
    .expect("a record from the future");
    let before =
        fs::read_to_string(store.path_of(PetSettingsDomain::View)).expect("the planted file");

    // §10.2: the record states a choice this build may not act on. Taking the pet out of the top of
    // the stack on the strength of a file this build cannot read is the direction that *hides* the
    // pet the user asked for, so the answer is the value upstream asked for.
    assert!(stored_always_on_top(&store));
    assert_eq!(
        fs::read_to_string(store.path_of(PetSettingsDomain::View)).expect("still there"),
        before
    );
}

#[test]
fn an_applied_view_write_moves_the_windows_that_are_already_open() {
    let (mut host, surfaces) = support::host();
    let state = apply_feature_switch(
        &mut host,
        &record(PetSettingsDomain::General, &[("enabled", json!(true))]),
        UNSELECTED_CHARACTER,
    );
    assert!(state.is_some(), "the pet is on before this case moves it");

    let applied = apply_window_style(
        &mut host,
        &record(
            PetSettingsDomain::View,
            &[("alwaysOnTop", json!(false)), ("roam", json!("off"))],
        ),
    );
    assert!(applied, "the record is the view domain's");

    // Every open window, and the ball among them — a change that reached only the character window
    // would leave a surface the user cannot put away in the stack they just emptied.
    let changes = surfaces.on_top_changes();
    assert_eq!(changes.len(), host.instances().len() + 1, "{changes:?}");
    assert!(
        changes.iter().any(|(label, _)| label == BALL_LABEL),
        "{changes:?}"
    );
    assert!(changes.iter().all(|(_, on_top)| !on_top), "{changes:?}");
    // And the next window opens under it, which is why the preference is host state rather than an
    // argument to one open.
    assert!(!host.style().always_on_top);
    host.open("second").expect("within the cap");
    assert!(
        opened_styles(&surfaces)
            .last()
            .is_some_and(|(_, on_top)| !on_top),
        "a window opened after the write carries it"
    );
}

#[test]
fn a_write_to_another_domain_touches_no_window() {
    let (mut host, surfaces) = support::host();
    host.open(UNSELECTED_CHARACTER).expect("the pet opens");

    for domain in [
        PetSettingsDomain::General,
        PetSettingsDomain::Message,
        PetSettingsDomain::Character,
    ] {
        assert!(
            !apply_window_style(&mut host, &record(domain, &[])),
            "only the view domain carries a window style"
        );
    }
    assert!(surfaces.on_top_changes().is_empty());
    assert!(host.style().always_on_top);
}

#[test]
fn a_compositor_that_refuses_is_reported_and_does_not_stop_the_other_windows() {
    let (mut host, surfaces) = support::host();
    host.open(UNSELECTED_CHARACTER).expect("the pet opens");
    let refused = host
        .instances()
        .first()
        .expect("the character window")
        .label
        .as_str()
        .to_string();
    surfaces.state().refuse_on_top.push(refused.clone());

    let refusal = host
        .set_always_on_top(false)
        .expect_err("the compositor refused one window");
    // The compositor's own words, under the action that failed: §7.2's row is where the *policy* is
    // stated, and this is the event.
    assert!(
        format!("{refusal:?}").contains("declined"),
        "the refusal carries what the compositor said: {refusal:?}"
    );
    // The ball was still asked, and the preference is kept: a windowing system that failed once is
    // not a reason to forget what the user chose.
    assert!(surfaces
        .on_top_changes()
        .iter()
        .any(|(label, _)| label == BALL_LABEL));
    assert!(!host.style().always_on_top);
}
