//! The `message` domain as the bubble draws it: the alpha's reading, and the one property the
//! appearance read has to keep — the bubble is drawn in every arm, so its alpha rides every arm.
//!
//! Beside `bubble.rs`. The defaults case is about the schema and needs no window at all, which is
//! why it asserts against `PetSettingsRecord::defaults` rather than against a number; the arms case
//! is about a window being handed the fact, so it reaches for `drawing::appearance`.

use super::super::ball_size::BallSize;
use super::super::drawing::{appearance, PetAppearance};
use super::super::motion::Motion;
use super::super::test_support::{install, library, message, record};
use super::*;

#[test]
fn an_alpha_a_window_cannot_act_on_is_read_as_the_schemas_default() {
    // The store normalized this record on the way out of the file (`settings::values`), so a
    // value that is *there* is a value the rule accepted — including the ends, which is what
    // `assert_eq!(…, 1.0)` below is about. What a record cannot carry is a *missing* field
    // (an older build's file, or one this build's schema has not written yet), and that arm is
    // the schema's declared default rather than a guess. The one that matters: the value the
    // user never chose must never be a *clearer* bubble than the one they did.
    assert_eq!(BubbleOpacity::of(&message(Some(0.7))).value(), 0.7);
    assert_eq!(
        BubbleOpacity::of(&message(Some(1.0))).value(),
        1.0,
        "the rule's own ceiling is inside it, and a store read never hands out a value the \
         rule refused — `bubble.rs` covers the file that carries one anyway"
    );
    assert_eq!(
        BubbleOpacity::of(&message(None)).value(),
        BubbleOpacity::DEFAULT.value()
    );
    assert_eq!(
        BubbleOpacity::DEFAULT.value(),
        PetSettingsRecord::defaults(PetSettingsDomain::Message)
            .value("opacity")
            .and_then(serde_json::Value::as_f64)
            .expect("the schema declares a default for it"),
        "the constant is the schema's own default, not a second copy of the number"
    );
}

#[test]
fn the_bubble_alpha_rides_every_appearance_arm_because_the_bubble_is_drawn_in_all_of_them() {
    let (library, _data) = library("bubble-arms");
    install(&library, "kitty", "Kitty");
    let alpha = BubbleOpacity::of(&message(Some(0.7)));

    // The bubble is drawn above the notice and above a sprite alike — a window with no character
    // is still a window the pet says things in — so an alpha that only arrived with `Ready`
    // would leave a fresh install drawing a bubble the user never chose.
    assert!(matches!(
        appearance(
            &record(None, 200),
            Motion::DEFAULT,
            alpha,
            BubbleMessage::defaults(),
            BallSize::DEFAULT.value(),
            Some(&library)
        ),
        PetAppearance::Unset { bubble_opacity, .. } if bubble_opacity == 0.7
    ));
    assert!(matches!(
        appearance(
            &record(Some("ghost"), 200),
            Motion::DEFAULT,
            alpha,
            BubbleMessage::defaults(),
            BallSize::DEFAULT.value(),
            Some(&library)
        ),
        PetAppearance::Missing { bubble_opacity, .. } if bubble_opacity == 0.7
    ));
    assert!(matches!(
        appearance(
            &record(Some("kitty"), 200),
            Motion::DEFAULT,
            alpha,
            BubbleMessage::defaults(),
            BallSize::DEFAULT.value(),
            Some(&library)
        ),
        PetAppearance::Ready { bubble_opacity, .. } if bubble_opacity == 0.7
    ));
}
