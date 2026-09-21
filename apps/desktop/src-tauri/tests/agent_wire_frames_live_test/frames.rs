//! What the engine actually sent: the frame vocabulary, the host's own reading of it, and the
//! bounded wait that fills both.
//!
//! `variant_of` names every variant the pinned schema can name rather than leaving it to a
//! wildcard, because the frame log is exactly where a variant nobody expected is meant to be
//! legible. `mapped` runs the host's own `normalize_update` over the same frame, so one row can be
//! read from the transport and from the mapping at once — which is the whole point of listening
//! here rather than to the runtime's event stream. `collect` is a clock rather than a sentinel: the
//! connection outlives a turn, so silence is what ends a read.

use std::collections::BTreeMap;
use std::time::Duration;

use agent_client_protocol::schema::v1::SessionUpdate;
use nekowite_lib::agent_runtime::events::normalize_update;
use serde_json::Value;
use tokio::sync::mpsc::UnboundedReceiver;

/// The variant's own name, which is what a frame log is read for.
///
/// Every variant the pinned schema can name is named here rather than left to a wildcard: the
/// frame log is exactly where a variant nobody expected is meant to be legible.
fn variant_of(update: &SessionUpdate) -> &'static str {
    match update {
        SessionUpdate::UserMessageChunk(_) => "user_message_chunk",
        SessionUpdate::AgentMessageChunk(_) => "agent_message_chunk",
        SessionUpdate::AgentThoughtChunk(_) => "agent_thought_chunk",
        SessionUpdate::ToolCall(_) => "tool_call",
        SessionUpdate::ToolCallUpdate(_) => "tool_call_update",
        SessionUpdate::Plan(_) => "plan",
        SessionUpdate::PlanUpdate(_) => "plan_update",
        SessionUpdate::PlanRemoved(_) => "plan_removed",
        SessionUpdate::AvailableCommandsUpdate(_) => "available_commands_update",
        SessionUpdate::CurrentModeUpdate(_) => "current_mode_update",
        SessionUpdate::ConfigOptionUpdate(_) => "config_option_update",
        SessionUpdate::SessionInfoUpdate(_) => "session_info_update",
        SessionUpdate::UsageUpdate(_) => "usage_update",
        SessionUpdate::CompactionUpdate(_) => "compaction_update",
        SessionUpdate::CompactionSummaryChunk(_) => "compaction_summary_chunk",
        other => {
            let _ = other;
            "unnamed-by-this-instrument"
        }
    }
}

/// What the host's own mapping makes of a frame — the other half of every row.
fn mapped(update: &SessionUpdate) -> String {
    match normalize_update(update) {
        Some((kind, payload)) => format!("{kind:?} {}", short(&payload)),
        None => "DROPPED at normalize_update's `_ => None`".to_string(),
    }
}

fn short(value: &Value) -> String {
    value.to_string().chars().take(200).collect()
}

/// Reads every notification that arrives, printing one line each, until `patience` runs out.
///
/// The stream is not closed by the turn's end — the connection outlives the run — so the wait is a
/// clock rather than a sentinel, exactly as the replay target's collector waits for silence.
pub async fn collect(
    updates: &mut UnboundedReceiver<agent_client_protocol::schema::v1::SessionNotification>,
    patience: Duration,
) -> (Vec<SessionUpdate>, BTreeMap<&'static str, usize>) {
    let mut frames: Vec<SessionUpdate> = Vec::new();
    let mut counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    let deadline = tokio::time::Instant::now() + patience;
    loop {
        let Ok(next) = tokio::time::timeout_at(deadline, updates.recv()).await else {
            break;
        };
        let Some(notification) = next else { break };
        let name = variant_of(&notification.update);
        *counts.entry(name).or_default() += 1;
        eprintln!(
            "  frame {:>3} {name:<26} {}",
            frames.len(),
            mapped(&notification.update)
        );
        frames.push(notification.update);
    }
    (frames, counts)
}
