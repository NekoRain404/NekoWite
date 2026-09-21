//! The read-and-summarise turn: the engine's own frames, on a turn that does what a composer is for.

use crate::measured_absences::assert_measured_absent;
use crate::metadata_member::assert_no_subagent_key;
use crate::turn::one_turn;

/// The engine's own frames, on a turn that does what a composer is for.
#[tokio::test]
async fn the_pinned_engine_s_update_variants_on_a_tool_using_turn() {
    let Some(turn) = one_turn(
        "wire-summary",
        false,
        "The files in this folder are a small project. Read them and write a short summary into \
         SUMMARY.md: one line per file, with a two-line overview at the top.",
    )
    .await
    else {
        return;
    };
    assert_measured_absent(&turn, "read-and-summarise");
    assert_no_subagent_key(&turn.tool_frames, "read-and-summarise");
    assert!(
        turn.counts.get("tool_call").copied().unwrap_or(0) > 0,
        "the turn produced no tool call at all, so it says nothing about the frames a tool call is \
         made of: {:?}",
        turn.counts
    );
}
