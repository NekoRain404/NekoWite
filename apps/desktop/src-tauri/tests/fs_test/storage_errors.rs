//! What an OS refusal becomes. A storage failure has to reach the user as a sentence naming the
//! operation and the path with a plain-language reason, keeping the raw code for a bug report; these
//! cases also make a path genuinely unreadable, so "permission denied" is exercised instead of
//! assumed.

use super::support::temp_vault;
use nekowite_lib::domain::path_policy::encode_rel_path;
use nekowite_lib::storage::file_store::{list_history, read_file, write_file};
use nekowite_lib::storage::trash_store::{delete_file, list_trash};
#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::path::Path;

// ---------------------------------------------------------------------------
// Test-only filesystem hostility: make a path or a single directory entry
// genuinely unreadable, so "the OS said no" is exercised for real instead of
// being assumed.
// ---------------------------------------------------------------------------

/// Deny read/list access to `path`, like a restrictive ACL or `chmod 000`.
/// Returns false when the filesystem cannot express it here, so the caller can
/// skip instead of asserting against a sandbox that cannot reproduce it.
#[cfg(windows)]
fn deny_read(path: &Path) -> bool {
    use std::process::Command;
    Command::new("icacls")
        .arg(path)
        .args(["/deny", "*S-1-1-0:(RX)"])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// Undo [`deny_read`] so the temp vault can be removed. The test owns the
/// directory, so `takeown` succeeds even while the deny ACE blocks listing it
/// (icacls alone cannot read the DACL back to reset it).
#[cfg(windows)]
fn allow_read_again(path: &Path) {
    use std::process::Command;
    let _ = Command::new("takeown")
        .arg("/f")
        .arg(path)
        .args(["/r", "/d", "y"])
        .output();
    let _ = Command::new("icacls")
        .arg(path)
        .args(["/reset", "/t"])
        .output();
}

#[cfg(unix)]
fn deny_read(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o000)).is_ok()
}

#[cfg(unix)]
fn allow_read_again(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
}

/// Put a link in `dir` whose target does not exist: the directory still lists,
/// but stat-ing that one entry fails. Junctions need no privilege on Windows;
/// on unix the existing symlink-based tests cover the same filesystem shape.
#[cfg(windows)]
fn make_dangling_link(link: &Path) {
    let target = link.with_extension("missing-target");
    let status = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(link)
        .arg(&target)
        .status();
    assert!(
        status.map(|s| s.success()).unwrap_or(false),
        "could not create the test junction at {link:?}"
    );
}

#[cfg(unix)]
fn make_dangling_link(link: &Path) {
    symlink(link.with_extension("missing-target"), link).unwrap();
}

/// Remove a dangling link before the tree holding it is removed.
fn drop_dangling_link(link: &Path) {
    let _ = std::fs::remove_dir(link);
    let _ = std::fs::remove_file(link);
}

/// A storage failure must reach the user as a sentence naming the operation
/// and the file, with a plain-language reason - never as a bare OS code.
///
/// Before this, a missing file read "cannot resolve path: ... (os error 2)"
/// and a refused read was just "Access is denied. (os error 5)": no path, no
/// operation, nothing a user could act on.
#[test]
fn storage_error_messages_name_the_operation_and_the_path() {
    let vault = temp_vault("error-messages");
    let root = vault.to_str().unwrap().to_string();
    // The folder exists, only the note is gone: a genuine file-not-found, not
    // the path-not-found Windows reports when the parent is missing too.
    std::fs::create_dir_all(vault.join("notes")).unwrap();

    let missing = read_file(&root, "notes/nope.md").unwrap_err();
    assert!(
        missing.starts_with("could not "),
        "a readable lead comes first: {missing}"
    );
    assert!(
        missing.contains("nope.md"),
        "the offending path is named: {missing}"
    );
    assert!(
        missing.contains("no such file or folder"),
        "the reason is plain language: {missing}"
    );
    assert!(
        missing.contains("os error 2"),
        "the raw OS code survives for bug reports: {missing}"
    );

    let escape = read_file(&root, "../outside.md").unwrap_err();
    assert!(
        escape.starts_with("path escapes vault"),
        "the stable prefix the frontend matches on is kept: {escape}"
    );
    assert!(
        escape.contains("../outside.md"),
        "the rejected path is named: {escape}"
    );

    std::fs::remove_dir_all(&vault).unwrap();
}

/// The permission-denied text itself, pinned without relying on ACL support:
/// `fs_error` is the single mapper every storage call site goes through.
#[test]
fn permission_denied_message_is_readable() {
    let message = nekowite_lib::errors::fs_error(
        "read",
        Path::new("/vault/notes/a.md"),
        std::io::Error::from(std::io::ErrorKind::PermissionDenied),
    );
    assert!(message.contains("could not read"), "{message}");
    assert!(message.contains("/vault/notes/a.md"), "{message}");
    assert!(message.contains("permission denied"), "{message}");
    assert!(
        message.contains("close whatever is using it"),
        "the message has to suggest something: {message}"
    );
}

/// The same path with a real deny ACE / chmod 000, end to end.
#[test]
fn permission_denied_read_reads_as_permission_denied() {
    let vault = temp_vault("error-permission");
    let root = vault.to_str().unwrap().to_string();
    std::fs::create_dir_all(vault.join("notes")).unwrap();
    let note = vault.join("notes").join("a.md");
    std::fs::write(&note, "hello").unwrap();

    if !deny_read(&note) {
        // The filesystem cannot express the denial; the mapping is already
        // pinned by `permission_denied_message_is_readable`.
        eprintln!("skipping: this filesystem cannot deny read access");
        std::fs::remove_dir_all(&vault).unwrap();
        return;
    }
    let denied = read_file(&root, "notes/a.md").unwrap_err();
    allow_read_again(&note);

    assert!(denied.contains("a.md"), "names the file: {denied}");
    assert!(
        denied.contains("permission denied"),
        "plain-language reason: {denied}"
    );
    assert!(
        denied.contains("os error 5") || denied.contains("os error 13"),
        "keeps the raw code (5 on Windows, 13 on unix): {denied}"
    );

    std::fs::remove_dir_all(&vault).unwrap();
}

/// An unreadable history folder is a failure, never "this note has no
/// versions": the empty list is what the panel renders as "no history yet",
/// which tells the user their snapshots are gone when they are only unreadable.
#[test]
fn list_history_read_denied_is_not_empty() {
    let vault = temp_vault("history-denied");
    let root = vault.to_str().unwrap().to_string();
    write_file(&root, "a.md", "v1", Some(10)).unwrap();
    write_file(&root, "a.md", "v2", Some(10)).unwrap();

    let history_dir = vault
        .join(".nekowite")
        .join("history")
        .join(encode_rel_path("a.md"));
    if !deny_read(&history_dir) {
        eprintln!("skipping: this filesystem cannot deny read access");
        std::fs::remove_dir_all(&vault).unwrap();
        return;
    }
    let result = list_history(&root, "a.md");
    allow_read_again(&history_dir);

    match result {
        Ok(listed) => panic!("an unreadable history must not read as a list: {listed:?}"),
        Err(message) => assert!(
            message.contains("permission denied"),
            "the failure must say what happened: {message}"
        ),
    }
    std::fs::remove_dir_all(&vault).unwrap();
}

/// The trash mirror of the test above: "the trash is empty" must not be the
/// answer to a trash the process was refused permission to read.
#[test]
fn list_trash_read_denied_is_not_empty() {
    let vault = temp_vault("trash-denied");
    let root = vault.to_str().unwrap().to_string();
    write_file(&root, "a.md", "v1", Some(10)).unwrap();
    delete_file(&root, "a.md").unwrap();

    let trash_root = vault.join(".nekowite-trash");
    if !deny_read(&trash_root) {
        eprintln!("skipping: this filesystem cannot deny read access");
        std::fs::remove_dir_all(&vault).unwrap();
        return;
    }
    let result = list_trash(&root);
    allow_read_again(&trash_root);

    match result {
        Ok(listed) => panic!("an unreadable trash must not read as empty: {listed:?}"),
        Err(message) => assert!(
            message.contains("permission denied"),
            "the failure must say what happened: {message}"
        ),
    }
    std::fs::remove_dir_all(&vault).unwrap();
}

/// One unreadable entry is a hole too: a list that is short for a reason the
/// user cannot see is the same lie as an empty one.
#[test]
fn list_history_reports_an_unreadable_entry() {
    let vault = temp_vault("history-bad-entry");
    let root = vault.to_str().unwrap().to_string();
    write_file(&root, "a.md", "v1", Some(10)).unwrap();
    write_file(&root, "a.md", "v2", Some(10)).unwrap();

    let history_dir = vault
        .join(".nekowite")
        .join("history")
        .join(encode_rel_path("a.md"));
    let broken = history_dir.join("zz-broken.md");
    make_dangling_link(&broken);

    let result = list_history(&root, "a.md");
    drop_dangling_link(&broken);

    match result {
        Ok(listed) => panic!("an entry that could not be read must not vanish: {listed:?}"),
        Err(message) => assert!(
            message.contains("zz-broken.md"),
            "the failing entry is named: {message}"
        ),
    }
    std::fs::remove_dir_all(&vault).unwrap();
}

#[test]
fn list_trash_reports_an_unreadable_entry() {
    let vault = temp_vault("trash-bad-entry");
    let root = vault.to_str().unwrap().to_string();
    write_file(&root, "a.md", "v1", Some(10)).unwrap();
    delete_file(&root, "a.md").unwrap();

    let broken = vault.join(".nekowite-trash").join("zz-broken.md");
    make_dangling_link(&broken);

    let result = list_trash(&root);
    drop_dangling_link(&broken);

    match result {
        Ok(listed) => panic!("an entry that could not be read must not vanish: {listed:?}"),
        Err(message) => assert!(
            message.contains("zz-broken.md"),
            "the failing entry is named: {message}"
        ),
    }
    std::fs::remove_dir_all(&vault).unwrap();
}
