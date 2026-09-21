//! Row 26: whether a tool call carries `_meta.subagent_session_info` — read as a member of the
//! frame, never as text the frame happens to carry.
//!
//! Zed keys its subagent card on that member (`acp_thread.rs:126,288-292`), so the question is
//! whether a frame has one. The distinction between 「the member is there」 and 「the words appear in
//! the payload」 is the one this module exists for: a tool call's `content` and `rawOutput` carry
//! whatever the agent read, this file's own prose included, so a substring check is not measuring
//! the frame.

use serde_json::{json, Value};

/// Row 26, checked on whichever turn just ran.
///
/// Zed keys its subagent card on `_meta.subagent_session_info` (`acp_thread.rs:126,288-292`), so
/// the question is whether a tool call carries that member. The check reads the transcript rather
/// than a variant count, because `_meta` is a member of a frame; and it is written as "no
/// metadata member at all", because an engine that emitted an empty `_meta` would be a different
/// finding from one that emits none.
///
/// **It reads the member, not the line's text, and that distinction was learned the hard way.**
/// The first version asked `line.contains("_meta") || line.contains("subagent")` over the
/// serialized frame — and it went red on a turn whose only offence was *reading this file*, whose
/// comments contain both words. A tool call's `content` and `rawOutput` carry whatever the agent
/// read, so a substring answers 「did those characters appear anywhere in the payload」, which is
/// not the question. The frame is parsed and its own members are walked instead.
pub fn assert_no_subagent_key(tool_frames: &[String], turn: &str) {
    assert!(
        !tool_frames.is_empty(),
        "the {turn} turn produced no tool call, so it says nothing about row 26's question"
    );
    let offenders: Vec<&String> = tool_frames
        .iter()
        .filter(|line| carries_a_metadata_member(line))
        .collect();
    assert!(
        offenders.is_empty(),
        "a tool-call frame in the {turn} turn now carries a metadata member: {offenders:?}. If the \
         member is `subagent_session_info`, Zed's card is reachable and row 26's answer has \
         changed from \"the engine never sends one\" to \"the host drops it\""
    );
}

/// Whether one transcript line's `session/update` carries a `_meta` member of its own.
///
/// The `update` object is the frame, so a `_meta` beside `toolCallId`/`title`/`kind` is the
/// finding. Everything nested under `content` or `rawOutput` is the agent's material — a file it
/// read, a command's output — and a member found there would be a fact about the file rather than
/// about the frame. A line that will not parse is not a tool call and carries nothing.
pub fn carries_a_metadata_member(line: &str) -> bool {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| value.get("params")?.get("update").cloned())
        .is_some_and(|update| update.get("_meta").is_some())
}

/// The detector, on the two frames that tell it apart — and the first is the real one.
///
/// This costs no prompt and is the red the fix was written against. The first line is a
/// `tool_call_update` whose `content` carries **this file's own text**, which names `_meta` and
/// `subagent` in prose: a substring check calls it an offender, and that is exactly how the live
/// run went red. The second carries the member the check is for. A detector that cannot separate
/// them is not measuring the frame.
#[test]
fn a_metadata_member_is_the_frames_own_and_not_the_text_it_carries() {
    let window_read_of_this_file = json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": "ses_1",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call_1",
                "status": "completed",
                "title": "tests/agent_wire_frames_live_test.rs",
                "content": [{
                    "type": "content",
                    "content": {
                        "type": "text",
                        "text": "Zed keys its subagent card on `_meta.subagent_session_info`, \
                                 so the question is whether a tool call carries that member."
                    }
                }]
            }
        }
    })
    .to_string();
    assert!(
        !carries_a_metadata_member(&window_read_of_this_file),
        "a file whose text mentions the member is not a frame that carries it"
    );

    let frame_that_carries_one = json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": "ses_1",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "call_2",
                "title": "task",
                "_meta": { "subagent_session_info": { "sessionId": "ses_2" } }
            }
        }
    })
    .to_string();
    assert!(
        carries_a_metadata_member(&frame_that_carries_one),
        "a member beside toolCallId is the finding this check exists for"
    );

    assert!(
        !carries_a_metadata_member("not json at all"),
        "a line that is not a frame carries nothing"
    );
}
