use nekowite_lib::VaultRegistry;
use std::path::PathBuf;

#[cfg(unix)]
use std::os::unix::fs::symlink;

fn temp_vault(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-vaultauth-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// [A] A vault root the user never opened is refused by `authorize`, with a
/// recovery hint — this is the P0 hole: an arbitrary absolute path must not be
/// treated as a valid vault root.
#[test]
fn unregistered_vault_root_is_rejected() {
    let reg = VaultRegistry::default();
    let dir = temp_vault("never-opened");
    let root = dir.to_str().unwrap();
    let err = reg.authorize(root).unwrap_err();
    assert!(
        err.contains("vault root is not open"),
        "expected 'not open' error, got: {err}"
    );
    assert!(
        err.contains("register_vault"),
        "expected a recovery hint naming register_vault, got: {err}"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

/// [A] Registering a vault root (the user-opened vault) makes it authorized;
/// any other root is still rejected.
#[test]
fn registered_vault_is_authorized_and_others_refused() {
    let reg = VaultRegistry::default();
    let dir = temp_vault("opened");
    let root = dir.to_str().unwrap();
    let canonical = reg.register(root).unwrap();
    assert!(canonical.is_absolute(), "authorized root is absolute");
    assert!(reg.authorize(root).is_ok(), "registered vault is served");

    // A different, never-registered absolute path is still refused.
    assert!(reg.authorize("/etc").is_err());
    assert!(reg.authorize("/usr").is_err());

    std::fs::remove_dir_all(&dir).unwrap();
}

/// [A] Registration and authorization agree even when the caller spells the
/// vault through a symlink: both canonicalize, so the same vault is recognized
/// under either spelling.
#[cfg(unix)]
#[test]
fn register_canonicalizes_symlinked_alias() {
    let reg = VaultRegistry::default();
    let dir = temp_vault("symlink");
    let alias = temp_vault("symlink-alias");
    let alias_link = alias.join("vault");
    symlink(&dir, &alias_link).unwrap();

    let alias_root = alias_link.to_str().unwrap();
    reg.register(alias_root).unwrap();

    // The real (canonical) path is authorized too, since both canonicalize to
    // the same directory.
    assert!(reg.authorize(dir.to_str().unwrap()).is_ok());
    assert!(reg.authorize(alias_root).is_ok());

    // An unrelated root remains refused.
    assert!(reg.authorize("/tmp").is_err());

    std::fs::remove_dir_all(&dir).unwrap();
    std::fs::remove_dir_all(&alias).unwrap();
}

/// [A] Relative paths are rejected the same way the fs layer rejects them
/// (a vault root must be an absolute path).
#[test]
fn relative_root_is_rejected() {
    let reg = VaultRegistry::default();
    assert!(reg.register("relative/vault").is_err());
    assert!(reg.authorize("relative/vault").is_err());
    assert!(reg.register(".").is_err());
}
