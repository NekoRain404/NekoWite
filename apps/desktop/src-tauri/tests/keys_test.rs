use nekowite_lib::keys::ensure_keyfile;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

#[test]
fn master_key_created_and_reused() {
    let dir = std::env::temp_dir().join("nkw_keys_test");
    fs::create_dir_all(&dir).unwrap();
    let p: PathBuf = dir.join("master.key");
    let _ = fs::remove_file(&p);
    let a = ensure_keyfile(&p).unwrap();
    let b = ensure_keyfile(&p).unwrap();
    assert_eq!(a, b, "re-reading an existing key file must return the same bytes");
    assert_eq!(a.len(), 32, "master key must be 32 bytes");
    let perm = fs::metadata(&p).unwrap().permissions().mode();
    assert_eq!(perm & 0o777, 0o600, "master key file must be mode 0600");
    fs::remove_dir_all(&dir).unwrap();
}
