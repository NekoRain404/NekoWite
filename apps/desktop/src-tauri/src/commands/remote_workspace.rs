//! Explicit SSH import into an authorized vault, without saved credentials.
use std::fs;
use std::os::unix::process::CommandExt;
use std::process::{Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Deserialize;
use tauri::State;
use tokio::process::Command;

use super::remote_auth::RemoteAuth;
use crate::agent_runtime::signal_group;
use crate::state::VaultRegistry;

static NEXT_IMPORT: AtomicU64 = AtomicU64::new(0);

fn stop_transfer_group(pid: u32) {
    // A timed-out sshpass may have spawned rsync and ssh. They share this
    // dedicated group; killing only the wrapper leaves writers behind.
    if let Ok(pid) = i32::try_from(pid) {
        let _ = signal_group(pid, "-KILL");
    }
}

pub async fn run_transfer(
    mut command: Command,
    auth: &RemoteAuth,
    deadline: Duration,
) -> Result<Output, String> {
    command.as_std_mut().process_group(0);
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    auth.prepare_stdin(&mut command);
    let mut child = command.spawn().map_err(|error| {
        if matches!(auth, RemoteAuth::Password { .. })
            && error.kind() == std::io::ErrorKind::NotFound
        {
            "sshpass is required for password import; install it with `sudo apt install sshpass` (Debian/Ubuntu) or `sudo dnf install sshpass` (Fedora/RHEL), then retry".to_string()
        } else {
            format!("rsync could not start: {error}")
        }
    })?;
    let pid = child.id().ok_or("SSH import process unavailable")?;
    if let Err(error) = auth.send_password(&mut child).await {
        stop_transfer_group(pid);
        let _ = child.wait().await;
        return Err(error);
    }
    let mut waiting = Box::pin(child.wait_with_output());
    match tokio::time::timeout(deadline, &mut waiting).await {
        Ok(result) => result.map_err(|error| format!("rsync failed: {error}")),
        Err(_) => {
            stop_transfer_group(pid);
            // Reap after terminating the entire group, before staging cleanup.
            let _ = waiting.await;
            Err("SSH import timed out".into())
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSpec {
    pub user: String,
    pub host: String,
    pub port: u16,
    pub remote_path: String,
    pub folder: String,
    #[serde(default)]
    pub auth: RemoteAuth,
}

pub fn validate_remote(spec: &RemoteSpec) -> Result<(), String> {
    spec.auth.validate()?;
    let safe_name = |value: &str| {
        !value.is_empty()
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    };
    if !safe_name(&spec.user)
        || spec.user.starts_with('-')
        || !safe_name(&spec.host)
        || spec.host.starts_with('-')
        || spec.host.starts_with('.')
        || spec.port == 0
    {
        return Err("enter a valid SSH user, host and port".into());
    }
    if !safe_name(&spec.folder) || spec.folder.starts_with('.') || spec.folder == ".." {
        return Err("enter a simple, new local folder name".into());
    }
    if !spec.remote_path.starts_with('/')
        || spec
            .remote_path
            .split('/')
            .any(|segment| segment == ".." || segment == ".")
        || !spec
            .remote_path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'-' | b'_'))
    {
        return Err("enter an absolute remote directory without spaces or shell characters".into());
    }
    Ok(())
}

pub async fn import_workspace(
    registry: &VaultRegistry,
    vault_root: &str,
    spec: RemoteSpec,
) -> Result<String, String> {
    import_workspace_using(registry, vault_root, spec, "rsync").await
}

#[doc(hidden)]
pub async fn import_workspace_using(
    registry: &VaultRegistry,
    vault_root: &str,
    spec: RemoteSpec,
    program: &str,
) -> Result<String, String> {
    let root = registry.authorize(vault_root)?;
    validate_remote(&spec)?;
    let target = root.join(&spec.folder);
    if target.exists() {
        return Err("the local folder already exists".into());
    }
    let staging = root.join(format!(
        ".nekowite-import-{}-{}",
        std::process::id(),
        NEXT_IMPORT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&staging).map_err(|error| format!("could not create import folder: {error}"))?;

    // rsync's secluded args keep the remote directory out of the remote shell;
    // the strict path check above also rejects option and shell syntax.
    let transport = spec.auth.import_transport(spec.port);
    let source = format!(
        "{}@{}:{}/",
        spec.user,
        spec.host,
        spec.remote_path.trim_end_matches('/')
    );
    let mut command = if matches!(spec.auth, RemoteAuth::Password { .. }) {
        let mut wrapper = Command::new("sshpass");
        wrapper.args(["-d", "0"]).arg(program);
        wrapper
    } else {
        Command::new(program)
    };
    command
        .args([
            "-a",
            "--secluded-args",
            "--no-links",
            "--no-devices",
            "--no-specials",
            "--no-owner",
            "--no-group",
            "--exclude=.git",
            "--exclude=.nekowite",
            "-e",
            &transport,
        ])
        .arg(source)
        .arg(&staging)
        .env("RSYNC_RSH", &transport);
    let result = match run_transfer(command, &spec.auth, Duration::from_secs(300)).await {
        Err(error) => Err(error),
        Ok(output) if !output.status.success() => {
            let message = String::from_utf8_lossy(&output.stderr[..output.stderr.len().min(2048)]);
            Err(format!("SSH import failed: {}", message.trim()))
        }
        Ok(_) => {
            // Reserve the destination before renaming, so a failed transfer
            // never replaces a pre-existing vault folder.
            fs::create_dir(&target)
                .map_err(|error| format!("local folder became unavailable: {error}"))?;
            match fs::rename(&staging, &target) {
                Ok(()) => Ok(target.to_string_lossy().into_owned()),
                Err(error) => {
                    let _ = fs::remove_dir(&target);
                    Err(format!("could not finish SSH import: {error}"))
                }
            }
        }
    };
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

#[tauri::command(rename_all = "snake_case")]
pub async fn remote_import(
    vault_root: String,
    spec: RemoteSpec,
    state: State<'_, VaultRegistry>,
) -> Result<String, String> {
    import_workspace(&state, &vault_root, spec).await
}
