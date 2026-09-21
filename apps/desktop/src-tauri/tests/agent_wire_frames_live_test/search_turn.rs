//! The search turn: a tree worth searching, where an engine that had a subagent key would use one.

use crate::measured_absences::assert_measured_absent;
use crate::metadata_member::assert_no_subagent_key;
use crate::turn::one_turn;

/// A second turn, on a tree worth searching — where a subagent would be the ordinary instrument.
///
/// Row 26 asks whether a tool call ever carries `_meta.subagent_session_info`. The first turn
/// answers the half that matters (no tool call carries a `_meta` member at all, over three
/// different kinds), and this one is the case where an engine that had such a key would use it —
/// and the second, independent turn on which the four absences above are read.
#[tokio::test]
async fn a_search_turn_carries_no_subagent_key_on_its_tool_calls() {
    let Some(turn) = one_turn(
        "wire-search",
        true,
        "Find every place in this project where a timeout is configured, and write what you find \
         into FINDINGS.md as a list of file paths with the value each one sets.",
    )
    .await
    else {
        return;
    };
    assert_no_subagent_key(&turn.tool_frames, "search");
    assert_measured_absent(&turn, "search");
}
