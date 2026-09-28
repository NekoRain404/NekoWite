//! Explicit Git operations for a user-opened vault. No credentials are stored here.
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::process::Command;

use crate::state::VaultRegistry;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitAction {
    Status,
    Init,
    SetOrigin { url: String },
    Commit { message: String },
    Pull,
    Push,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReadout {
    pub initialized: bool,
    pub branch: String,
    pub origin: String,
    pub changes: String,
}

pub fn validate_origin(url: &str) -> Result<(), String> {
    if url.is_empty()
        || url.trim() != url
        || url.starts_with('-')
        || url.chars().any(char::is_control)
    {
        return Err("invalid remote address".into());
    }
    if let Some(rest) = url.strip_prefix("https://") {
        let authority = rest.split('/').next().unwrap_or("");
        if authority.is_empty() || authority.contains('@') || !valid_host(authority) {
            return Err("HTTPS address must have a host and no embedded credentials".into());
        }
        return Ok(());
    }
    if let Some(rest) = url.strip_prefix("ssh://") {
        let authority = rest.split('/').next().unwrap_or("");
        let host_port = authority
            .rsplit_once('@')
            .map_or(authority, |(_, host)| host);
        let (host, port) = host_port.split_once(':').unwrap_or((host_port, ""));
        if !valid_host(host)
            || !port.is_empty() && port.parse::<u16>().is_err()
            || authority.matches('@').count() > 1
        {
            return Err("invalid SSH remote host or port".into());
        }
        return Ok(());
    }
    // Git's scp form is a remote address, but an arbitrary local path is not.
    let Some((user_host, path)) = url.split_once(':') else {
        return Err("use SSH or HTTPS for Git sync".into());
    };
    if !user_host.starts_with("git@")
        || !valid_host(&user_host[4..])
        || path.is_empty()
        || path.starts_with('-')
    {
        return Err("use SSH or HTTPS for Git sync".into());
    }
    Ok(())
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && !host.starts_with('-')
        && !host.starts_with('.')
        && host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

async fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut process = Command::new("git");
    // Repository-controlled hooks and transport helpers must not run when a
    // user opens an unfamiliar vault or configures an unfamiliar origin.
    process
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "protocol.ext.allow=never",
            "-c",
            "protocol.file.allow=never",
        ])
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes -oConnectTimeout=10")
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(45), process.output())
        .await
        .map_err(|_| "Git operation timed out".to_string())?
        .map_err(|error| format!("Git could not start: {error}"))?;
    let bytes = if output.status.success() {
        &output.stdout
    } else {
        &output.stderr
    };
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(16_384)])
        .trim()
        .to_string();
    if output.status.success() {
        Ok(text)
    } else {
        Err(if text.is_empty() {
            format!("Git failed: {}", output.status)
        } else {
            text
        })
    }
}

async fn require_repository(root: &Path) -> Result<(), String> {
    let top = git(root, &["rev-parse", "--show-toplevel"]).await?;
    let top = PathBuf::from(top)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    // Running Git inside a vault nested under another repository would otherwise
    // stage and publish files outside the user's chosen vault.
    if top != root {
        return Err("Git repository root must match the opened vault".into());
    }
    Ok(())
}

async fn status(root: &Path) -> Result<GitReadout, String> {
    if !root.join(".git").exists() {
        return Ok(GitReadout {
            initialized: false,
            branch: String::new(),
            origin: String::new(),
            changes: String::new(),
        });
    }
    require_repository(root).await?;
    let branch = git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await
        .unwrap_or_default();
    let origin = git(root, &["config", "--local", "--get", "remote.origin.url"])
        .await
        .unwrap_or_default();
    let changes = git(root, &["status", "--short", "--untracked-files=normal"]).await?;
    Ok(GitReadout {
        initialized: true,
        branch,
        origin,
        changes,
    })
}

pub async fn git_operation(
    registry: &VaultRegistry,
    vault_root: &str,
    action: GitAction,
) -> Result<GitReadout, String> {
    let root = registry.authorize(vault_root)?;
    if matches!(action, GitAction::Init) && !root.join(".git").exists() {
        git(&root, &["init", "-b", "main"]).await?;
    }
    if !matches!(action, GitAction::Status | GitAction::Init) {
        require_repository(&root).await?;
    }
    match action {
        GitAction::Status | GitAction::Init => {}
        GitAction::SetOrigin { url } => {
            validate_origin(&url)?;
            if git(&root, &["config", "--local", "--get", "remote.origin.url"])
                .await
                .is_ok()
            {
                git(&root, &["remote", "set-url", "origin", &url]).await?;
            } else {
                git(&root, &["remote", "add", "origin", &url]).await?;
            }
        }
        GitAction::Commit { message } => {
            if message.trim().is_empty()
                || message.len() > 240
                || message.chars().any(char::is_control)
            {
                return Err("enter a single-line commit message (up to 240 characters)".into());
            }
            git(&root, &["add", "-A", "--", "."]).await?;
            git(&root, &["commit", "-m", &message]).await?;
        }
        GitAction::Pull => {
            validate_origin(
                &git(&root, &["config", "--local", "--get", "remote.origin.url"]).await?,
            )?;
            if !git(&root, &["status", "--porcelain"]).await?.is_empty() {
                return Err("commit or discard local changes before pulling".into());
            }
            let branch = git(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await?;
            git(&root, &["pull", "--ff-only", "origin", &branch]).await?;
        }
        GitAction::Push => {
            validate_origin(
                &git(&root, &["config", "--local", "--get", "remote.origin.url"]).await?,
            )?;
            git(&root, &["push", "--set-upstream", "origin", "HEAD"]).await?;
        }
    }
    status(&root).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn vault_git(
    vault_root: String,
    action: GitAction,
    state: State<'_, VaultRegistry>,
) -> Result<GitReadout, String> {
    git_operation(&state, &vault_root, action).await
}
