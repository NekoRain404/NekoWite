//! What one completion tells the frontend, and the id it is told under.
//!
//! Extracted from [`super::client`] as one vertical slice - the window-facing
//! surface of a run - so `client` keeps the request lifecycle that produces
//! them. The split's compatibility re-exports in `client` mean `commands/ai.rs`
//! and the integration tests still import these names from where they always
//! did.
//!
//! Dependencies: [`super::sse`] for the folded events, [`crate::state`] for the
//! in-flight registry [`is_active`] reads. Nothing here imports `client`, so the
//! graph keeps its one-way direction.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::{Emitter, Manager};

use super::sse::StreamEvent;
use crate::state::AiState;

#[derive(Serialize, Clone)]
pub struct AIChunk {
    pub id: String,
    pub text: String,
}

pub fn emit_ai_error(app: &tauri::AppHandle, id: &str, message: &str) {
    let _ = app.emit(
        "ai-error",
        serde_json::json!({ "id": id, "message": message }),
    );
}

static AI_ID_SEQ: AtomicU64 = AtomicU64::new(0);

/// Format a completion id as `ai-{unix_micros}-{seq}`. The monotonic `seq`
/// disambiguates calls that land in the same microsecond, so concurrent
/// `ai_complete` invocations never share an id (which would let one finish
/// cancel the other in the shared in-flight set).
pub fn ai_id_for(micros: u64, seq: u64) -> String {
    format!("ai-{micros}-{seq}")
}

/// Generate a unique id for a completion: unix-micros timestamp plus a
/// process-local monotonic sequence counter.
pub fn next_ai_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let micros = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64;
    let seq = AI_ID_SEQ.fetch_add(1, Ordering::Relaxed);
    ai_id_for(micros, seq)
}

/// Whether this run still owns its id in the in-flight registry.
///
/// A `false` here means the run was cancelled or released while the socket was
/// still open, and the stream loop treats it as "stop emitting": a late chunk
/// from an abandoned response must not be adopted by whatever runs next.
pub(crate) fn is_active(app: &tauri::AppHandle, id: &str) -> bool {
    let state = app.state::<AiState>();
    let guard = state.inflight.lock();
    match guard {
        Ok(inflight) => inflight.contains(id),
        Err(_) => false,
    }
}

/// Deliver one folded chunk's events in order, returning `true` once the
/// provider has ended the stream (`data: [DONE]`).
///
/// The reasoning text is emitted as PROGRESS only and never appended to the
/// answer: a reasoning model streams its thinking before any answer text, and
/// the ghost writer types whatever the answer streams straight into the
/// document — the model's internal monologue is not part of the note. An
/// in-band provider error is emitted AND returned as `Err`, because a 200
/// response that carries an error frame is a truncated answer, not a complete
/// one.
pub(crate) fn deliver_events(
    app: &tauri::AppHandle,
    id: &str,
    events: Vec<StreamEvent>,
) -> Result<bool, String> {
    let mut done = false;
    for event in events {
        match event {
            StreamEvent::Text(text) => {
                let _ = app.emit(
                    "ai-chunk",
                    AIChunk {
                        id: id.to_string(),
                        text,
                    },
                );
            }
            StreamEvent::Reasoning(text) => {
                let _ = app.emit(
                    "ai-reasoning",
                    serde_json::json!({ "id": id, "text": text }),
                );
            }
            StreamEvent::Done => done = true,
            StreamEvent::ProviderError(message) => {
                emit_ai_error(app, id, &message);
                return Err(message);
            }
        }
    }
    Ok(done)
}
