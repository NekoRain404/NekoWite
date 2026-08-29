pub mod fs;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::Emitter;

#[tauri::command]
fn ping() -> String {
    "pong".into()
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let p = fs::sanitize_path(&path).map_err(|e| e.to_string())?;
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    let p = fs::sanitize_path(&path).map_err(|e| e.to_string())?;
    std::fs::write(&p, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<fs::FileEntry>, String> {
    let p = fs::sanitize_path(&path).map_err(|e| e.to_string())?;
    let mut out = vec![];
    let entries = std::fs::read_dir(&p).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let p2 = entry.path();
        let name = p2
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let is_dir = p2.is_dir();
        let path_str = p2.to_string_lossy().to_string();
        let is_mdx = fs::is_mdx_path(&path_str);
        if is_dir || is_mdx {
            out.push(fs::FileEntry {
                name,
                path: path_str,
                is_dir,
                is_mdx: !is_dir && is_mdx,
            });
        }
    }
    out.sort_by(|a, b| {
        (b.is_dir as u8)
            .cmp(&(a.is_dir as u8))
            .then(a.name.cmp(&b.name))
    });
    Ok(out)
}

#[tauri::command]
fn open_folder_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string());
    Ok(picked)
}

#[tauri::command]
fn watch_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = fs::sanitize_path(&path).map_err(|e| e.to_string())?;
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                for path in event.paths {
                    let _ = app.emit(
                        "fs-change",
                        serde_json::json!({
                            "path": path.to_string_lossy(),
                            "kind": format!("{:?}", event.kind),
                        }),
                    );
                }
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&p, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    std::mem::forget(watcher);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ping,
            read_file,
            write_file,
            list_dir,
            open_folder_dialog,
            watch_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
