use nekowite_lib::commands::remote_workspace;
use nekowite_lib::state::VaultRegistry;
use serde_json::json;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
use tauri::webview::InvokeRequest;

#[test]
fn ipc_rejects_invalid_authentication_before_creating_import_files() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("target/remote-auth-ipc-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let registry = VaultRegistry::default();
    registry
        .register(root.to_str().unwrap(), Some(&root))
        .unwrap();
    let app = mock_builder()
        .manage(registry)
        .invoke_handler(tauri::generate_handler![remote_workspace::remote_import])
        .build(tauri::generate_context!())
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    for (auth, message) in [
        (
            json!({"mode":"password", "password":"secret\nsecond"}),
            "without line breaks",
        ),
        (
            json!({"mode":"key", "identityFile":"../id_ed25519"}),
            "absolute private-key",
        ),
    ] {
        let result = get_ipc_response(
            &window,
            InvokeRequest {
                cmd: "remote_import".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Json(json!({"vault_root": root, "spec": {
                    "user":"writer", "host":"example.org", "port":22,
                    "remotePath":"/notes", "folder":"remote-notes", "auth":auth,
                }})),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        );
        let error = result
            .err()
            .expect("IPC must refuse invalid authentication")
            .to_string();
        assert!(error.contains(message), "unexpected IPC error: {error}");
        assert!(!error.contains("secret"));
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    }
    std::fs::remove_dir(root).unwrap();
}
