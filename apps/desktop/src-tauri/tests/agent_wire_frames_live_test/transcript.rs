//! The verbatim wire log, read for what a variant count cannot answer.
//!
//! The two `tee`s leave every JSON-RPC line on disk beside the run. That transcript is the only
//! place an engine→**client request** can be seen at all — this host registers no handler for
//! `elicitation/create`, so the SDK answers such a request `-32601` inside its own dispatch loop
//! and it never reaches a Rust caller — and it is where row 26's question is answered, because
//! `_meta` is a member of a frame rather than a variant count.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use agent_client_protocol::schema::v1::SessionUpdate;
use serde_json::Value;

use crate::measured_absences::MEASURED_ABSENT;
use crate::metadata_member::carries_a_metadata_member;

/// Everything the frame log is read for, in one block.
///
/// Returns the tool-call frames, because row 26's question is about a member of one of them.
pub fn report(
    wire: &Path,
    frames: &[SessionUpdate],
    counts: &BTreeMap<&'static str, usize>,
) -> Vec<String> {
    eprintln!("--- variant counts: {counts:?}");

    let from_engine = fs::read_to_string(wire.join("from-engine.jsonl")).unwrap_or_default();
    let to_engine = fs::read_to_string(wire.join("to-engine.jsonl")).unwrap_or_default();
    let requests: Vec<&str> = from_engine
        .lines()
        .filter(|line| {
            serde_json::from_str::<Value>(line)
                .is_ok_and(|value| value.get("id").is_some() && value.get("method").is_some())
        })
        .collect();
    eprintln!(
        "--- the transcript at {}: {} line(s) from the engine, {} to it, {} engine->client \
         request(s): {requests:?}",
        wire.display(),
        from_engine.lines().count(),
        to_engine.lines().count(),
        requests.len(),
    );

    // The tool call's own shape, printed whole: row 26 is a question about a member of this frame
    // and cannot be answered from a variant count.
    for frame in frames {
        if let SessionUpdate::ToolCall(call) = frame {
            eprintln!(
                "--- tool_call verbatim: {}",
                serde_json::to_string(call).unwrap_or_default()
            );
            break;
        }
    }

    let tool_frames: Vec<String> = from_engine
        .lines()
        .filter(|line| line.contains("\"tool_call\"") || line.contains("\"tool_call_update\""))
        .map(str::to_string)
        .collect();
    eprintln!(
        "--- {} tool-call frame(s) in the transcript, {} of them naming a metadata or subagent key",
        tool_frames.len(),
        // The same structural question the assertion asks, for the same reason: this number is
        // read as evidence, and a count taken over the line's text would have said 1 on the turn
        // that read this file.
        tool_frames
            .iter()
            .filter(|line| carries_a_metadata_member(line))
            .count()
    );

    for (wanted, _) in MEASURED_ABSENT {
        let n = counts.get(wanted).copied().unwrap_or(0);
        eprintln!("--- {wanted}: {n} frame(s) on this turn");
    }
    tool_frames
}
