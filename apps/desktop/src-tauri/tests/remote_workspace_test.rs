use std::fs;
use std::path::PathBuf;

use nekowite_lib::commands::remote_workspace::{
    import_workspace, import_workspace_using, validate_remote, RemoteSpec,
};
use nekowite_lib::state::VaultRegistry;

fn spec() -> RemoteSpec {
    RemoteSpec {
        user: "writer".into(),
        host: "example.org".into(),
        port: 22,
        remote_path: "/home/writer/notes".into(),
        folder: "remote-notes".into(),
    }
}

#[test]
fn rejects_remote_shell_metacharacters_and_path_traversal() {
    assert!(validate_remote(&spec()).is_ok());
    for (host, path, folder) in [
        ("host;id", "/notes", "remote"),
        ("host", "/notes/../private", "remote"),
        ("host", "/notes", "../escape"),
        ("-host", "/notes", "remote"),
        ("host", "/notes $(id)", "remote"),
    ] {
        let mut entry = spec();
        entry.host = host.into();
        entry.remote_path = path.into();
        entry.folder = folder.into();
        assert!(validate_remote(&entry).is_err());
    }
}

#[tokio::test]
async fn unopened_vault_cannot_import_a_remote_workspace() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/unopened-remote-vault");
    fs::create_dir_all(&root).unwrap();
    let error = import_workspace(&VaultRegistry::default(), root.to_str().unwrap(), spec())
        .await
        .unwrap_err();
    assert!(error.contains("vault root is not open"));
    assert!(!root.join("remote-notes").exists());
}

#[tokio::test]
async fn failed_transfer_removes_only_its_staging_directory() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/failed-remote-vault");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("existing.md"), "keep me").unwrap();
    let registry = VaultRegistry::default();
    let path = root.to_str().unwrap();
    registry.approve_pick(path).unwrap();
    registry.register(path, None).unwrap();
    let error =
        import_workspace_using(&registry, path, spec(), "command-that-does-not-exist-never")
            .await
            .unwrap_err();
    assert!(error.contains("could not start"));
    assert_eq!(
        fs::read_to_string(root.join("existing.md")).unwrap(),
        "keep me"
    );
    assert!(!root.join("remote-notes").exists());
    assert!(!fs::read_dir(&root).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".nekowite-import-")));
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn successful_transfer_exposes_a_new_vault_folder() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/successful-remote-vault");
    fs::create_dir_all(&root).unwrap();
    let registry = VaultRegistry::default();
    let path = root.to_str().unwrap();
    registry.approve_pick(path).unwrap();
    registry.register(path, None).unwrap();
    let imported = import_workspace_using(&registry, path, spec(), "true").await.unwrap();
    assert_eq!(PathBuf::from(imported), root.join("remote-notes"));
    assert!(root.join("remote-notes").is_dir());
    fs::remove_dir_all(root).unwrap();
}
