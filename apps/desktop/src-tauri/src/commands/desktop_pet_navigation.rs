//! Pending navigation survives a main window whose renderer has not mounted yet.

use super::desktop_pet::{PET_SETTINGS_CHANNEL, PET_TASK_OPEN_CHANNEL, SETTINGS_PAGES};
use crate::desktop_pet::PetTaskKey;
use serde::Serialize;
use std::sync::Mutex;
use tauri::Manager;

#[tauri::command]
pub fn desktop_pet_open_settings<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    page: String,
) -> Result<(), String> {
    if !SETTINGS_PAGES.contains(&page.as_str()) {
        return Err(format!(
            "{page} is not one of the pet's settings pages: {}",
            SETTINGS_PAGES.join(", ")
        ));
    }
    crate::main_window::raise(&app)?;
    let request = SettingsRequest { page };
    // The latest click wins while the renderer loads. Persist before signalling: even a lost
    // wakeup is recovered by the main window's listen-then-consume handshake.
    *pending(&app)
        .settings
        .lock()
        .map_err(|error| error.to_string())? = Some(request.clone());
    tauri::Emitter::emit_to(
        &app,
        crate::main_window::LABEL,
        PET_SETTINGS_CHANNEL,
        request,
    )
    .map_err(|error| format!("the settings request could not be signalled: {error}"))
}

#[tauri::command]
pub fn desktop_pet_open_task<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    task: PetTaskKey,
) -> Result<(), String> {
    crate::main_window::raise(&app)?;
    *pending(&app)
        .task
        .lock()
        .map_err(|error| error.to_string())? = Some(task.clone());
    // Retired tasks remain valid navigation targets; the main window validates session identity.
    tauri::Emitter::emit_to(&app, crate::main_window::LABEL, PET_TASK_OPEN_CHANNEL, task)
        .map_err(|error| format!("the task request could not be signalled: {error}"))
}

#[derive(Clone, Debug, Serialize)]
pub struct SettingsRequest {
    pub page: String,
}

#[derive(Default)]
struct PendingNavigation {
    settings: Mutex<Option<SettingsRequest>>,
    task: Mutex<Option<PetTaskKey>>,
}

fn pending<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::State<'_, PendingNavigation> {
    // Tauri's state insertion is atomic; concurrent first requests share the winning state.
    app.manage(PendingNavigation::default());
    app.state()
}

#[tauri::command]
pub fn desktop_pet_take_settings_requests<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    app: tauri::AppHandle<R>,
) -> Result<Vec<SettingsRequest>, String> {
    require_main(&window)?;
    Ok(pending(&app)
        .settings
        .lock()
        .map_err(|error| error.to_string())?
        .take()
        .into_iter()
        .collect())
}

#[tauri::command]
pub fn desktop_pet_take_task_requests<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    app: tauri::AppHandle<R>,
) -> Result<Vec<PetTaskKey>, String> {
    require_main(&window)?;
    Ok(pending(&app)
        .task
        .lock()
        .map_err(|error| error.to_string())?
        .take()
        .into_iter()
        .collect())
}

fn require_main<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    // Capability grants are not the identity authority for draining main-window requests.
    if window.label() != crate::main_window::LABEL {
        return Err("only the main window may consume pet navigation".into());
    }
    Ok(())
}
