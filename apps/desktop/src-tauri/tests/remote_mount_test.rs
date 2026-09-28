use std::fs;
use std::path::PathBuf;

use nekowite_lib::commands::remote_mount::{
    connect_using, disconnect_using, is_mounted_in, RemoteMountState,
};
use nekowite_lib::commands::remote_workspace::RemoteSpec;
use nekowite_lib::domain::path_policy::resolve_within;
use nekowite_lib::state::VaultRegistry;

fn spec() -> RemoteSpec {
    RemoteSpec {
        user: "writer".into(),
        host: "example.org".into(),
        port: 22,
        remote_path: "/home/writer/notes".into(),
        folder: "live-notes".into(),
    }
}

fn root(label: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("target/{label}"));
    fs::create_dir_all(&root).unwrap();
    root
}

#[tokio::test]
async fn cannot_mount_into_an_unopened_vault() {
    let root = root("remote-mount-unopened");
    let result = connect_using(
        &VaultRegistry::default(),
        &RemoteMountState::default(),
        root.to_str().unwrap(),
        spec(),
        "sshfs",
    )
    .await;
    assert!(result.unwrap_err().contains("vault root is not open"));
    assert!(!root.join("live-notes").exists());
}

#[tokio::test]
async fn failed_start_keeps_existing_files_and_removes_its_empty_mountpoint() {
    let root = root("remote-mount-failure");
    fs::write(root.join("existing.md"), "keep me").unwrap();
    let registry = VaultRegistry::default();
    let path = root.to_str().unwrap();
    registry.approve_pick(path).unwrap();
    registry.register(path, None).unwrap();
    let state = RemoteMountState::default();
    let result = connect_using(
        &registry,
        &state,
        path,
        spec(),
        "missing-sshfs-test-command",
    )
    .await;
    assert!(result.unwrap_err().contains("SSHFS"));
    assert_eq!(
        fs::read_to_string(root.join("existing.md")).unwrap(),
        "keep me"
    );
    assert!(!root.join("live-notes").exists());
}

#[tokio::test]
async fn cannot_reuse_a_local_folder_as_a_remote_mount() {
    let root = root("remote-mount-existing");
    fs::create_dir_all(root.join("live-notes")).unwrap();
    let registry = VaultRegistry::default();
    let path = root.to_str().unwrap();
    registry.approve_pick(path).unwrap();
    registry.register(path, None).unwrap();
    let result = connect_using(
        &registry,
        &RemoteMountState::default(),
        path,
        spec(),
        "sshfs",
    )
    .await;
    assert!(result.unwrap_err().contains("already exists"));
    assert!(root.join("live-notes").is_dir());
}

#[tokio::test]
async fn concurrent_connection_to_the_same_folder_is_refused() {
    let root = root("remote-mount-concurrent");
    let registry = VaultRegistry::default();
    let path = root.to_str().unwrap();
    registry.approve_pick(path).unwrap();
    registry.register(path, None).unwrap();
    let state = RemoteMountState::default();
    let target = root.join("live-notes");
    let reservation = state.reserve(&target).unwrap();
    let result = connect_using(&registry, &state, path, spec(), "sshfs").await;
    assert!(result.unwrap_err().contains("already connecting"));
    assert!(!target.exists());
    drop(reservation);
}

#[tokio::test]
async fn can_retry_an_offline_placeholder_without_deleting_it_on_failure() {
    let root = root("remote-mount-retry");
    let folder = root.join("live-notes");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join(".nekowite-remote-placeholder"), b"").unwrap();
    let registry = VaultRegistry::default();
    let path = root.to_str().unwrap();
    registry.approve_pick(path).unwrap();
    registry.register(path, None).unwrap();
    let result = connect_using(
        &registry,
        &RemoteMountState::default(),
        path,
        spec(),
        "missing-sshfs-test-command",
    )
    .await;
    assert!(result.unwrap_err().contains("SSHFS"));
    assert!(folder.join(".nekowite-remote-placeholder").exists());
    fs::remove_dir_all(folder).unwrap();
}

#[test]
fn mountinfo_matches_exact_mountpoint_and_decodes_spaces() {
    let root = PathBuf::from("/notes/remote dir");
    let info = "12 1 0:1 / /notes/remote\\040dir rw - fuse.sshfs source rw\n";
    assert!(is_mounted_in(info, &root));
    assert!(!is_mounted_in(info, &PathBuf::from("/notes/remote")));
    assert!(!is_mounted_in(
        "12 1 0:1 / /notes/remote\\040dir rw - ext4 source rw\n",
        &root,
    ));
}

#[tokio::test]
async fn disconnect_refuses_unowned_and_parent_paths() {
    let root = root("remote-mount-disconnect");
    let registry = VaultRegistry::default();
    let path = root.to_str().unwrap();
    registry.approve_pick(path).unwrap();
    registry.register(path, None).unwrap();
    let state = RemoteMountState::default();
    assert!(
        disconnect_using(&registry, &state, path, "../existing", "fusermount3")
            .await
            .is_err()
    );
    assert!(
        disconnect_using(&registry, &state, path, "existing", "fusermount3")
            .await
            .unwrap_err()
            .contains("not owned")
    );
}

#[test]
fn unmounted_placeholder_refuses_file_access() {
    let root = root("remote-mount-offline");
    let folder = root.join("live-notes");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join(".nekowite-remote-placeholder"), b"").unwrap();
    assert!(resolve_within(root.to_str().unwrap(), "live-notes/note.md")
        .unwrap_err()
        .contains("remote connection is offline"));
    fs::remove_dir_all(folder).unwrap();
}
