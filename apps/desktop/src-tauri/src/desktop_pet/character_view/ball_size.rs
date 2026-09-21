//! The floating ball's diameter in CSS pixels, from `general.ballSize` (§5.1's 悬浮球).
//!
//! **Why this is a module of its own.** The ball is a pet window whether or not a character is
//! chosen, so this number is not a property of what the ball wears: it is *both* what the orb is
//! drawn at and what the window around it is sized to, and `window_host::stored_ball_size` reads the
//! same field for the host's half. One stored number behind the orb and its window is the whole of
//! §9's rule here — a page that measured its own window, or a host that guessed the page's size,
//! would be the second answer — so the reading lives beside the schema default it falls back to.
//!
//! It was one of the three non-character facts riding `character_view.rs`'s appearance read, and it
//! moves on its own clock: when `general.ballSize` or the ball's upstream default
//! (`ball::BALL_DEFAULT_SIZE`, the size the 80 px window was built around) changes.

use super::super::settings::PetSettingsRecord;

/// The floating ball's diameter in CSS pixels, from `general.ballSize` (§5.1's 悬浮球).
///
/// The fourth fact that rides this read and is not the character's, and it rides it for the reason
/// [`super::motion::Motion`] does: the ball is a pet window, `capabilities/desktop-pet.json` holds no settings read
/// for it, and this number is *both* what the orb is drawn at and what the window around it is sized
/// to (`window_host::stored_ball_size` reads the same field for the host's half). One stored number
/// behind the orb and its window, which is the whole of §9's rule here: a page that measured its own
/// window, or a host that guessed the page's size, would be the second answer.
///
/// It is not the character's even though the ball wears the character's face: the ball is on the
/// desktop with no character chosen at all, and its size is not a property of what it wears.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct BallSize(f64);

impl BallSize {
    /// The member `settings::fields`' `GENERAL` declares — upstream's `--ball-size` — and therefore
    /// the reading of every value this build cannot act on: an absent field on a record an older
    /// build wrote, a value outside the rule, and a `general` record from a newer build, which §10.2
    /// keeps this build from reading at all.
    pub const DEFAULT: Self = Self(super::super::ball::BALL_DEFAULT_SIZE);

    /// The diameter a `general` record holds.
    ///
    /// The store normalized this record on the way out of the file (`settings::values`), so what
    /// reaches the second arm is a record this build did not write — and the schema's own default is
    /// the size this build's ball has always been.
    pub fn of(record: &PetSettingsRecord) -> Self {
        match record.value("ballSize").and_then(serde_json::Value::as_f64) {
            Some(value) => Self(value),
            None => Self::DEFAULT,
        }
    }

    pub fn value(self) -> f64 {
        self.0
    }
}

#[cfg(test)]
mod tests;
