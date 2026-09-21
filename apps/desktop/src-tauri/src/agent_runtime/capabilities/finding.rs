//! What was established about one feature: the three states a capability answer can be in, and the
//! constructors that spell a refusal.
//!
//! **Why it is a file of its own.** It was the bottom half of `capabilities.rs`, which passed the
//! 600-line budget `docs/dev.md:286` puts on a business source file. The split is by *reason to
//! change*, which is the criterion that section states rather than the line count: this module moves
//! when the *answer vocabulary* moves — an arm the page learns to render, the serde spelling the
//! window's contract copies, the shape of a refusal's detail — while `super::verdict` moves when a
//! *feature* or the wire fact behind it does, and `super` moves when the report row or this build's
//! own offers do. A status every page would have to be taught is not the same change as the reading
//! that produces one.
//!
//! **Three arms, and the third is the one a two-armed version loses.** `available` is only ever
//! produced by a negotiation that said so, `unavailable` is a negotiation that said no, and
//! `unverified` is one that has not happened. The constructors below are what keep those apart at
//! every arm rather than only the ones a reader happened to check, which is why they live with the
//! vocabulary instead of with the per-feature table: a page that draws a status has to be able to
//! trust that its sibling status was not reachable by accident.
//!
//! [`Finding`] and the three constructors keep the paths they had before the split — the parent
//! re-exports the enum, and the constructors stay reachable from it as they were, one module deeper.

use serde::Serialize;

/// What was established about one feature.
///
/// Three arms, and the third is the one a two-armed version would lose: `available` is only ever
/// produced by a negotiation that said so, `unavailable` is a negotiation that said no, and
/// `unverified` is one that has not happened. [`crate::agent_runtime::linux_capabilities::Finding`]
/// has a fourth, `degraded`, for a capability that works in part; none of these features has a
/// partial state — an engine either reported image support or it did not — so inventing one here
/// would be a status a page had to explain and nothing could produce.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Finding {
    /// The engine reported it. The only route to this arm is a report that said so.
    Available,
    /// The engine was asked, and its answer was no. The detail says what it said.
    Unavailable { detail: String },
    /// Nothing has been reported. Not a synonym for either of the other two: calling an
    /// unmeasured feature "unsupported" is as wrong as calling it "supported".
    Unverified { detail: String },
}

/// One derived answer, as a finding: the third state a two-armed predicate cannot carry.
///
/// Every arm of `super::verdict`'s join goes through here, so "nobody has reported" and "the report
/// said no" cannot be confused at one arm and kept apart at another.
pub(super) fn answered(reported: Option<bool>, absent: &str, missing: &str) -> Finding {
    match reported {
        None => unverified(missing),
        Some(true) => Finding::Available,
        Some(false) => unavailable(absent),
    }
}

pub(super) fn unavailable(detail: &str) -> Finding {
    Finding::Unavailable {
        detail: detail.to_string(),
    }
}

pub(super) fn unverified(detail: &str) -> Finding {
    Finding::Unverified {
        detail: detail.to_string(),
    }
}
