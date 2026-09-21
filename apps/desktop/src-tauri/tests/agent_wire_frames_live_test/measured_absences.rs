//! The four frames the pinned engine was measured *not* to send, and the assertion that reads them
//! off a turn.
//!
//! A table rather than four copies of one assertion, because the four are **not** the same finding
//! and a red has to say which one moved.

use crate::turn::Turn;

/// The four variants the audit's §2 item 5 names, checked on one turn.
pub fn assert_measured_absent(turn: &Turn, which: &str) {
    for (wanted, because) in MEASURED_ABSENT {
        assert_eq!(
            turn.counts.get(wanted).copied().unwrap_or(0),
            0,
            "the pinned engine sent a `{wanted}` frame on the {which} turn: {because}. Then move \
             the row in `.superpowers/sdd/roadmap/reports/agent-ui-gap-audit-remeasure.md`."
        );
    }
}

/// What each measured absence would mean if it stopped being one.
///
/// A table rather than four copies of one assertion, because the four are **not** the same
/// finding and a red has to say which one moved. All four were measured absent on the pinned
/// artifact, over two ordinary turns each carrying a tool call.
pub const MEASURED_ABSENT: [(&str, &str); 4] = [
    (
        "plan",
        "row 21's producer is now real: the contract type (`payloads.ts`), the reducer arm \
         (`agent-event-apply.ts`) and `view.plan` all exist, and `agent_runtime/events.rs`'s \
         `normalize_update` is the one layer with no arm for it",
    ),
    (
        "session_info_update",
        "row 11's producer is now real: the contract's `session-changed` and `view.title` exist, \
         and only the `normalize_update` arm is missing",
    ),
    (
        "current_mode_update",
        "one of the four variants `agent-ui-gap-audit-remeasure.md` §2 item 5 lists as swallowed \
         at `events.rs`'s `_ => None`; the contract's `mode-changed` is already there",
    ),
    (
        "usage_update",
        "row 5's arm is already written (`UsageChanged`), so nothing is owed — what changed is \
         that the engine's own context-limit guard stopped firing for this model, and the \
         window's usage ring now has a producer",
    ),
];
