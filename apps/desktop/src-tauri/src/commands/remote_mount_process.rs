//! Start SSHFS and confirm that authentication completed before exposing the mount.
use std::path::Path;
use std::time::Duration;

use tokio::process::{Child, Command};

use super::remote_mount::is_mounted;
use super::remote_workspace::RemoteSpec;

pub async fn verify_remote_directory(target: &Path) -> Result<(), String> {
    if !is_mounted(target)? {
        return Err("SSHFS is not mounted".into());
    }
    // SSHFS can appear in mountinfo before its SSH handshake finishes. A FUSE
    // directory read must complete before the editor may treat it as writable.
    let mut directory = tokio::time::timeout(Duration::from_secs(12), tokio::fs::read_dir(target))
        .await
        .map_err(|_| "SSHFS authentication timed out".to_string())?
        .map_err(|error| format!("SSHFS remote directory unavailable: {error}"))?;
    tokio::time::timeout(Duration::from_secs(12), directory.next_entry())
        .await
        .map_err(|_| "SSHFS authentication timed out".to_string())?
        .map_err(|error| format!("SSHFS remote directory unavailable: {error}"))?;
    if !is_mounted(target)? {
        return Err("SSHFS disconnected during authentication".into());
    }
    Ok(())
}

pub async fn start_mount(target: &Path, spec: &RemoteSpec, program: &str) -> Result<Child, String> {
    let source = format!("{}@{}:{}", spec.user, spec.host, spec.remote_path);
    let mut command = Command::new(program);
    command
        .args(["-f", "-o", &spec.auth.sshfs_options(), "-p"])
        .arg(spec.port.to_string())
        .arg(source)
        .arg(target)
        .kill_on_drop(true);
    spec.auth.prepare_stdin(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("SSHFS could not start (install sshfs on Linux): {error}"))?;
    spec.auth.send_password(&mut child).await?;
    for _ in 0..120 {
        if is_mounted(target)? {
            match verify_remote_directory(target).await {
                Ok(()) => return Ok(child),
                Err(error) => {
                    let _ = child.kill().await;
                    return Err(error);
                }
            }
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
