//! Linux SSHFS connections: a live remote directory inside an authorized vault.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify::Watcher;
use serde::Serialize;
use tauri::{Emitter, State};
use tokio::process::{Child, Command};

use super::remote_workspace::{validate_remote, RemoteSpec};
use crate::domain::path_policy::has_hidden_component;
use crate::state::VaultRegistry;

const OFFLINE_MARKER: &str = ".nekowite-remote-placeholder";

#[derive(Default)]
pub struct RemoteMountState {
    connections: Mutex<HashMap<PathBuf, Child>>,
    connecting: Mutex<HashSet<PathBuf>>,
    watchers: Mutex<HashMap<PathBuf, notify::PollWatcher>>,
}

pub struct ConnectionReservation<'a> {
    state: &'a RemoteMountState,
    target: PathBuf,
}

impl Drop for ConnectionReservation<'_> {
    fn drop(&mut self) {
        if let Ok(mut connecting) = self.state.connecting.lock() {
            connecting.remove(&self.target);
        }
    }
}

#[derive(Serialize)]
pub struct RemoteConnection {
    path: String,
    connected: bool,
}

fn mount_field(path: &Path) -> String {
    path.to_string_lossy()
        .replace(' ', "\\040")
        .replace('\t', "\\011")
}

pub fn is_mounted_in(mountinfo: &str, target: &Path) -> bool {
    let expected = mount_field(target);
    mountinfo.lines().any(|line| {
        line.split(' ').nth(4) == Some(expected.as_str())
            && line
                .split(" - ")
                .nth(1)
                .is_some_and(|details| details.split(' ').next() == Some("fuse.sshfs"))
    })
}

fn is_mounted(target: &Path) -> Result<bool, String> {
    let mounts = fs::read_to_string("/proc/self/mountinfo")
        .map_err(|error| format!("could not inspect mounts: {error}"))?;
    Ok(is_mounted_in(&mounts, target))
}

impl RemoteMountState {
    pub fn reserve(&self, target: &Path) -> Result<ConnectionReservation<'_>, String> {
        let connections = self.connections.lock().map_err(|error| error.to_string())?;
        let mut connecting = self.connecting.lock().map_err(|error| error.to_string())?;
        if connections.contains_key(target) || !connecting.insert(target.to_path_buf()) {
            return Err("remote folder is already connecting or connected".into());
        }
        Ok(ConnectionReservation {
            state: self,
            target: target.to_path_buf(),
        })
    }

    pub fn paths_in(&self, root: &Path) -> Result<Vec<PathBuf>, String> {
        let connections = self.connections.lock().map_err(|error| error.to_string())?;
        Ok(connections
            .keys()
            .filter(|path| path.starts_with(root))
            .cloned()
            .collect())
    }
}

fn watch_remote(app: tauri::AppHandle, target: &Path) -> Result<notify::PollWatcher, String> {
    let root = target.to_path_buf();
    // FUSE does not deliver remote writes to the local inotify watcher. Poll
    // the mounted subtree with notify's established scanner instead.
    let mut watcher = notify::PollWatcher::new(
        move |result: Result<notify::Event, notify::Error>| match result {
            Ok(event) => {
                let kind = if event.kind.is_create() { "created" }
                    else if event.kind.is_modify() { "modified" }
                    else if event.kind.is_remove() { "removed" }
                    else { return };
                for path in event.paths {
                    if !path.starts_with(&root) { continue; }
                    if path.strip_prefix(&root).ok().is_some_and(has_hidden_component) { continue; }
                    let _ = app.emit("fs-change", serde_json::json!({ "path": path.to_string_lossy(), "kind": kind }));
                }
            }
            Err(error) => {
                let _ = app.emit("fs-change", serde_json::json!({ "path": root.to_string_lossy(), "kind": "resync", "error": error.to_string() }));
            }
        },
        notify::Config::default().with_poll_interval(Duration::from_secs(2)),
    ).map_err(|error| format!("could not poll remote files: {error}"))?;
    watcher
        .watch(target, notify::RecursiveMode::Recursive)
        .map_err(|error| format!("could not watch remote files: {error}"))?;
    Ok(watcher)
}

pub async fn connect_using(
    registry: &VaultRegistry,
    state: &RemoteMountState,
    vault_root: &str,
    spec: RemoteSpec,
    program: &str,
) -> Result<String, String> {
    let root = registry.authorize(vault_root)?;
    validate_remote(&spec)?;
    let target = root.join(&spec.folder);
    let _reservation = state.reserve(&target)?;
    // mkdir is the atomic reservation: a pre-existing directory, including a
    // former mountpoint, can contain user files and must never be reused.
    let created = match fs::create_dir(&target) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            // A previous process may have left its guarded placeholder behind.
            // Reuse only that exact empty shape; never mount over user files.
            let marker = target.join(OFFLINE_MARKER);
            let guarded = marker
                .symlink_metadata()
                .map(|m| m.is_file())
                .unwrap_or(false);
            let only_marker = fs::read_dir(&target)
                .map(|mut entries| {
                    entries
                        .next()
                        .map(|entry| entry.map(|e| e.path() == marker).unwrap_or(false))
                        == Some(true)
                        && entries.next().is_none()
                })
                .unwrap_or(false);
            if !guarded || !only_marker || is_mounted(&target)? {
                return Err("the local folder already exists".into());
            }
            false
        }
        Err(error) => return Err(format!("could not reserve remote folder: {error}")),
    };
    if created {
        if let Err(error) = fs::write(target.join(OFFLINE_MARKER), b"") {
            let _ = fs::remove_dir(&target);
            return Err(format!("could not guard remote folder: {error}"));
        }
    }
    let result = start_mount(&target, &spec, program).await;
    match result {
        Ok(child) => {
            let path = target.to_string_lossy().into_owned();
            state
                .connections
                .lock()
                .map_err(|error| error.to_string())?
                .insert(target, child);
            Ok(path)
        }
        Err(error) => {
            // Only an empty placeholder created above may be removed. Never
            // recurse into a remote mount or a directory someone populated.
            if created && !is_mounted(&target).unwrap_or(true) {
                let _ = fs::remove_file(target.join(OFFLINE_MARKER));
                let _ = fs::remove_dir(&target);
            }
            Err(error)
        }
    }
}

async fn start_mount(target: &Path, spec: &RemoteSpec, program: &str) -> Result<Child, String> {
    let source = format!("{}@{}:{}", spec.user, spec.host, spec.remote_path);
    let mut child = Command::new(program)
        .args(["-f", "-o", "nonempty,reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,BatchMode=yes,StrictHostKeyChecking=yes,ConnectTimeout=10,cache=no,dir_cache=no", "-p"])
        .arg(spec.port.to_string())
        .arg(source)
        .arg(target)
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("SSHFS could not start (install sshfs on Linux): {error}"))?;
    for _ in 0..50 {
        if is_mounted(target)? {
            return Ok(child);
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("SSHFS exited: {error}"))?
        {
            return Err(format!(
                "SSHFS connection failed ({status}); check SSH access and the remote directory"
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = child.kill().await;
    Err("SSHFS connection timed out".into())
}

pub async fn disconnect_using(
    registry: &VaultRegistry,
    state: &RemoteMountState,
    vault_root: &str,
    folder: &str,
    unmount: &str,
) -> Result<(), String> {
    let root = registry.authorize(vault_root)?;
    if folder.is_empty()
        || folder.starts_with('.')
        || !folder
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("invalid remote folder".into());
    }
    let target = root.join(folder);
    {
        let connections = state
            .connections
            .lock()
            .map_err(|error| error.to_string())?;
        if !connections.contains_key(&target) {
            return Err("remote connection is not owned by this session".into());
        }
    }
    if is_mounted(&target)? {
        let result = Command::new(unmount)
            .arg("-u")
            .arg(&target)
            .output()
            .await
            .map_err(|error| format!("could not start unmount: {error}"))?;
        if !result.status.success() || is_mounted(&target)? {
            return Err(format!(
                "could not disconnect remote mount: {}",
                String::from_utf8_lossy(&result.stderr).trim()
            ));
        }
    }
    state
        .watchers
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&target);
    let child = state
        .connections
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&target);
    drop(child);
    // Preserve even unexpectedly created local files instead of deleting them.
    fs::remove_file(target.join(OFFLINE_MARKER))
        .map_err(|error| format!("remote disconnected; could not clear offline marker: {error}"))?;
    fs::remove_dir(&target)
        .map_err(|error| format!("remote disconnected; could not remove empty folder: {error}"))?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn remote_connect(
    vault_root: String,
    spec: RemoteSpec,
    app: tauri::AppHandle,
    registry: State<'_, VaultRegistry>,
    state: State<'_, RemoteMountState>,
) -> Result<String, String> {
    let path = connect_and_watch(
        &registry,
        &state,
        &vault_root,
        spec,
        "sshfs",
        Some(app.clone()),
    )
    .await?;
    let _ = app.emit(
        "fs-change",
        serde_json::json!({ "path": vault_root, "kind": "resync" }),
    );
    Ok(path)
}

pub async fn connect_and_watch(
    registry: &VaultRegistry,
    state: &RemoteMountState,
    vault_root: &str,
    spec: RemoteSpec,
    program: &str,
    app: Option<tauri::AppHandle>,
) -> Result<String, String> {
    let path = connect_using(registry, state, vault_root, spec, program).await?;
    if let Some(app) = app {
        match watch_remote(app, Path::new(&path)) {
            Ok(watcher) => {
                state
                    .watchers
                    .lock()
                    .map_err(|error| error.to_string())?
                    .insert(PathBuf::from(&path), watcher);
            }
            Err(error) => {
                let _ = disconnect_using(
                    registry,
                    state,
                    vault_root,
                    Path::new(&path).file_name().unwrap().to_str().unwrap(),
                    "fusermount3",
                )
                .await;
                return Err(error);
            }
        }
    }
    Ok(path)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn remote_disconnect(
    vault_root: String,
    folder: String,
    app: tauri::AppHandle,
    registry: State<'_, VaultRegistry>,
    state: State<'_, RemoteMountState>,
) -> Result<(), String> {
    disconnect_using(&registry, &state, &vault_root, &folder, "fusermount3").await?;
    let _ = app.emit(
        "fs-change",
        serde_json::json!({ "path": vault_root, "kind": "resync" }),
    );
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn remote_connections(
    vault_root: String,
    registry: State<'_, VaultRegistry>,
    state: State<'_, RemoteMountState>,
) -> Result<Vec<RemoteConnection>, String> {
    let root = registry.authorize(&vault_root)?;
    state
        .paths_in(&root)?
        .into_iter()
        .map(|path| {
            Ok(RemoteConnection {
                connected: is_mounted(&path)?,
                path: path.to_string_lossy().into_owned(),
            })
        })
        .collect()
}
