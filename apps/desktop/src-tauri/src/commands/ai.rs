//! AI commands: the IPC surface for streaming completions, cancelling and
//! listing models.
//!
//! Each command deserializes its arguments, registers/cancels the in-flight id
//! on the managed [`AiState`], then delegates to the provider client. Command
//! names, DTOs and error strings are unchanged from the pre-split layout.

use tauri::Manager;

use crate::providers::ai::client::{
    self, acquire_slot, emit_ai_error, hydrate_stored_key, list_models, next_ai_id,
    stream_complete, validate_base_url, validate_request_inputs, AIConfig,
};
use crate::state::AiState;

#[tauri::command]
pub async fn ai_cancel(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AiState>();
    // Cancelling an id that is not in flight is not an error: the frontend
    // cancels on every abort path, including ones that beat the request to the
    // backend.
    state.cancel(&id)?;
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

/// Longest client-supplied request id accepted. Ids are opaque keys in the
/// in-flight set and in every event payload, so a hostile/oversized string is
/// rejected in favour of a generated one rather than stored.
const MAX_REQUEST_ID_LEN: usize = 128;

/// The id a completion runs under: the caller's when it sent a usable one
/// (the frontend needs it BEFORE the first event so a cancel during the
/// provider''s silent reasoning phase has something to target), otherwise a
/// generated one. Blank/oversized ids fall back instead of failing the request.
pub fn resolve_request_id(requested: Option<String>) -> String {
    match requested {
        Some(id) => {
            let trimmed = id.trim();
            if trimmed.is_empty() || trimmed.len() > MAX_REQUEST_ID_LEN || trimmed.len() != id.len()
            {
                next_ai_id()
            } else {
                trimmed.to_string()
            }
        }
        None => next_ai_id(),
    }
}

#[tauri::command]
pub async fn ai_complete(
    app: tauri::AppHandle,
    mut config: AIConfig,
    prompt: String,
    images: Vec<serde_json::Value>,
    id: Option<String>,
) -> Result<(), String> {
    let id = resolve_request_id(id);
    // The token is registered with the id so `ai_cancel` can interrupt the
    // socket wait, not just flip a flag the stream loop only reads between
    // chunks. Created here (before the request starts) so a cancel that arrives
    // during the provider's silent reasoning phase still lands somewhere.
    let cancel = tokio_util::sync::CancellationToken::new();
    {
        let state = app.state::<AiState>();
        // `false` means another live request already owns this id, in which case
        // its registration is left alone: an id addresses exactly one request,
        // and overwriting it would strand that request's cancel token.
        if !state.claim(&id, cancel.clone())? {
            return Err(format!("另一个 AI 请求已在使用这个 id：{id}"));
        }
    }
    // Everything below, including the validation guard, runs inside a single
    // guarded block so every early-return path (invalid Base URL, saturated
    // concurrency pool) still falls through to the `remove(&id)` cleanup below.
    // A rejected internal/loopback endpoint surfaces a clear user-facing error
    // instead of a silent failure or a request phoning a forbidden host.
    let result = async {
        // Size policy first, at the IPC boundary: a prompt, an image count or an
        // individual image past its ceiling is refused before a key is loaded,
        // a connection slot is taken or a byte is sent. The renderer checks the
        // same limits for the user's benefit, but this is the boundary that
        // anything invoking the command has to cross (see the `MAX_*` ceilings
        // in `providers::ai::client`).
        validate_request_inputs(&prompt, &images).inspect_err(|e| {
            emit_ai_error(&app, &id, e);
        })?;
        // Backfill the key from the vault when the caller did not supply a real
        // one (the window never receives the decrypted key anymore).
        hydrate_stored_key(&app, &mut config).inspect_err(|e| {
            emit_ai_error(&app, &id, e);
        })?;
        // Vets the Base URL and hands back the addresses it approved, so the
        // request is pinned to exactly those (see `VettedHost`).
        let pin = validate_base_url(&config).inspect_err(|e| {
            emit_ai_error(&app, &id, e);
        })?;
        // Bound concurrency: acquire a slot before opening a connection. A
        // saturated/over-quota request gets a clear "busy" error rather than
        // unbounded task spawning. The permit is held for the whole stream.
        let state = app.state::<AiState>();
        let _permit = acquire_slot(&state).await.inspect_err(|e| {
            emit_ai_error(&app, &id, e);
        })?;
        stream_complete(&app, &config, &prompt, &images, &id, &cancel, pin.as_ref()).await
    }
    .await;
    // Both registries are cleaned on every exit path (success, provider error,
    // a saturated pool, cancellation) so a finished request leaves nothing
    // behind — a stale token would make a REUSED id uncancellable.
    if let Some(state) = app.try_state::<AiState>() {
        state.release(&id);
    }
    result
}

#[cfg(test)]
mod request_id_tests {
    use super::resolve_request_id;

    #[test]
    fn keeps_a_caller_supplied_id() {
        assert_eq!(
            resolve_request_id(Some("ai-abc-1".into())),
            "ai-abc-1".to_string()
        );
    }

    #[test]
    fn generates_an_id_when_none_was_supplied() {
        let generated = resolve_request_id(None);
        assert!(generated.starts_with("ai-"));
        assert_ne!(generated, resolve_request_id(None));
    }

    #[test]
    fn falls_back_for_blank_padded_or_oversized_ids() {
        for bad in [
            "",
            "   ",
            " ai-padded ",
            &"x".repeat(super::MAX_REQUEST_ID_LEN + 1),
        ] {
            let id = resolve_request_id(Some(bad.to_string()));
            assert!(id.starts_with("ai-"), "{bad:?} produced {id:?}");
            assert_ne!(id, bad.to_string());
        }
    }

    #[test]
    fn accepts_an_id_at_the_length_limit() {
        let id = "y".repeat(super::MAX_REQUEST_ID_LEN);
        assert_eq!(resolve_request_id(Some(id.clone())), id);
    }
}
