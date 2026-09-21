use nekowite_lib::commands::{desktop_pet, desktop_pet_navigation as navigation};
use nekowite_lib::desktop_pet::PetTaskKey;
use serde_json::{json, Value};
use tauri::{
    test::{mock_builder, mock_context, noop_assets},
    Manager,
};

#[tauri::command]
fn desktop_pet_open_settings<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    page: String,
) -> Result<(), String> {
    desktop_pet::desktop_pet_open_settings(app, page)
}
#[tauri::command]
fn desktop_pet_open_task<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    task: PetTaskKey,
) -> Result<(), String> {
    desktop_pet::desktop_pet_open_task(app, task)
}
#[tauri::command]
fn desktop_pet_take_settings_requests<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    app: tauri::AppHandle<R>,
) -> Result<Vec<navigation::SettingsRequest>, String> {
    navigation::desktop_pet_take_settings_requests(window, app)
}
#[tauri::command]
fn desktop_pet_take_task_requests<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    app: tauri::AppHandle<R>,
) -> Result<Vec<PetTaskKey>, String> {
    navigation::desktop_pet_take_task_requests(window, app)
}

fn call(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    body: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        window,
        tauri::webview::InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|body| body.deserialize().unwrap())
}

#[test]
fn requests_survive_main_window_creation_and_only_main_can_consume_them_once() {
    let mut context = mock_context(noop_assets());
    context
        .config_mut()
        .app
        .windows
        .push(tauri::utils::config::WindowConfig::default());
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            desktop_pet_open_settings,
            desktop_pet_open_task,
            desktop_pet_take_settings_requests,
            desktop_pet_take_task_requests,
        ])
        .build(context)
        .unwrap();
    let pet = tauri::WebviewWindowBuilder::new(&app, "pet-1", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    assert!(app.get_webview_window("main").is_none());
    call(
        &pet,
        "desktop_pet_open_settings",
        json!({"page": "character"}),
    )
    .unwrap();
    call(&pet, "desktop_pet_open_settings", json!({"page": "care"})).unwrap();
    assert!(call(
        &pet,
        "desktop_pet_open_settings",
        json!({"page": "invalid"})
    )
    .is_err());
    let key = json!({"agentId":"agent", "profileId":"profile", "runtimeEpoch":"epoch",
        "vaultId":"vault", "sessionId":"session", "runId":"run"});
    call(&pet, "desktop_pet_open_task", json!({"task": key})).unwrap();
    let main = app
        .get_webview_window("main")
        .expect("request rebuilt the main window");
    for cmd in [
        "desktop_pet_take_settings_requests",
        "desktop_pet_take_task_requests",
    ] {
        assert!(call(&pet, cmd, json!({"window": "main", "label": "main"})).is_err());
    }
    assert_eq!(
        call(&main, "desktop_pet_take_settings_requests", json!({})).unwrap(),
        json!([{"page":"care"}])
    );
    assert_eq!(
        call(&main, "desktop_pet_take_task_requests", json!({})).unwrap(),
        json!([key])
    );
    for cmd in [
        "desktop_pet_take_settings_requests",
        "desktop_pet_take_task_requests",
    ] {
        assert_eq!(call(&main, cmd, json!({})).unwrap(), json!([]));
    }
}

#[test]
fn shipped_capabilities_grant_consumption_to_main_and_refuse_pet_windows() {
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            desktop_pet_take_settings_requests,
            desktop_pet_take_task_requests,
        ])
        .build(tauri::generate_context!())
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let pet = tauri::WebviewWindowBuilder::new(&app, "pet-1", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    for cmd in [
        "desktop_pet_take_settings_requests",
        "desktop_pet_take_task_requests",
    ] {
        assert_eq!(call(&main, cmd, json!({})).unwrap(), json!([]));
        let refusal = call(&pet, cmd, json!({})).expect_err("pet must hold no consume grant");
        assert!(
            refusal
                .as_str()
                .unwrap_or_default()
                .contains("not allowed on window \"pet-1\""),
            "expected the shipped ACL to refuse the call before dispatch: {refusal}"
        );
    }
}
