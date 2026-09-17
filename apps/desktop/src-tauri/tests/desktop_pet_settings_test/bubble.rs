//! §5.2's 气泡与消息 as a pet window receives it: the bubble's background alpha, on the appearance
//! read.
//!
//! `message.opacity` is a stored value, and the surface that draws it is the bubble inside the
//! character window — which may not read a settings domain at all
//! (`capabilities/desktop-pet.json` holds no `desktop_pet_read_settings`). So the alpha reaches a
//! window the way the drawing facts and the motion policy do: as a field of the appearance read
//! ([`stored_bubble_opacity`] + `character_view::appearance`), which is what these cases drive.
//!
//! **This is the defect, restated as tests.** The value used to live in the `view` domain as a
//! *window* opacity, drawn as a control on 常规与交互 and read by nothing at all: upstream's
//! `ap_opacity` is the bubble's own `--bubble-bg` alpha (`windows/src/main.ts:88-100`), no crate in
//! this build exposes a window-opacity call, and the field now sits where upstream drew it. Three
//! claims follow, and the third is the one a wrong implementation breaks silently:
//!
//! - **What the store holds is what a window is handed.** A write of `opacity: 0.7` through the
//!   store's own revision-checked path is visible in the next read, and a store nothing has written
//!   answers the schema's own default — upstream's 92 — rather than nothing.
//! - **The alpha is on every arm.** A window with no character still draws the bubble above its
//!   notice, so `unset` carries it too.
//! - **A record this build may not read is not guessed at.** A `message` file from a newer build is
//!   §10.2's read-only arm, and the answer there is this build's default: a transparency the user
//!   never chose is a change to what they see, not a fallback.

use std::fs;

use serde_json::{json, Value};

use nekowite_lib::desktop_pet::character_view::{
    appearance, stored_bubble_message, stored_bubble_opacity, stored_motion,
};
use nekowite_lib::desktop_pet::settings::values::defaults;
use nekowite_lib::desktop_pet::settings::{
    PetSettingsDomain, PetSettingsLoad, PetSettingsStore, PetSettingsUpdate, PetSettingsWrite,
    PET_SETTINGS_INITIAL_REVISION, PET_SETTINGS_SCHEMA_VERSION,
};
use nekowite_lib::desktop_pet::window_host::stored_ball_size;
use nekowite_lib::desktop_pet::{BubbleMessage, BubbleOpacity, PetAppearance};

use crate::support;

/// One domain's values as a write submits them: the schema's defaults with the changes applied.
fn submitted(domain: PetSettingsDomain, changes: &[(&str, Value)]) -> Value {
    let mut values = defaults(domain);
    for (field, value) in changes {
        values.insert((*field).to_string(), value.clone());
    }
    Value::Object(values)
}

/// The appearance a window is handed, read the way `desktop_pet_appearance` reads it: the
/// character record from the store, the policy from `general` beside it, and the alpha from
/// `message`.
fn window_read(store: &PetSettingsStore) -> PetAppearance {
    let record = store
        .read(PetSettingsDomain::Character)
        .record()
        .expect("a character record is always answerable, defaults included")
        .clone();
    appearance(
        &record,
        stored_motion(store),
        stored_bubble_opacity(store),
        stored_bubble_message(store),
        stored_ball_size(store),
        None,
    )
}

/// The alpha out of an appearance, whichever arm it is.
fn alpha_of(read: &PetAppearance) -> f64 {
    match read {
        PetAppearance::Unset { bubble_opacity, .. }
        | PetAppearance::Missing { bubble_opacity, .. }
        | PetAppearance::Ready { bubble_opacity, .. } => *bubble_opacity,
    }
}

#[test]
fn the_alpha_a_window_is_handed_is_the_one_the_store_holds() {
    let (store, _data) = support::store("bubble-follows");

    // Nothing has been written: the schema's own default, and the cross-check on the assumption
    // below is the schema's own table rather than a literal — the value upstream's slider opens on,
    // and the one a declared default that moved would fail here instead of leaving every window on
    // the old one.
    assert_eq!(
        defaults(PetSettingsDomain::Message)
            .get("opacity")
            .and_then(Value::as_f64),
        Some(0.92),
        "`message.opacity` is declared with 0.92 as its default"
    );
    assert_eq!(stored_bubble_opacity(&store), BubbleOpacity::DEFAULT);
    assert_eq!(alpha_of(&window_read(&store)), 0.92);

    let outcome = store.apply(&PetSettingsWrite {
        domain: PetSettingsDomain::Message,
        revision: PET_SETTINGS_INITIAL_REVISION as f64,
        values: submitted(PetSettingsDomain::Message, &[("opacity", json!(0.7))]),
    });
    assert!(
        matches!(outcome, PetSettingsUpdate::Applied { .. }),
        "the write is the one the settings page makes: {outcome:?}"
    );

    // The next read a window performs carries it — this is the fix: before it, the value was
    // stored, drawn as a control and read by nothing that draws.
    assert_eq!(stored_bubble_opacity(&store).value(), 0.7);
    assert_eq!(alpha_of(&window_read(&store)), 0.7);

    // And back, so the alpha is read rather than latched.
    store.apply(&PetSettingsWrite {
        domain: PetSettingsDomain::Message,
        revision: PET_SETTINGS_INITIAL_REVISION as f64 + 1.0,
        values: submitted(PetSettingsDomain::Message, &[("opacity", json!(1.0))]),
    });
    assert_eq!(alpha_of(&window_read(&store)), 1.0);
}

#[test]
fn an_alpha_outside_the_rule_is_repaired_by_the_store_and_not_drawn() {
    let (store, _data) = support::store("bubble-out-of-rule");

    // Past the floor: a value that would leave a bubble whose text cannot be read. The write is
    // refused whole (§5.3), so what a window is handed afterwards is still the value it had.
    let refused = store.apply(&PetSettingsWrite {
        domain: PetSettingsDomain::Message,
        revision: PET_SETTINGS_INITIAL_REVISION as f64,
        values: submitted(PetSettingsDomain::Message, &[("opacity", json!(0.05))]),
    });
    assert!(
        matches!(refused, PetSettingsUpdate::Refused { .. }),
        "a value outside the rule never reaches the file: {refused:?}"
    );
    assert_eq!(alpha_of(&window_read(&store)), 0.92);

    // And a file somebody edited by hand takes the rule's fallback on the way out, reported as a
    // repair rather than read as-is.
    let mut planted = submitted(PetSettingsDomain::Message, &[]);
    planted["opacity"] = json!("gone");
    fs::create_dir_all(store.root()).expect("the records directory");
    fs::write(
        store.path_of(PetSettingsDomain::Message),
        json!({
            "domain": "message",
            "schemaVersion": PET_SETTINGS_SCHEMA_VERSION,
            "revision": 3,
            "values": planted,
        })
        .to_string(),
    )
    .expect("a hand-edited record");

    assert_eq!(alpha_of(&window_read(&store)), 0.92);
}

#[test]
fn the_alpha_rides_the_appearance_a_fresh_install_draws() {
    // No character has been chosen and this store holds no library: `appearance` answers `unset`,
    // which is the state a new user is in — and the bubble is drawn above that notice, which is
    // why the alpha may not be a field of the `ready` arm alone.
    let (store, _data) = support::store("bubble-unset");
    assert!(matches!(window_read(&store), PetAppearance::Unset { .. }));
    assert_eq!(alpha_of(&window_read(&store)), 0.92);
}

#[test]
fn a_message_record_from_a_newer_build_leaves_the_alpha_where_this_build_built_it() {
    let (store, _data) = support::store("bubble-newer");
    fs::create_dir_all(store.root()).expect("the records directory");
    fs::write(
        store.path_of(PetSettingsDomain::Message),
        json!({
            "domain": "message",
            "schemaVersion": PET_SETTINGS_SCHEMA_VERSION + 1,
            "revision": 9,
            "values": { "opacity": 0.3 },
        })
        .to_string(),
    )
    .expect("a record from the future");
    let before =
        fs::read_to_string(store.path_of(PetSettingsDomain::Message)).expect("the planted file");

    assert!(matches!(
        store.read(PetSettingsDomain::Message),
        PetSettingsLoad::ReadOnly { .. }
    ));
    // §10.2: the record states a choice this build may not act on, so it is not read — and the
    // window is not handed a transparency that came from a file this build does not understand.
    // The default is the honest answer, and the file is left exactly as it was found.
    assert_eq!(alpha_of(&window_read(&store)), 0.92);
    assert_eq!(
        fs::read_to_string(store.path_of(PetSettingsDomain::Message)).expect("still there"),
        before
    );
}

// ---------------------------------------------------------------------------
// The rest of the domain: what the bubble says, and how it lays its rows out
// ---------------------------------------------------------------------------

/// The bubble's content model out of an appearance, whichever arm it is.
///
/// A second helper rather than a wider `alpha_of`: the two fields ride the same read for the same
/// reason, and the reason a case reads one is never the reason it reads the other.
fn bubble_of(read: &PetAppearance) -> &BubbleMessage {
    match read {
        PetAppearance::Unset { bubble, .. }
        | PetAppearance::Missing { bubble, .. }
        | PetAppearance::Ready { bubble, .. } => bubble,
    }
}

/// A `message` record's whole submission, so a write in these cases is the one the page makes.
fn message_write(
    store: &PetSettingsStore,
    revision: f64,
    changes: &[(&str, Value)],
) -> PetSettingsWrite {
    PetSettingsWrite {
        domain: PetSettingsDomain::Message,
        revision,
        values: submitted(PetSettingsDomain::Message, changes),
    }
}

#[test]
fn the_lines_and_the_layout_a_window_is_handed_are_the_ones_the_store_holds() {
    let (store, _data) = support::store("bubble-domain-follows");

    // Nothing has been written: the schema's own defaults, read off the schema's own table rather
    // than restated as literals — a default that moved would fail here instead of leaving every
    // window on the old one.
    let declared = defaults(PetSettingsDomain::Message);
    let fresh = window_read(&store);
    let bubble = bubble_of(&fresh);
    assert_eq!(bubble.mode, declared["layoutMode"].as_str().unwrap());
    assert_eq!(
        bubble.max_tasks,
        declared["layoutMaxRows"].as_u64().unwrap()
    );
    assert_eq!(bubble.grouping, declared["grouping"].as_str().unwrap());
    assert_eq!(bubble.filter, declared["filter"].as_str().unwrap());
    assert_eq!(bubble.separator, declared["separator"].as_str().unwrap());
    assert_eq!(bubble.idle, declared["idle"].as_bool().unwrap());
    assert!(bubble.phrases.is_empty(), "a fresh install has no phrases");
    assert!(bubble.tokens.is_empty(), "and no stored row field list");

    // The write the 气泡与消息 page makes: a phrase the user typed, and a layout.
    let outcome = store.apply(&message_write(
        &store,
        PET_SETTINGS_INITIAL_REVISION as f64,
        &[
            ("quickBubbles", json!(["先喝口水", "整理一下引用"])),
            ("layoutMode", json!("compact")),
            ("layoutMaxRows", json!(3)),
            ("grouping", json!("flat")),
            ("filter", json!("attention")),
            ("separator", json!("arrow")),
            ("idle", json!(false)),
            (
                "tokens",
                json!([{ "token": "dot", "visible": true }, { "token": "message", "visible": true }]),
            ),
        ],
    ));
    assert!(
        matches!(outcome, PetSettingsUpdate::Applied { .. }),
        "the write is the one the settings page makes: {outcome:?}"
    );

    // **This is the defect, as an assertion.** Before this field existed the whole domain was
    // stored, drawn as controls on the page and read by nothing that draws: the bubble was on
    // screen, so a user who wrote a phrase saw a bubble and not their words.
    let after = window_read(&store);
    let bubble = bubble_of(&after);
    assert_eq!(bubble.phrases, vec!["先喝口水", "整理一下引用"]);
    assert_eq!(bubble.mode, "compact");
    assert_eq!(
        bubble.max_tasks, 3,
        "the schema's `layoutMaxRows`, under the renderer's name"
    );
    assert_eq!(bubble.grouping, "flat");
    assert_eq!(bubble.filter, "attention");
    assert_eq!(bubble.separator, "arrow");
    assert!(!bubble.idle);
    assert_eq!(bubble.tokens.len(), 2);
}

#[test]
fn one_field_this_build_cannot_act_on_does_not_take_the_whole_bubble_with_it() {
    let (store, _data) = support::store("bubble-one-bad-field");
    // A file somebody edited by hand, with one field of the wrong kind. §5.3 repairs what cannot be
    // used and reports it; what a window must not do is lose the *other* choices to the one — the
    // fields are independent, so the fallback is per field.
    let mut planted = submitted(PetSettingsDomain::Message, &[]);
    planted["layoutMaxRows"] = json!("many");
    planted["quickBubbles"] = json!(["这一句还在"]);
    planted["layoutMode"] = json!("compact");
    fs::create_dir_all(store.root()).expect("the records directory");
    fs::write(
        store.path_of(PetSettingsDomain::Message),
        json!({
            "domain": "message",
            "schemaVersion": PET_SETTINGS_SCHEMA_VERSION,
            "revision": 4,
            "values": planted,
        })
        .to_string(),
    )
    .expect("a hand-edited record");

    let read = window_read(&store);
    let bubble = bubble_of(&read);
    assert_eq!(
        bubble.max_tasks, 5,
        "the unusable field takes its own fallback"
    );
    assert_eq!(
        bubble.phrases,
        vec!["这一句还在"],
        "and the usable ones are kept"
    );
    assert_eq!(bubble.mode, "compact");
}

#[test]
fn the_bubble_rides_every_appearance_arm_because_the_bubble_is_drawn_in_all_of_them() {
    // The same argument the alpha and the ball's size make, one field wider: the bubble is drawn
    // above the notice and above a sprite alike, so a payload that only arrived with `Ready` would
    // leave a fresh install drawing the built-in layout for a user who chose another.
    let (store, _data) = support::store("bubble-domain-arms");
    store.apply(&message_write(
        &store,
        PET_SETTINGS_INITIAL_REVISION as f64,
        &[
            ("quickBubbles", json!(["在的"])),
            ("layoutMode", json!("carousel")),
        ],
    ));

    let unset = window_read(&store);
    assert!(matches!(unset, PetAppearance::Unset { .. }));
    assert_eq!(bubble_of(&unset).phrases, vec!["在的"]);
    assert_eq!(bubble_of(&unset).mode, "carousel");

    // And on the arm a chosen character takes, with a library that does not hold it. The choice is
    // written the way the settings page writes one, so this is the `Missing` arm a real window
    // reaches rather than an `Unset` one this case talked itself into.
    store.apply(&PetSettingsWrite {
        domain: PetSettingsDomain::Character,
        revision: PET_SETTINGS_INITIAL_REVISION as f64,
        values: {
            let mut values = defaults(PetSettingsDomain::Character);
            values.insert("characterId".to_string(), json!("ghost"));
            Value::Object(values)
        },
    });
    let record = store
        .read(PetSettingsDomain::Character)
        .record()
        .expect("a character record")
        .clone();
    let missing = appearance(
        &record,
        stored_motion(&store),
        stored_bubble_opacity(&store),
        stored_bubble_message(&store),
        stored_ball_size(&store),
        None,
    );
    assert!(matches!(missing, PetAppearance::Missing { .. }));
    assert_eq!(bubble_of(&missing).phrases, vec!["在的"]);
}

/// The theme a window is handed, on each of the three members the schema declares.
///
/// **The defect this closes, as an assertion.** `message.theme` was stored, had a three-way control
/// on 气泡与消息, and crossed nothing: the settings page's own preview acted on it and the bubble on
/// the desktop did not, so a user picked Light, watched the preview change, and their desktop bubble
/// stayed as it was. What the window now receives is the *member*, so which palette it selects is
/// the page's question (`features/desktop-pet/services/pet-bubble-theme.ts`) and never this side's.
#[test]
fn the_bubble_theme_a_window_is_handed_is_the_member_the_store_holds() {
    let (store, _data) = support::store("bubble-theme-follows");

    // Nothing written: the schema's own default, read off the schema's own table rather than
    // restated as a literal, so a default that moved fails here instead of leaving every window on
    // the old one.
    let declared = defaults(PetSettingsDomain::Message);
    assert_eq!(
        bubble_of(&window_read(&store)).theme,
        declared["theme"].as_str().unwrap()
    );

    for member in ["light", "dark", "system"] {
        let store_read = store.read(PetSettingsDomain::Message);
        let revision = store_read.record().expect("a message record").revision;
        let outcome = store.apply(&message_write(
            &store,
            revision as f64,
            &[("theme", json!(member))],
        ));
        assert!(
            matches!(outcome, PetSettingsUpdate::Applied { .. }),
            "the write the settings page makes: {outcome:?}"
        );
        assert_eq!(
            bubble_of(&window_read(&store)).theme,
            member,
            "the member crosses unchanged, so the page is the one place it is resolved"
        );
    }
}

/// The bubble's text size and its dot style, the two fields that crossed with the theme.
///
/// Both were stored, both had (or shared) a control on 气泡与消息, and neither reached the window
/// that draws them: `message.fontSize` is upstream's `ap_font_size`, whose value goes into
/// `--bubble-font-size` (`windows/src/main.ts:88-100`), and `message.dot` is the state dot's style.
#[test]
fn the_bubble_size_and_dot_a_window_is_handed_are_the_ones_the_store_holds() {
    let (store, _data) = support::store("bubble-size-and-dot");

    // Nothing written: the schema's own defaults, off the schema's own table.
    let declared = defaults(PetSettingsDomain::Message);
    let fresh = window_read(&store);
    let bubble = bubble_of(&fresh);
    assert_eq!(bubble.font_size, declared["fontSize"].as_f64().unwrap());
    assert_eq!(bubble.dot, declared["dot"].as_str().unwrap());

    // The write the page makes: the largest size its three buttons offer, and the second dot style.
    let store_read = store.read(PetSettingsDomain::Message);
    let revision = store_read.record().expect("a message record").revision;
    let outcome = store.apply(&message_write(
        &store,
        revision as f64,
        &[("fontSize", json!(14)), ("dot", json!("claude"))],
    ));
    assert!(
        matches!(outcome, PetSettingsUpdate::Applied { .. }),
        "the write the settings page makes: {outcome:?}"
    );
    let after = window_read(&store);
    let bubble = bubble_of(&after);
    assert_eq!(bubble.font_size, 14.0);
    assert_eq!(bubble.dot, "claude");
}

/// A size a hand-edited record carries that the rule would refuse takes the fallback, and the other
/// field of the domain is kept.
///
/// The rule is the schema's (`settings/fields.rs`'s `MESSAGE`, 10–14 whole numbers), and this is the
/// arm a file no build wrote reaches — the same field-by-field reading the layout fields get.
#[test]
fn a_bubble_size_outside_the_rule_is_repaired_without_taking_the_dot_with_it() {
    let (store, _data) = support::store("bubble-size-out-of-rule");
    let mut planted = submitted(PetSettingsDomain::Message, &[]);
    planted["fontSize"] = json!(40);
    planted["dot"] = json!("claude");
    fs::create_dir_all(store.root()).expect("the records directory");
    fs::write(
        store.path_of(PetSettingsDomain::Message),
        json!({
            "domain": "message",
            "schemaVersion": PET_SETTINGS_SCHEMA_VERSION,
            "revision": 2,
            "values": planted,
        })
        .to_string(),
    )
    .expect("a hand-edited record");

    let read = window_read(&store);
    let bubble = bubble_of(&read);
    assert_eq!(
        bubble.font_size, 12.0,
        "the schema's own default, not the stored 40"
    );
    assert_eq!(bubble.dot, "claude", "and the field beside it is kept");
}

#[test]
fn a_message_record_from_a_newer_build_leaves_the_bubble_where_this_build_built_it() {
    let (store, _data) = support::store("bubble-domain-newer");
    fs::create_dir_all(store.root()).expect("the records directory");
    fs::write(
        store.path_of(PetSettingsDomain::Message),
        json!({
            "domain": "message",
            "schemaVersion": PET_SETTINGS_SCHEMA_VERSION + 1,
            "revision": 9,
            "values": { "quickBubbles": ["来自未来的一句"], "layoutMode": "carousel" },
        })
        .to_string(),
    )
    .expect("a record from the future");

    // §10.2 keeps this build from reading it at all, and the answer is this build's own defaults —
    // a layout the user never chose on *this* build is a change to what they see, not a fallback.
    // The same arm `stored_bubble_opacity` takes, and for the same reason.
    let read = window_read(&store);
    let bubble = bubble_of(&read);
    assert!(bubble.phrases.is_empty());
    assert_eq!(bubble.mode, "list");
}
