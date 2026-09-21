//! The pet's two windows, each on its own switch: 只开悬浮球 and its mirror, where the character
//! window and the ball are opened, closed and left alone independently of one another.

use serde_json::json;

use nekowite_lib::commands::desktop_pet::{apply_feature_switch, PetFeatureState};
use nekowite_lib::desktop_pet::settings::PetSettingsDomain;
use nekowite_lib::desktop_pet::window_host::BALL_LABEL;
use nekowite_lib::desktop_pet::DESKTOP_PET_BALL_PAGE;

use crate::support::{self, record};

/// **只开悬浮球.** With 显示角色窗口 off and 显示悬浮球 on there is no character window and there is a
/// ball — the state the pair of switches exists for, and the one the master switch could not say.
///
/// The published state is asserted too, and it is the half that is easy to get wrong: `enabled` is
/// whether the pet has a window on the desktop at all, so a state that answered "off" here would be
/// the interface and the backend disagreeing about one record (§5.3).
#[test]
fn a_write_that_wants_only_the_ball_opens_the_ball_and_no_character_window() {
    let (mut host, surfaces) = support::host();
    let state = apply_feature_switch(
        &mut host,
        &record(
            PetSettingsDomain::General,
            &[
                ("enabled", json!(true)),
                ("characterWindow", json!(false)),
                ("ball", json!(true)),
            ],
        ),
        "cat",
    );

    assert_eq!(
        state,
        Some(PetFeatureState {
            enabled: true,
            visible: true
        }),
        "the pet is on and one of its windows is up"
    );
    assert!(surfaces.character_opens().is_empty());
    assert!(host.instances().is_empty());
    assert_eq!(
        surfaces.ball_open(),
        Some((BALL_LABEL.to_string(), DESKTOP_PET_BALL_PAGE.to_string()))
    );
    assert_eq!(host.ball().map(|label| label.as_str()), Some(BALL_LABEL));
}

/// And the same pair of switches the other way round, from a pet that is already up: the character
/// window closes, the ball does not, and nothing about the character's switch reaches the ball.
#[test]
fn turning_the_character_window_off_closes_it_and_leaves_the_ball_where_it_is() {
    let (mut host, surfaces) = support::host();
    let instance = host.open("cat").expect("a window");
    assert!(host.ball().is_some(), "the ball came up with the pet");

    let state = apply_feature_switch(
        &mut host,
        &record(
            PetSettingsDomain::General,
            &[
                ("enabled", json!(true)),
                ("characterWindow", json!(false)),
                ("ball", json!(true)),
            ],
        ),
        "cat",
    );

    assert_eq!(
        state,
        Some(PetFeatureState {
            enabled: true,
            visible: true
        }),
        "the feature's state is not the character window's"
    );
    assert!(host.instances().is_empty());
    assert!(surfaces
        .state()
        .closed
        .contains(&instance.label.as_str().to_string()));
    assert_eq!(surfaces.live(), vec![BALL_LABEL.to_string()]);
}

/// The switch back on opens the character window again, and only that window: the ball is already
/// up, and a second one is what an `ensure` that ignored its own state would leave on the desktop.
#[test]
fn turning_the_character_window_back_on_reopens_it_without_a_second_ball() {
    let (mut host, surfaces) = support::host();
    let off = record(
        PetSettingsDomain::General,
        &[
            ("enabled", json!(true)),
            ("characterWindow", json!(false)),
            ("ball", json!(true)),
        ],
    );
    apply_feature_switch(&mut host, &off, "cat");
    assert!(host.instances().is_empty());

    let on = record(
        PetSettingsDomain::General,
        &[
            ("enabled", json!(true)),
            ("characterWindow", json!(true)),
            ("ball", json!(true)),
        ],
    );
    apply_feature_switch(&mut host, &on, "cat");

    assert_eq!(host.instances().len(), 1, "the character window is back");
    assert_eq!(host.instances()[0].character_id, "cat");
    assert_eq!(
        surfaces
            .opened()
            .iter()
            .filter(|(label, _)| label == BALL_LABEL)
            .count(),
        1,
        "the ball was up already"
    );
}

/// **只开悬浮球 taken back.** The ball's switch going off leaves no window at all, which is §4's
/// rollback said with the two switches instead of one: with the character window already off, the
/// ball was the whole pet, and the switch that turns a pet off is the switch that takes it down.
///
/// It is also the case that shows the pair is symmetric: neither switch is subordinate, so the pet
/// exists exactly while one of them is on and no third field has to be consulted for it.
#[test]
fn turning_the_ball_off_takes_a_ball_only_pet_down() {
    let (mut host, surfaces) = support::host();
    apply_feature_switch(
        &mut host,
        &record(
            PetSettingsDomain::General,
            &[("characterWindow", json!(false)), ("ball", json!(true))],
        ),
        "cat",
    );
    assert_eq!(host.ball().map(|label| label.as_str()), Some(BALL_LABEL));

    let state = apply_feature_switch(
        &mut host,
        &record(
            PetSettingsDomain::General,
            &[("characterWindow", json!(false)), ("ball", json!(false))],
        ),
        "cat",
    );

    assert_eq!(
        state,
        Some(PetFeatureState {
            enabled: false,
            visible: false
        })
    );
    assert!(host.ball().is_none(), "the ball is gone");
    assert!(surfaces.live().is_empty(), "and nothing else was left");
    assert!(
        !host.ball_enabled(),
        "the preference is the user's, and they said off"
    );
}
