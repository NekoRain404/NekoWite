use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use nekowite_lib::commands::vault_git::{git_operation, GitAction};
use nekowite_lib::state::VaultRegistry;

static NEXT: AtomicUsize = AtomicUsize::new(0);

fn vault() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/vault-git-tests")
        .join(format!(
            "{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
    fs::create_dir_all(&root).unwrap();
    root
}

#[tokio::test]
async fn git_operation_rejects_unopened_vault() {
    let root = vault();
    let registry = VaultRegistry::default();
    let refused = git_operation(&registry, root.to_str().unwrap(), GitAction::Status).await;
    assert!(refused.unwrap_err().contains("vault root is not open"));
    assert!(!root.join(".git").exists());

    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn initialized_vault_commits_and_refuses_pull_with_local_changes() {
    let root = vault();
    let registry = VaultRegistry::default();
    let path = root.to_str().unwrap();
    registry.approve_pick(path).unwrap();
    registry.register(path, None).unwrap();
    let result = git_operation(&registry, path, GitAction::Init)
        .await
        .unwrap();
    assert!(result.initialized);
    let local = |key: &str, value: &str| {
        assert!(Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["config", "--local", key, value])
            .status()
            .unwrap()
            .success());
    };
    local("user.name", "NekoWite Test");
    local("user.email", "test@example.invalid");
    fs::write(root.join("note.md"), "initial").unwrap();
    let result = git_operation(
        &registry,
        path,
        GitAction::Commit {
            message: "First note".into(),
        },
    )
    .await
    .unwrap();
    assert!(result.changes.is_empty());
    local("remote.origin.url", "ssh://git.example/notes.git");
    fs::write(root.join("note.md"), "changed").unwrap();
    let refused = git_operation(&registry, path, GitAction::Pull)
        .await
        .unwrap_err();
    assert!(refused.contains("local changes"));
    local("remote.origin.url", "file:///tmp/not-a-network-remote");
    let refused = git_operation(&registry, path, GitAction::Push)
        .await
        .unwrap_err();
    assert!(refused.contains("SSH or HTTPS"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn remote_validation_rejects_credentials_and_local_transports() {
    use nekowite_lib::commands::vault_git::validate_origin;
    assert!(validate_origin("git@code.example:notes/project.git").is_ok());
    assert!(validate_origin("ssh://git@code.example/notes.git").is_ok());
    assert!(validate_origin("https://code.example/notes.git").is_ok());
    for url in [
        "https://user:secret@code.example/notes",
        "file:///tmp/notes",
        "-c core.pager=sh",
        "ssh://host/notes\nexec bad",
        "git@-bad:notes",
        "ssh://-bad/notes",
        "https://-bad/notes",
    ] {
        assert!(validate_origin(url).is_err(), "accepted {url}");
    }
}
