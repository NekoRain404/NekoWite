//! `general.ballSize`: the reading at both ends, and the one property the appearance read has to
//! keep — the ball is on the desktop in every arm, so its size rides every arm.
//!
//! Beside `ball_size.rs`. The last assertion of the first case is a cross-check rather than a
//! reading of this module: the schema's default and the orb upstream's 80 px window was built
//! around have to be one number, so it reaches for `ball`'s own arithmetic instead of restating the
//! 24 px of margin the window adds.

use crate::desktop_pet::ball::{ball_window_size, BALL_DEFAULT_SIZE};
use crate::desktop_pet::settings::PetSettingsDomain;

use super::super::bubble::{BubbleMessage, BubbleOpacity};
use super::super::drawing::{appearance, PetAppearance};
use super::super::motion::Motion;
use super::super::test_support::{general_with_ball_size, install, library, record};
use super::*;

#[test]
fn a_ball_size_a_window_cannot_act_on_is_read_as_the_schemas_default() {
    assert_eq!(
        BallSize::of(&general_with_ball_size(Some(32))).value(),
        32.0
    );
    assert_eq!(
        BallSize::of(&general_with_ball_size(Some(128))).value(),
        128.0,
        "the rule's own ceiling"
    );
    assert_eq!(
        BallSize::of(&general_with_ball_size(None)).value(),
        BallSize::DEFAULT.value()
    );
    assert_eq!(
        BallSize::DEFAULT.value(),
        PetSettingsRecord::defaults(PetSettingsDomain::General)
            .value("ballSize")
            .and_then(serde_json::Value::as_f64)
            .expect("the schema declares a default for it"),
        "the constant is the schema's own default, not a second copy of the number"
    );
    assert_eq!(
        BallSize::DEFAULT.value(),
        ball_window_size(BALL_DEFAULT_SIZE).0 - 24.0,
        "and it is the orb upstream's 80 px window was built around"
    );
}

/// **The ball's size rides every arm**, for the reason the policy and the alpha do: the ball is
/// on the desktop whether or not a character is chosen, and its size is neither the character's
/// nor a fact that arrives with one. A window handed nothing would draw an orb at this build's
/// constant while the host had built its window around the user's number — the two answers §9
/// forbids, one field over.
#[test]
fn the_ball_size_rides_every_appearance_arm_because_the_ball_is_drawn_in_all_of_them() {
    let (library, _data) = library("ball-size-arms");
    install(&library, "kitty", "Kitty");
    let size = BallSize::of(&general_with_ball_size(Some(96)));

    assert!(matches!(
        appearance(
            &record(None, 200),
            Motion::DEFAULT,
            BubbleOpacity::DEFAULT,
            BubbleMessage::defaults(),
            size.value(),
            Some(&library)
        ),
        PetAppearance::Unset { ball_size, .. } if ball_size == 96.0
    ));
    assert!(matches!(
        appearance(
            &record(Some("ghost"), 200),
            Motion::DEFAULT,
            BubbleOpacity::DEFAULT,
            BubbleMessage::defaults(),
            size.value(),
            Some(&library)
        ),
        PetAppearance::Missing { ball_size, .. } if ball_size == 96.0
    ));
    assert!(matches!(
        appearance(
            &record(Some("kitty"), 200),
            Motion::DEFAULT,
            BubbleOpacity::DEFAULT,
            BubbleMessage::defaults(),
            size.value(),
            Some(&library)
        ),
        PetAppearance::Ready { ball_size, .. } if ball_size == 96.0
    ));
}
