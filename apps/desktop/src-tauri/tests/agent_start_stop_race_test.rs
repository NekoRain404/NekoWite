use nekowite_lib::commands::agent::AgentIpcState;
use nekowite_lib::state::AgentRuntimeState;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

#[test]
fn agent_stop_ipc_invalidates_a_pending_start_before_installation() {
    let app = tauri::test::mock_builder()
        .manage(AgentRuntimeState::default())
        .manage(AgentIpcState::default())
        .invoke_handler(tauri::generate_handler![
            nekowite_lib::commands::agent::agent_stop
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let state = app.state::<AgentRuntimeState>();
    let generation = state.lifecycle.begin().unwrap();
    let response = tauri::test::get_ipc_response(
        &window,
        tauri::webview::InvokeRequest {
            cmd: "agent_stop".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    );
    assert!(response.is_ok());
    let installed = AtomicBool::new(false);
    assert!(state
        .lifecycle
        .finish(generation, || {
            installed.store(true, Ordering::SeqCst);
            Ok(())
        })
        .is_err());
    assert!(!installed.load(Ordering::SeqCst));
    assert!(state.instance.lock().unwrap().is_none());
    assert!(app.state::<AgentIpcState>().session().is_err());
    let next = state.lifecycle.begin().unwrap();
    assert!(state.lifecycle.finish(next, || Ok(())).is_ok());
}

#[test]
fn agent_stop_ipc_cannot_split_the_final_installation() {
    let app = tauri::test::mock_builder()
        .manage(AgentRuntimeState::default())
        .manage(AgentIpcState::default())
        .invoke_handler(tauri::generate_handler![
            nekowite_lib::commands::agent::agent_stop
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let state = app.state::<AgentRuntimeState>();
    let generation = state.lifecycle.begin().unwrap();
    let (entered, midway) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let (stopped, stop_result) = std::sync::mpsc::channel();
    let installed = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let pending_state = &state;
        let pending_installed = &installed;
        scope.spawn(move || {
            pending_state
                .lifecycle
                .finish(generation, || {
                    entered.send(()).unwrap();
                    released
                        .recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    pending_installed.store(true, Ordering::SeqCst);
                    Ok(())
                })
                .unwrap();
        });
        midway
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        scope.spawn(|| {
            let response = tauri::test::get_ipc_response(
                &window,
                tauri::webview::InvokeRequest {
                    cmd: "agent_stop".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            );
            assert!(response.is_ok());
            assert!(installed.load(Ordering::SeqCst));
            stopped.send(()).unwrap();
        });
        assert!(stop_result
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_err());
        release.send(()).unwrap();
        stop_result
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
    });
    assert!(state.lifecycle.finish(generation, || Ok(())).is_err());
    let next = state.lifecycle.begin().unwrap();
    assert!(state
        .lifecycle
        .finish::<()>(next, || Err("install failed".into()))
        .is_err());
    assert!(state.lifecycle.finish(next, || Ok(())).is_ok());
}
