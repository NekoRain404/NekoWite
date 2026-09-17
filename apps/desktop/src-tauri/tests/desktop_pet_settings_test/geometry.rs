//! How big the pet's windows are, and the one number behind each of them.
//!
//! Two settings decide two windows' geometry — `character.size` for the window the character is drawn
//! in, `general.ballSize` for the ball's — and both were constants before this: `CHARACTER_WINDOW_SIZE`
//! was upstream's fixed 260x320 whichever way the slider went, and the ball had no field at all. So
//! there are two claims here and they are different claims:
//!
//! - **The window follows the setting**, at both ends of its range and at a launch — the window a
//!   launch opens is the window the stored value asks for, not the default one it would have been
//!   opened at and resized from.
//! - **The window and the drawn box are the same number.** A sprite box and a window derived from two
//!   stored numbers would be the second answer §9 forbids, so what is asserted below is the *shape* of
//!   each rule against the page's own arithmetic: the sprite's aspect is `pet-appearance.ts`'s
//!   `BASE_WIDTH`/`BASE_HEIGHT` and the ball's margin is `PetFloatingBall.vue`'s `BALL_MARGIN`, both
//!   read off disk rather than restated. A page that changed either without this file would fail here,
//!   which is the only way a rule spanning two languages stays one rule — the same technique
//!   `schema.rs` uses for the field tables, and for the same reason.
//!
//! What is *not* asserted: that a compositor honours any of it. `ball-window.md` §5 measured WebKitGTK
//! 4.1 handing back 200x200 for an 80x80 request (the engine's content minimum), so §7.2's 「asked for」
//! is what these numbers are, and the real-window pass is a separate measurement.

use serde_json::json;

use nekowite_lib::commands::desktop_pet_surface::apply_window_geometry;
use nekowite_lib::desktop_pet::feature_switch::restore;
use nekowite_lib::desktop_pet::settings::values::{defaults, fields, Kind};
use nekowite_lib::desktop_pet::settings::{
    PetSettingsDomain, PetSettingsRecord, PetSettingsUpdate, PetSettingsWrite,
    PET_SETTINGS_INITIAL_REVISION, PET_SETTINGS_SCHEMA_VERSION,
};
use nekowite_lib::desktop_pet::window_host::{
    ball_window_size, character_window_size, BALL_DEFAULT_SIZE, BALL_LABEL, BALL_MARGIN,
    CHARACTER_DEFAULT_SIZE, DESKTOP_PET_BALL_PAGE,
};

use crate::support;

/// The text after `marker` on the same line, or a panic naming what moved.
///
/// The same deliberately dumb reading `schema.rs` does, and for the same reason: a clever parser of
/// the other language would be a second implementation of the rule rather than a check on it.
fn declared_after<'a>(text: &'a str, marker: &str) -> &'a str {
    let at = text
        .find(marker)
        .unwrap_or_else(|| panic!("{marker:?} is not in the file"))
        + marker.len();
    let rest = &text[at..];
    let end = rest.find('\n').unwrap_or(rest.len());
    rest[..end].trim()
}

/// The sprite's aspect, as `pet-appearance.ts` states it.
///
/// Returned as the pair of numbers rather than as a ratio, so the failure message names the constant
/// that moved.
fn sprite_aspect_from_the_page() -> (f64, f64) {
    let text =
        support::pet_contract_source("../src/features/desktop-pet/services/pet-appearance.ts");
    let width = declared_after(&text, "const BASE_WIDTH = ")
        .parse::<f64>()
        .expect("BASE_WIDTH is a number");
    let height = declared_after(&text, "const BASE_HEIGHT = ")
        .parse::<f64>()
        .expect("BASE_HEIGHT is a number");
    (width, height)
}

/// The margin the ball's page draws between the orb and the window's edge.
fn ball_margin_from_the_page() -> f64 {
    let text =
        support::pet_contract_source("../src/features/desktop-pet/components/PetFloatingBall.vue");
    declared_after(&text, "const BALL_MARGIN = ")
        .parse::<f64>()
        .expect("BALL_MARGIN is a number")
}

/// One stored record, as a write that was just applied would have produced it.
fn record(domain: PetSettingsDomain, changes: &[(&str, serde_json::Value)]) -> PetSettingsRecord {
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

/// The fallback a domain's own number field declares, which is what the schema says the value is
/// when nothing has been stored.
fn fallback(domain: PetSettingsDomain, field: &str) -> f64 {
    fields(domain)
        .iter()
        .find(|candidate| candidate.name == field)
        .map(|candidate| match candidate.kind {
            Kind::Number { fallback, .. } => fallback,
            other => panic!("{field} is not a number field: {other:?}"),
        })
        .unwrap_or_else(|| panic!("{field} is not a field of {domain:?}"))
}

// ---------------------------------------------------------------------------
// The rule, at both ends of the range the slider offers
// ---------------------------------------------------------------------------

/// **The default is the window this build has always opened.** Upstream's 260x320 (`lib.rs:459`, the
/// same at all four of its builder sites) is what a 160 px character — the schema's own default — has
/// to come out as: a rule that changed the default window would be a change to every existing install
/// rather than the fix this is.
#[test]
fn the_default_size_is_the_window_this_build_has_always_opened() {
    assert_eq!(
        character_window_size(CHARACTER_DEFAULT_SIZE),
        (260.0, 320.0)
    );
}

/// **And it moves with the slider, at both ends.** 64 and 320 are `character.size`'s own bounds
/// (`pet-contracts/config.ts`'s `PET_NUMBER_RULES`), so these are the two windows the rule can be
/// asked for and the two a user can reach.
///
/// The numbers: the sprite's box is `size` wide and `size * 180 / 160` tall (`pet-appearance.ts`'s
/// `box`), upstream's window has 100 px of width and 140 px of height around upstream's own 160x180
/// sprite, and the width never goes below 260 — the bubble's own cap, which a narrower window would
/// squeeze (`the_window_is_never_narrower_than_the_bubble_it_draws`). So 64 → 260x212 (the width
/// floor) and 320 → 420x500.
#[test]
fn the_window_follows_the_size_at_both_ends_of_its_range() {
    assert_eq!(character_window_size(64.0), (260.0, 212.0));
    assert_eq!(character_window_size(320.0), (420.0, 500.0));
    assert!(
        character_window_size(320.0).0 > character_window_size(160.0).0,
        "the widening half of the rule is what the reported defect was about"
    );
}

/// **The window is never narrower than the bubble drawn in it**, at any size the slider offers.
///
/// The cap is read off `pet-bubble-layout.ts` rather than written here, so this is a statement about
/// the surface that is actually drawn: a window narrower than the cap squeezes every reminder row,
/// and the character can be as small as 64 px while a reminder is exactly what the window is for.
/// The lower bound is also what keeps the default window at 260 px rather than at the 164 the sprite
/// alone would ask for.
#[test]
fn the_window_is_never_narrower_than_the_bubble_it_draws() {
    let layout =
        support::pet_contract_source("../src/features/desktop-pet/services/pet-bubble-layout.ts");
    let cap = declared_after(&layout, "export const PET_BUBBLE_MAX_WIDTH =")
        .trim_end_matches(';')
        .parse::<f64>()
        .expect("PET_BUBBLE_MAX_WIDTH is a number");

    for size in 64..=320 {
        let (width, _) = character_window_size(size as f64);
        assert!(
            width >= cap,
            "at {size} the window is {width}px wide and the bubble caps at {cap}px"
        );
    }
}

/// **The sprite is never clipped, at any size the rule allows.** This is the claim the fixed window
/// failed: at 320 the sprite's box was 320x360 and the window was 260x320, so the canvas overflowed
/// the window's top edge by 40 px and the page's own `overflow: hidden` cut it off.
///
/// The aspect is read from `pet-appearance.ts` rather than written here, so this is a statement about
/// *the box the page draws*, not about a copy of it. Every integer size in the rule's range is walked
/// because the failure mode is a rule that holds at the ends and crosses over in between.
#[test]
fn the_sprite_fits_inside_the_window_at_every_size_the_slider_offers() {
    let (base_width, base_height) = sprite_aspect_from_the_page();
    assert_eq!(
        (base_width, base_height),
        (160.0, 180.0),
        "the page's sprite box moved; window_host.rs's SPRITE_ASPECT is the same pair"
    );

    for size in 64..=320 {
        let size = size as f64;
        // The page's own arithmetic (`pet-appearance.ts`'s `box`), applied to the same number.
        let sprite = (size, ((size * base_height) / base_width).round());
        let window = character_window_size(size);
        assert!(
            window.0 >= sprite.0 && window.1 > sprite.1,
            "at {size} the sprite is {sprite:?} and the window is {window:?}"
        );
    }
}

/// **And the ball's is the same shape of rule**: the orb's diameter plus the page's own margin on each
/// side. 56 is upstream's `--ball-size` in its 80 px window, and the margin is read off the page that
/// draws it.
#[test]
fn the_ball_window_is_the_orb_plus_the_margin_the_page_draws() {
    let margin = ball_margin_from_the_page();
    assert_eq!(
        margin, BALL_MARGIN,
        "the page's BALL_MARGIN and ball.rs's are the same number or the orb and its window drift"
    );
    assert_eq!(ball_window_size(BALL_DEFAULT_SIZE), (80.0, 80.0));

    // The page's own box, as it computes it: the orb plus the margin on each side. Read as text
    // because the arithmetic is TypeScript — `props.size + BALL_MARGIN * 2` — and the point of the
    // assertion is that the *shape* of the two rules still agrees, not just the constant.
    let page =
        support::pet_contract_source("../src/features/desktop-pet/components/PetFloatingBall.vue");
    assert!(
        page.contains("props.size + BALL_MARGIN * 2"),
        "the ball's frame is no longer the orb plus two margins; ball.rs's ball_window_size is"
    );
    for orb in [32.0, 56.0, 128.0] {
        assert_eq!(
            ball_window_size(orb),
            (orb + margin * 2.0, orb + margin * 2.0),
            "at an orb of {orb}"
        );
    }
}

/// The two defaults are the schema's, not numbers this file's neighbours chose: a build that opened a
/// window at a size the slider cannot produce would be a window no setting could explain.
#[test]
fn the_defaults_are_the_schema() {
    assert_eq!(
        CHARACTER_DEFAULT_SIZE,
        fallback(PetSettingsDomain::Character, "size")
    );
    assert_eq!(
        BALL_DEFAULT_SIZE,
        fallback(PetSettingsDomain::General, "ballSize")
    );
}

// ---------------------------------------------------------------------------
// What the host asks a compositor for
// ---------------------------------------------------------------------------

/// The character window is opened at the size the host was told, and the default is what it opens at
/// when nobody has told it anything.
#[test]
fn an_opened_character_window_is_the_size_the_host_was_told() {
    let (mut host, surfaces) = support::host();
    assert_eq!(host.character_size(), CHARACTER_DEFAULT_SIZE);

    host.set_character_size(320.0).expect("nothing is open");
    host.open("cat").expect("a window");

    let (label, page) = surfaces
        .character_opens()
        .pop()
        .expect("a character window was opened");
    assert_eq!(page, nekowite_lib::desktop_pet::DESKTOP_PET_PAGE);
    assert_eq!(surfaces.size_of(&label), Some(character_window_size(320.0)));
}

/// The same fact for the ball, which is the window the setting was added for.
#[test]
fn an_opened_ball_window_is_the_size_the_host_was_told() {
    let (mut host, surfaces) = support::host();
    host.set_ball_size(100.0).expect("nothing is open");
    host.ensure_ball().expect("a ball");

    let (label, page) = surfaces.ball_open().expect("the ball was opened");
    assert_eq!(label, BALL_LABEL);
    assert_eq!(page, DESKTOP_PET_BALL_PAGE);
    assert_eq!(surfaces.size_of(BALL_LABEL), Some(ball_window_size(100.0)));
}

/// A size that moves while the window is up resizes it rather than reopening it: the page, the sprite
/// and anything the window was holding stay where they were, and no second window is created.
#[test]
fn a_size_that_moves_resizes_the_window_that_is_already_up() {
    let (mut host, surfaces) = support::host();
    host.open("cat").expect("a window");
    host.ensure_ball().expect("a ball");
    let opened_before = surfaces.opened().len();

    host.set_character_size(320.0).expect("a compositor");
    host.set_ball_size(128.0).expect("a compositor");

    let resizes = surfaces.resizes();
    assert_eq!(
        resizes,
        vec![
            ("pet-1".to_string(), character_window_size(320.0)),
            (BALL_LABEL.to_string(), ball_window_size(128.0)),
        ]
    );
    assert_eq!(
        surfaces.opened().len(),
        opened_before,
        "a resize is not an open: the page is not reloaded and no window is minted"
    );
}

/// A compositor that refuses the resize does not undo the setting: the value is kept, the caller hears
/// the compositor's own words, and the *next* window opens at the new size.
#[test]
fn a_refused_resize_keeps_the_setting() {
    let (mut host, surfaces) = support::host();
    host.open("cat").expect("a window");
    surfaces.state().refuse_resize.push("pet-1".to_string());

    let refusal = host
        .set_character_size(320.0)
        .expect_err("the compositor declined");

    assert_eq!(host.character_size(), 320.0);
    assert!(
        format!("{refusal:?}").contains("declined"),
        "the refusal carries the compositor's own words: {refusal:?}"
    );
}

// ---------------------------------------------------------------------------
// The write path and the launch: the two moments a stored size reaches a window
// ---------------------------------------------------------------------------

/// **A saved `character.size` resizes the window that is showing the character.** This is the setting
/// the slider on 角色与动画 writes, and before `apply_window_geometry` existed it reached no window at
/// all: the window was upstream's constant and the slider moved a number in a file.
#[test]
fn a_saved_character_size_reaches_the_open_window() {
    let (mut host, surfaces) = support::host();
    host.open("cat").expect("a window");

    assert!(apply_window_geometry(
        &mut host,
        &record(PetSettingsDomain::Character, &[("size", json!(320))]),
    ));

    assert_eq!(
        surfaces.resizes(),
        vec![("pet-1".to_string(), character_window_size(320.0))]
    );
    assert_eq!(host.character_size(), 320.0);
}

/// And a saved `general.ballSize` resizes the ball, which is the control this change adds.
#[test]
fn a_saved_ball_size_reaches_the_open_ball() {
    let (mut host, surfaces) = support::host();
    host.ensure_ball().expect("a ball");

    assert!(apply_window_geometry(
        &mut host,
        &record(PetSettingsDomain::General, &[("ballSize", json!(96))]),
    ));

    assert_eq!(
        surfaces.resizes(),
        vec![(BALL_LABEL.to_string(), ball_window_size(96.0))]
    );
    assert_eq!(host.ball_size(), 96.0);
}

/// A write to a domain that holds no size touches no window, and neither does the `view` record —
/// which *is* a window setting, but not a geometric one. Two settings that look alike must not end up
/// sharing a call.
#[test]
fn a_write_that_carries_no_size_changes_no_window() {
    let (mut host, surfaces) = support::host();
    host.open("cat").expect("a window");
    host.ensure_ball().expect("a ball");

    for domain in [
        PetSettingsDomain::View,
        PetSettingsDomain::Message,
        PetSettingsDomain::Care,
        PetSettingsDomain::Project,
        PetSettingsDomain::Notification,
    ] {
        assert!(
            !apply_window_geometry(&mut host, &record(domain, &[])),
            "{domain:?} is not a size"
        );
    }

    assert!(surfaces.resizes().is_empty());
}

/// **A launch opens at the stored size, and not at the default one it would have had to be resized
/// from.** The window's geometry is decided when it is created, so a `restore` that read the size
/// after asking for a window would open the wrong one and leave it wrong.
#[test]
fn a_launch_opens_the_windows_the_stored_sizes_ask_for() {
    let (store, _data) = support::store("geometry-startup");
    let store = write(
        &store,
        PetSettingsDomain::Character,
        &[("size", json!(320))],
    );
    let store = write(
        &store,
        PetSettingsDomain::General,
        &[("ballSize", json!(100))],
    );
    let (mut host, surfaces) = support::host();

    restore(&mut host, &store);

    let (character, _) = surfaces
        .character_opens()
        .pop()
        .expect("the character window was opened");
    assert_eq!(
        surfaces.size_of(&character),
        Some(character_window_size(320.0))
    );
    assert_eq!(surfaces.size_of(BALL_LABEL), Some(ball_window_size(100.0)));
    assert!(
        surfaces.resizes().is_empty(),
        "nothing had to be resized: a window is opened at the size the record asks for"
    );
}

/// One domain's write, applied through the store, so the fixture is a record the app itself would
/// have written.
fn write(
    store: &nekowite_lib::desktop_pet::PetSettingsStore,
    domain: PetSettingsDomain,
    changes: &[(&str, serde_json::Value)],
) -> nekowite_lib::desktop_pet::PetSettingsStore {
    let mut values = defaults(domain);
    for (field, value) in changes {
        values.insert((*field).to_string(), value.clone());
    }
    let outcome = store.apply(&PetSettingsWrite {
        domain,
        revision: PET_SETTINGS_INITIAL_REVISION as f64,
        values: serde_json::Value::Object(values),
    });
    assert!(
        matches!(outcome, PetSettingsUpdate::Applied { .. }),
        "the fixture's own write did not apply: {outcome:?}"
    );
    store.clone()
}
