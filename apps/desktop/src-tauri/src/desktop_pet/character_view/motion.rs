//! How far the pet's windows may move, from `general.motion` (§5.2's 「跟随系统/应用设置」).
//!
//! **Why this is a module of its own.** The policy is not the character's: the `general` domain
//! stores it and the `character` domain does not, so it rides the appearance read for a reason of
//! its own. It was one of three such facts in `character_view.rs` — [`super::bubble`]'s alpha and
//! content model, and [`super::ball_size`]'s diameter are the others — and each moved with its own
//! settings domain rather than staying joined by the reader that happens to want all of them.
//!
//! It moves when §5.2's motion vocabulary does (a third member, a renamed one) or when
//! `general.motion` does, and not when a window's drawing changes.

use serde::Serialize;

use super::super::settings::{PetSettingsDomain, PetSettingsRecord, PetSettingsStore};

/// How far the pet's windows may move, from `general.motion`.
///
/// The *stored policy* and not a decision: the system's own `prefers-reduced-motion` is a question
/// each window asks its own engine (the ball answers it in CSS today), so what crosses this wire
/// is only what the user chose in the app. A host that answered `Reduced` for a machine whose
/// system asked for less would be inventing a restriction, and one that answered `System` for a
/// user who chose `reduced` would be dropping the one §5.2 requires the pet to follow
/// (「跟随系统/应用设置；桌宠可更保守，不能反向解除全局限制」).
///
/// **On every arm, and not part of [`super::drawing::Drawing`].** The ball is one of the pet's windows whether or
/// not a character is chosen — it draws upstream's plain orb in the `Unset` arm — so a policy that
/// only arrived with `Ready` would leave the one surface this build has that moves unreduced in
/// the state a fresh install is in. It is not the character's, which is why it is not a `Drawing`
/// field: the character record does not hold it and `general` does.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Motion {
    /// Follow the system's own preference, which is the schema's default.
    System,
    /// The user asked for less motion than the system does.
    Reduced,
}

impl Motion {
    /// The member `settings::fields`' `GENERAL` declares as the default, and therefore the reading
    /// of every value this build cannot act on: an absent field on a record an older build wrote,
    /// a member nothing recognises, and a `general` record from a newer build — which §10.2 keeps
    /// this build from reading at all, and which cannot be guessed into `Reduced` because a
    /// restriction the user did not ask for is a change, not a default.
    pub const DEFAULT: Self = Self::System;

    /// The policy a `general` record holds.
    ///
    /// The store normalized the record on the way out of the file (`settings::values`), so a member
    /// other than the one below is either the other declared member or a value nothing wrote —
    /// and both take the schema's default, the arm [`super::drawing::Drawing::of`] takes for its own fields.
    pub fn of(record: &PetSettingsRecord) -> Self {
        match record.value("motion").and_then(serde_json::Value::as_str) {
            Some("reduced") => Self::Reduced,
            _ => Self::DEFAULT,
        }
    }
}

/// The policy a store holds for the pet's windows.
///
/// The one read [`super::drawing::appearance`]'s caller performs, and a function rather than three lines in the
/// command because a test asserting what a window is handed should go through the same arm — the
/// alternative is a second copy of the rule that the two can drift apart on.
///
/// A `general` record this build may not read is answered with [`Motion::DEFAULT`] rather than
/// guessed at. That arm is `store.read`'s `ReadOnly` — a record a newer build wrote, which §10.2
/// keeps this build from reading — and the alternative (`Reduced`) would be inventing a
/// restriction the user never asked for, while the window would still honour the system's own
/// preference through its own engine.
pub fn stored_motion(store: &PetSettingsStore) -> Motion {
    store
        .read(PetSettingsDomain::General)
        .record()
        .map_or(Motion::DEFAULT, Motion::of)
}

#[cfg(test)]
mod tests;
