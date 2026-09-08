//! AI commands: the IPC surface for streaming completions, cancelling and
//! listing models.
//!
//! Each command deserializes its arguments, registers/cancels the in-flight id
//! on the managed [`AiState`], then delegates to the provider client. Command
//! names, DTOs and error strings are unchanged from the pre-split layout.

use tauri::Manager;

use crate::providers::ai::client::{
    self, acquire_slot, emit_ai_error, hydrate_stored_key, list_models, next_ai_id,
    stream_complete, validate_base_url, AIConfig,
};
use crate::state::AiState;

#[tauri::command]
pub async fn ai_cancel(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AiState>();
    let mut inflight = state.inflight.lock().map_err(|e| e.to_string())?;
    inflight.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn ai_list_models(
    app: tauri::AppHandle,
    mut config: AIConfig,
) -> Result<Vec<String>, String> {
    client::hydrate_stored_key(&app, &mut config)?;
    list_models(&config).await
}

#[tauri::command]
pub async fn ai_complete(
    app: tauri::AppHandle,
    mut config: AIConfig,
    prompt: String,
    images: Vec<serde_json::Value>,
) -> Result<(), String> {
    let id = next_ai_id();
    {
        let state = app.state::<AiState>();
        let mut inflight = state.inflight.lock().map_err(|e| e.to_string())?;
        inflight.insert(id.clone());
    }
    // Everything below, including the validation guard, runs inside a single
    // guarded block so every early-return path (invalid Base URL, saturated
    // concurrency pool) still falls through to the `remove(&id)` cleanup below.
    // A rejected internal/loopback endpoint surfaces a clear user-facing error
    // instead of a silent failure or a request phoning a forbidden host.
    let result = async {
        // Backfill the key from the vault when the caller did not supply a real
        // one (the window never receives the decrypted key anymore).
        hydrate_stored_key(&app, &mut config).inspect_err(|e| {
            emit_ai_error(&app, &id, e);
        })?;
        validate_base_url(&config).inspect_err(|e| {
            emit_ai_error(&app, &id, e);
        })?;
        // Bound concurrency: acquire a slot before opening a connection. A
        // saturated/over-quota request gets a clear "busy" error rather than
        // unbounded task spawning. The permit is held for the whole stream.
        let state = app.state::<AiState>();
        let _permit = acquire_slot(&state).await.inspect_err(|e| {
            emit_ai_error(&app, &id, e);
        })?;
        stream_complete(&app, &config, &prompt, &images, &id).await
    }
    .await;
    if let Some(state) = app.try_state::<AiState>() {
        if let Ok(mut inflight) = state.inflight.lock() {
            inflight.remove(&id);
        }
    }
    result
}
