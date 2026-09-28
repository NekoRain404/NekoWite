//! Explicit SSH import into an authorized vault, without saved credentials.
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Deserialize;
use tauri::State;
use tokio::process::Command;

use crate::state::VaultRegistry;

static NEXT_IMPORT: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSpec {
    pub user: String,
    pub host: String,
    pub port: u16,
    pub remote_path: String,
    pub folder: String,
}

pub fn validate_remote(spec: &RemoteSpec) -> Result<(), String> {
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
    let transport = format!("ssh -oBatchMode=yes -oConnectTimeout=10 -p {}", spec.port);
    let source = format!(
        "{}@{}:{}/",
        spec.user,
        spec.host,
        spec.remote_path.trim_end_matches('/')
    );
    let mut command = Command::new(program);
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
        .env("RSYNC_RSH", &transport)
        .kill_on_drop(true);
    let outcome = tokio::time::timeout(Duration::from_secs(300), command.output()).await;
    let result = match outcome {
        Err(_) => Err("SSH import timed out".to_string()),
        Ok(Err(error)) => Err(format!("rsync could not start: {error}")),
        Ok(Ok(output)) if !output.status.success() => {
            let message = String::from_utf8_lossy(&output.stderr[..output.stderr.len().min(2048)]);
            Err(format!("SSH import failed: {}", message.trim()))
        }
        Ok(Ok(_)) => {
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
