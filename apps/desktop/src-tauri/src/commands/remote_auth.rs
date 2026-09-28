//! One SSH authentication choice shared by live mounts and one-time imports.
use std::path::Path;
use std::process::Stdio;

use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};

#[derive(Default, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum RemoteAuth {
    #[default]
    Agent,
    Key {
        #[serde(rename = "identityFile")]
        identity_file: String,
    },
    Password {
        password: String,
    },
}

impl std::fmt::Debug for RemoteAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Agent => f.write_str("Agent"),
            Self::Key { .. } => f.write_str("Key { identity_file: [redacted] }"),
            Self::Password { .. } => f.write_str("Password { password: [redacted] }"),
        }
    }
}

impl RemoteAuth {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Agent => Ok(()),
            Self::Password { password }
                if !password.is_empty()
                    && password.len() <= 4096
                    && !password.contains(['\n', '\r', '\0']) =>
            {
                Ok(())
            }
            Self::Password { .. } => Err("enter a password without line breaks".into()),
            Self::Key { identity_file } => {
                let path = Path::new(identity_file);
                if !path.is_absolute()
                    || identity_file.contains(['\0', '\n', '\r', ',', '\'', '"', '\\'])
                    || !path.is_file()
                {
                    return Err("choose an existing absolute private-key file without quotes or option delimiters".into());
                }
                Ok(())
            }
        }
    }

    pub fn sshfs_options(&self) -> String {
        let base = "reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,StrictHostKeyChecking=yes,ConnectTimeout=10,cache=no,dir_cache=no";
        match self {
            Self::Agent => format!("{base},BatchMode=yes"),
            Self::Key { identity_file } => format!("{base},BatchMode=yes,IdentitiesOnly=yes,IdentityFile=\"{identity_file}\""),
            Self::Password { .. } => format!("{base},password_stdin,BatchMode=no,NumberOfPasswordPrompts=1,PreferredAuthentications=password,PubkeyAuthentication=no"),
        }
    }

    pub fn import_transport(&self, port: u16) -> String {
        let base = format!("ssh -oStrictHostKeyChecking=yes -oConnectTimeout=10 -p {port}");
        match self {
            Self::Agent => format!("{base} -oBatchMode=yes"),
            Self::Key { identity_file } => format!("{base} -oBatchMode=yes -oIdentitiesOnly=yes -i '{identity_file}'"),
            Self::Password { .. } => format!("{base} -oBatchMode=no -oNumberOfPasswordPrompts=1 -oPreferredAuthentications=password -oPubkeyAuthentication=no"),
        }
    }

    pub fn prepare_stdin(&self, command: &mut Command) {
        if matches!(self, Self::Password { .. }) {
            command.stdin(Stdio::piped());
        }
    }

    pub async fn send_password(&self, child: &mut Child) -> Result<(), String> {
        if let Self::Password { password } = self {
            // The child owns the only pipe. No password reaches argv, env or disk.
            let mut stdin = child
                .stdin
                .take()
                .ok_or("authentication pipe unavailable")?;
            stdin
                .write_all(password.as_bytes())
                .await
                .map_err(|_| "could not send authentication".to_string())?;
            stdin
                .write_all(b"\n")
                .await
                .map_err(|_| "could not send authentication".to_string())?;
        }
        Ok(())
    }
}
