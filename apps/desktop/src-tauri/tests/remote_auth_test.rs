use nekowite_lib::commands::remote_auth::RemoteAuth;
use nekowite_lib::commands::remote_workspace::run_transfer;
use tokio::process::Command;

#[test]
fn defaults_to_agent_and_never_formats_passwords() {
    assert!(matches!(RemoteAuth::default(), RemoteAuth::Agent));
    let auth: RemoteAuth =
        serde_json::from_str(r#"{"mode":"password","password":"secret-value"}"#).unwrap();
    assert!(!format!("{auth:?}").contains("secret-value"));
    assert!(auth.validate().is_ok());
}

#[test]
fn refuses_empty_and_multiline_passwords_and_relative_private_keys() {
    for password in ["", "one\ntwo", "one\rtwo", "one\0two"] {
        assert!(RemoteAuth::Password {
            password: password.into()
        }
        .validate()
        .is_err());
    }
    assert!(RemoteAuth::Key {
        identity_file: "id_ed25519".into()
    }
    .validate()
    .is_err());
}

#[test]
fn selected_authentication_controls_options_without_including_the_secret() {
    let password = RemoteAuth::Password {
        password: "private-value".into(),
    };
    assert!(!password.sshfs_options().contains("nonempty"));
    assert!(password
        .sshfs_options()
        .contains("password_stdin,BatchMode=no"));
    assert!(!password.sshfs_options().contains("private-value"));
    assert!(!password.import_transport(22).contains("private-value"));
    let folder =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/remote auth test");
    std::fs::create_dir_all(&folder).unwrap();
    let file = folder.join("private-key");
    std::fs::write(&file, "test key").unwrap();
    let key = RemoteAuth::Key {
        identity_file: file.to_string_lossy().into_owned(),
    };
    assert!(key.validate().is_ok());
    assert!(key.sshfs_options().contains("IdentityFile=\""));
    assert!(key.import_transport(22).contains("-i '"));
    std::fs::remove_dir_all(folder).unwrap();
}

#[tokio::test]
async fn password_travels_only_through_stdin() {
    let auth = RemoteAuth::Password {
        password: "pipe secret".into(),
    };
    let mut command = Command::new("/bin/cat");
    command.stdout(std::process::Stdio::piped());
    auth.prepare_stdin(&mut command);
    assert!(!format!("{command:?}").contains("pipe secret"));
    let mut child = command.spawn().unwrap();
    auth.send_password(&mut child).await.unwrap();
    let output = child.wait_with_output().await.unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"pipe secret\n");
}

#[tokio::test]
async fn a_timed_out_import_stops_the_entire_transfer_group() {
    let marker = std::env::temp_dir().join(format!(
        "nekowite-remote-timeout-marker-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&marker);
    let mut command = Command::new("/bin/sh");
    command.args([
        "-c",
        &format!("(sleep 1; touch '{}') & wait", marker.display()),
    ]);
    let result = run_transfer(
        command,
        &RemoteAuth::Agent,
        std::time::Duration::from_millis(30),
    )
    .await;
    assert!(result.unwrap_err().contains("timed out"));
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    assert!(
        !marker.exists(),
        "a child of the timed-out transfer survived process-group teardown"
    );
}

#[tokio::test]
async fn missing_password_import_dependency_has_an_actionable_error() {
    let auth = RemoteAuth::Password {
        password: "secret".into(),
    };
    let result = run_transfer(
        Command::new("missing-remote-import-executable"),
        &auth,
        std::time::Duration::from_secs(1),
    )
    .await;
    let error = result.unwrap_err();
    assert!(error.contains("sudo apt install sshpass"));
    assert!(error.contains("sudo dnf install sshpass"));
    assert!(!error.contains("secret"));
}
