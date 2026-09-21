//! `general.motion`: the reading, and the one property the appearance read has to keep about it.
//!
//! Beside `motion.rs`. The first case is the reading alone; the second is about a window being
//! handed the policy, which is why it reaches for `drawing::appearance` — the join that has to
//! carry it — and installs a character to have all three arms to check.

use super::super::ball_size::BallSize;
use super::super::bubble::{BubbleMessage, BubbleOpacity};
use super::super::drawing::{appearance, PetAppearance};
use super::super::test_support::{general, general_with_ball_size, install, library, record};
use super::*;

#[test]
fn a_policy_a_window_cannot_act_on_is_read_as_the_schemas_default() {
    // The store normalizes a record on the way out of the file, so an unrecognised member is
    // one nothing wrote — and the arm for it is the schema's default rather than a guess. The
    // one that matters: `reduced` invents a restriction if it is wrong, so a value that is
    // *not* `reduced` must never be read as it.
    assert_eq!(Motion::of(&general(Some("reduced"))), Motion::Reduced);
    assert_eq!(Motion::of(&general(Some("system"))), Motion::System);
    assert_eq!(Motion::of(&general_with_ball_size(None)), Motion::System);
    assert_eq!(Motion::of(&general(Some("less"))), Motion::System);
    assert_eq!(Motion::of(&general(Some(""))), Motion::System);
}

#[test]
fn the_policy_rides_every_appearance_arm_because_the_ball_draws_in_all_of_them() {
    let (library, _data) = library("motion-arms");
    install(&library, "kitty", "Kitty");
    let reduced = Motion::Reduced;

    // `Unset` is a fresh install, where the ball draws upstream's plain orb — and the orb is
    // the surface this build has that moves, so a policy that only arrived with `Ready` would
    // leave exactly the state a new user is in unreduced.
    assert!(matches!(
        appearance(
            &record(None, 200),
            reduced,
            BubbleOpacity::DEFAULT,
            BubbleMessage::defaults(),
            BallSize::DEFAULT.value(),
            Some(&library),
        ),
        PetAppearance::Unset { motion, .. } if motion == reduced
    ));
    assert!(matches!(
        appearance(
            &record(Some("ghost"), 200),
            reduced,
            BubbleOpacity::DEFAULT,
            BubbleMessage::defaults(),
            BallSize::DEFAULT.value(),
            Some(&library)
        ),
        PetAppearance::Missing { motion, .. } if motion == reduced
    ));
    assert!(matches!(
        appearance(
            &record(Some("kitty"), 200),
            reduced,
            BubbleOpacity::DEFAULT,
            BubbleMessage::defaults(),
            BallSize::DEFAULT.value(),
            Some(&library)
        ),
        PetAppearance::Ready { motion, .. } if motion == reduced
    ));
}
