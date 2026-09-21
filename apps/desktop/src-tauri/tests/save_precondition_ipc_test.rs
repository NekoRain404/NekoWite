use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

pub use nekowite_lib::{domain, state, storage};
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;

// Compile the real command module so its generated IPC argument parser, including
// optional fields, is exercised instead of duplicating its signature in a shim.
#[allow(dead_code)]
#[path = "../src/commands/fs.rs"]
mod fs_commands;

struct Vault(PathBuf);

impl Vault {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!(
                "save-precondition-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir_all(path.join("notes")).unwrap();
        std::fs::write(path.join("notes/a.md"), "original\r\n").unwrap();
        Self(path)
    }
}

impl Drop for Vault {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn app(vault: &Vault) -> tauri::App<MockRuntime> {
    let registry = state::VaultRegistry::default();
    registry
        .register(vault.0.to_str().unwrap(), Some(&vault.0))
        .unwrap();
    mock_builder()
        .manage(registry)
        .invoke_handler(tauri::generate_handler![
            fs_commands::write_file,
            fs_commands::delete_file,
            fs_commands::rename_entry
        ])
        .build(tauri::generate_context!())
        .unwrap()
}

fn call(
    window: &tauri::WebviewWindow<MockRuntime>,
    cmd: &str,
    body: Value,
) -> Result<Value, Value> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .map(|body| body.deserialize().unwrap())
}

fn write_body(vault: &Vault) -> Value {
    json!({"vault_root": vault.0, "path": "notes/a.md", "content": "stale editor",
        "expected_content": "original\r\n"})
}

#[test]
fn stale_save_after_delete_does_not_resurrect_note() {
    let vault = Vault::new();
    let app = app(&vault);
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let trashed = call(
        &window,
        "delete_file",
        json!({"vault_root": vault.0, "path": "notes/a.md"}),
    )
    .unwrap();
    assert!(call(&window, "write_file", write_body(&vault)).is_err());
    assert!(!vault.0.join("notes/a.md").exists());
    assert_eq!(
        std::fs::read_to_string(trashed.as_str().unwrap()).unwrap(),
        "original\r\n"
    );
    assert!(!vault.0.join(".nekowite").exists());
}

#[test]
fn stale_save_after_rename_does_not_resurrect_old_path() {
    for (from, to, moved) in [
        ("notes/a.md", "notes/b.md", "notes/b.md"),
        ("notes", "moved", "moved/a.md"),
    ] {
        let vault = Vault::new();
        let app = app(&vault);
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        call(
            &window,
            "rename_entry",
            json!({"vault": vault.0, "from": from, "to": to}),
        )
        .unwrap();
        assert!(
            call(&window, "write_file", write_body(&vault)).is_err(),
            "{from}"
        );
        assert!(!vault.0.join("notes/a.md").exists());
        assert_eq!(
            std::fs::read_to_string(vault.0.join(moved)).unwrap(),
            "original\r\n"
        );
    }
}

#[test]
fn stale_save_preserves_newer_bytes_and_does_not_snapshot_them() {
    let vault = Vault::new();
    let app = app(&vault);
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    // A line-ending-only change still invalidates an exact-byte precondition.
    std::fs::write(vault.0.join("notes/a.md"), "original\n").unwrap();
    assert!(call(&window, "write_file", write_body(&vault)).is_err());
    assert_eq!(
        std::fs::read_to_string(vault.0.join("notes/a.md")).unwrap(),
        "original\n"
    );
    assert!(!vault.0.join(".nekowite").exists());
}

#[test]
fn matching_content_saves_and_omitting_precondition_creates() {
    let vault = Vault::new();
    let app = app(&vault);
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    call(&window, "write_file", write_body(&vault)).unwrap();
    assert_eq!(
        std::fs::read_to_string(vault.0.join("notes/a.md")).unwrap(),
        "stale editor"
    );
    call(
        &window,
        "write_file",
        json!({"vault_root": vault.0, "path": "new.md", "content": "created"}),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(vault.0.join("new.md")).unwrap(),
        "created"
    );
}

#[test]
fn unreadable_target_rejects_guarded_save() {
    let vault = Vault::new();
    let app = app(&vault);
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    std::fs::remove_file(vault.0.join("notes/a.md")).unwrap();
    std::fs::create_dir(vault.0.join("notes/a.md")).unwrap();
    assert!(call(&window, "write_file", write_body(&vault)).is_err());
    assert!(vault.0.join("notes/a.md").is_dir());
    assert!(!vault.0.join(".nekowite").exists());
}

#[test]
fn concurrent_editors_with_one_baseline_only_publish_once() {
    let vault = Vault::new();
    let app = app(&vault);
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = ["editor one", "editor two"]
        .into_iter()
        .map(|content| {
            let window = window.clone();
            let barrier = barrier.clone();
            let mut body = write_body(&vault);
            body["content"] = json!(content);
            std::thread::spawn(move || {
                barrier.wait();
                (content, call(&window, "write_file", body))
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(
        results.iter().filter(|(_, result)| result.is_ok()).count(),
        1
    );
    let winner = results.iter().find(|(_, result)| result.is_ok()).unwrap().0;
    assert_eq!(
        std::fs::read_to_string(vault.0.join("notes/a.md")).unwrap(),
        winner
    );
    let history =
        storage::metadata_store::list_history(vault.0.to_str().unwrap(), "notes/a.md").unwrap();
    assert_eq!(
        history.len(),
        1,
        "the refused editor must not create another snapshot"
    );
}
