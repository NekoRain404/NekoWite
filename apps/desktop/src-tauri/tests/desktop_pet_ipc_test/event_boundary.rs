use nekowite_lib::agent_runtime::events::{AgentEventEnvelope, AgentEventKind};
use nekowite_lib::commands::agent::AGENT_EVENT_CHANNEL;
use serde_json::json;
use std::sync::{Arc, Mutex};
use tauri::{Listener, Manager};

// Invoke the production publisher through a real Tauri command, with actual window listeners.
#[tauri::command]
fn publish_private_frames<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    for kind in [
        AgentEventKind::TextDelta,
        AgentEventKind::ThoughtDelta,
        AgentEventKind::ToolUpdate,
    ] {
        let frame = AgentEventEnvelope {
            agent_id: "agent".into(),
            profile_id: "profile".into(),
            runtime_epoch: "epoch".into(),
            vault_id: "private-vault".into(),
            session_id: "session".into(),
            run_id: Some("run".into()),
            sequence: 1,
            kind,
            payload: json!({"text": "private note"}),
        };
        nekowite_lib::commands::agent_events::publish(&app, &frame);
    }
    nekowite_lib::desktop_pet::publish_tasks(&app, &[]);
}

#[test]
fn private_agent_frames_reach_only_main_but_pet_projections_still_arrive() {
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![publish_private_frames])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    for label in ["main", "pet-1", "pet-ball"] {
        let window = tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::default())
            .build()
            .unwrap();
        let sink = seen.clone();
        window.listen(AGENT_EVENT_CHANNEL, move |event| {
            sink.lock()
                .unwrap()
                .push((label, event.payload().to_string()));
        });
    }
    let pet = app.get_webview_window("pet-1").unwrap();
    let tasks = Arc::new(Mutex::new(Vec::new()));
    let sink = tasks.clone();
    pet.listen(nekowite_lib::desktop_pet::PET_TASKS_CHANNEL, move |event| {
        sink.lock().unwrap().push(event.payload().to_string());
    });
    let main = app.get_webview_window("main").unwrap();
    tauri::test::get_ipc_response(
        &main,
        tauri::webview::InvokeRequest {
            cmd: "publish_private_frames".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(json!({})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .expect("the IPC command publishes the frames");
    let seen = seen.lock().unwrap();
    assert_eq!(
        seen.len(),
        3,
        "raw frames must not cross the pet renderer boundary: {seen:?}"
    );
    assert!(seen.iter().all(|(label, _)| *label == "main"));
    assert!(seen[0].1.contains("private note"));
    assert_eq!(tasks.lock().unwrap().as_slice(), ["[]"]);
}
