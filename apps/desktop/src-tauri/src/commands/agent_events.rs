//! Delivery of private runtime frames across the renderer boundary.

use crate::agent_runtime::events::AgentEventEnvelope;

pub fn publish<R: tauri::Runtime>(app: &tauri::AppHandle<R>, frame: &AgentEventEnvelope) {
    // Private note text, reasoning and tool output belong to the editor, never pet windows.
    // Pet task projections have their own deliberately restricted publication path.
    let _ = tauri::Emitter::emit_to(
        app,
        crate::main_window::LABEL,
        super::agent::AGENT_EVENT_CHANNEL,
        frame,
    );
}
