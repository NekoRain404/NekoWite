//! The key vault's state as the settings section reads it, and the reasons a command against it
//! can refuse.
//!
//! Two things are pinned here, and both are about a *difference* rather than about a value:
//!
//! - **the status read creates nothing.** `read_vault_key_state` answers a missing `master.key`
//!   with nothing beside it by generating a passwordless one — right for a command that is about
//!   to open the vault, and wrong for one that only has to describe it. A status read that minted
//!   a key file would answer "no master password is set" by making that true, and would do it on a
//!   page the user only looked at. `existing_vault_key_state` is the same resolution with that arm
//!   removed, and the first test below is the difference restated as an assertion about the disk.
//! - **a refusal keeps the reason it came with.** The window draws a different next move for each
//!   arm — retype the password, set one, unlock first, or go look at the key file — so the arm has
//!   to survive the wire. `key_file_error` is what classifies the lower layers' sentences, and it
//!   compares against the constants those layers answer with rather than against copies.
//!
//! The scratch directory is cargo's own (`CARGO_TARGET_TMPDIR`, inside this crate's `target/`)
//! rather than the system temporary directory: these are key files, and a run that left them
//! outside the tree would be leaving key material somewhere nobody expects to look for it.
//!
//! **`CARGO_TARGET_TMPDIR` is shared by every concurrent `cargo test` process**, and this
//! repository runs several at once, so the label alone is not a directory — see [`scratch`].

use nekowite_lib::commands::key_vault::{
    key_file_error, status_of, unlock_error, VaultCommandError, VaultKeyStatus,
};
use nekowite_lib::commands::keys::{NO_MASTER_PASSWORD, WRONG_MASTER_PASSWORD};
use nekowite_lib::storage::key_store::{
    encode_keyfile_password, encode_keyfile_passwordless, existing_vault_key_state,
    read_vault_key_state, sibling_suffixed, VaultKeyState,
};
use std::fs;
use std::path::{Path, PathBuf};

/// A directory of this process's own, inside the crate's target directory.
///
/// **The process id is what makes it this process's.** `CARGO_TARGET_TMPDIR` is one directory for
/// every `cargo test` process that shares this target, so a label alone names the same path in all
/// of them — and the `remove_dir_all` below, which exists so a previous run's leftovers cannot be
/// what a test passes on, then deletes a *concurrent* run's key files out from under it. That is
/// not hypothetical: `a_status_read_creates_no_key_file` reported
/// `…/target/tmp/key-vault-status-creates-nothing/master.key: no such file or folder` under two
/// runs at once, and passed on its own. The three sibling helpers in this directory
/// (`agent_skills_test.rs`, `agent_skills_scope_test.rs`, `agent_skills_ipc_test.rs`) carried the
/// id already; this was the one that did not.
fn scratch(label: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("key-vault-status-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// The property the three key-file cases depend on and cannot see: the directory `scratch` hands
/// them is one no concurrent `cargo test` process can be handed.
///
/// Two processes share `CARGO_TARGET_TMPDIR`, so nothing but the id in the name tells them apart —
/// and the failure it prevents is silent and intermittent, which is why the case is here rather
/// than left to the discipline of whoever writes the next helper: a second run's `remove_dir_all`
/// lands on the first run's `master.key` and the first run reports a missing file it never lost.
#[test]
fn a_scratch_directory_is_this_processs_own() {
    let name = scratch("uniqueness")
        .file_name()
        .expect("the scratch path has a final component")
        .to_string_lossy()
        .into_owned();
    assert!(
        name.ends_with(&format!("-{}", std::process::id())),
        "the scratch directory is named {name}, which another `cargo test` process would also \
         take for this label: `CARGO_TARGET_TMPDIR` is shared by all of them, and each run removes \
         its own directory before use"
    );
}

/// What the window is told, as the two fields it branches on.
fn status(state: Option<VaultKeyState>, open: bool) -> (bool, bool) {
    let VaultKeyStatus {
        password_set,
        unlocked,
    } = status_of(state, open);
    (password_set, unlocked)
}

/// The difference this read exists for, stated as an assertion about the disk.
///
/// Both reads are run against a directory with nothing in it. `read_vault_key_state` — the opening
/// read — answers a `VaultKeyState::Auto` and leaves a key file behind, which is what makes a
/// first run work. The status read answers `None` and leaves the directory as it found it.
#[test]
fn a_status_read_creates_no_key_file() {
    let dir = scratch("creates-nothing");
    let key_path = dir.join("master.key");

    let opening = read_vault_key_state(&key_path).unwrap();
    assert!(
        matches!(opening, VaultKeyState::Auto(_)),
        "the opening read is the one that mints a first-run key"
    );
    assert!(key_path.exists(), "and it writes it");

    let empty = dir.join("untouched").join("master.key");
    let status = existing_vault_key_state(&empty).unwrap();
    assert_eq!(
        status, None,
        "with no key material anywhere, the vault is in no state yet — not a passwordless one"
    );
    assert!(
        !empty.exists(),
        "a status read that created the file would answer \"no master password is set\" by \
         making it true"
    );

    let _ = fs::remove_dir_all(&dir);
}

/// The interrupted-swap state, read without opening anything: no `master.key`, and the key file
/// that opens the live snapshot in `master.key.old`.
///
/// The status has to come from the backup for the same reason the load path's does — the password
/// the user must be asked for is only written down there — and the backup must be left alone.
#[test]
fn a_missing_master_key_beside_a_password_backup_reports_a_master_password() {
    let dir = scratch("interrupted-swap");
    let key_path = dir.join("master.key");
    let backup = sibling_suffixed(&key_path, "old");
    fs::write(&backup, encode_keyfile_password(&[7u8; 32], &[9u8; 32])).unwrap();

    assert_eq!(
        existing_vault_key_state(&key_path).unwrap(),
        Some(VaultKeyState::Locked {
            salt: [7u8; 32],
            verifier: [9u8; 32],
        }),
        "the backup holds the only salt and verifier left for the live snapshot"
    );
    assert!(
        !key_path.exists(),
        "and reading it must not forge a passwordless master.key over the state it describes"
    );

    let _ = fs::remove_dir_all(&dir);
}

/// A passwordless backup beside a missing `master.key` is the other half of that state: the
/// snapshot opens without a password, so the vault is not locked and the page must not ask.
#[test]
fn a_passwordless_backup_is_not_a_master_password() {
    let dir = scratch("passwordless-backup");
    let key_path = dir.join("master.key");
    fs::write(
        sibling_suffixed(&key_path, "old"),
        encode_keyfile_passwordless(&[3u8; 32]),
    )
    .unwrap();

    assert_eq!(
        existing_vault_key_state(&key_path).unwrap(),
        Some(VaultKeyState::Auto([3u8; 32])),
        "the key that opens this snapshot is right there and needs no password"
    );
    assert!(
        !key_path.exists(),
        "and nothing was written to find that out"
    );

    let _ = fs::remove_dir_all(&dir);
}

/// The three states the section draws, as a table.
///
/// The rule worth pinning is the third row: a vault with no master password is *usable* before
/// anything has opened it, because there is nothing to ask for. Reporting the open handle alone
/// would draw a fresh install as locked until the first key happened to be read.
#[test]
fn the_three_states_the_window_draws() {
    assert_eq!(
        status(None, false),
        (false, true),
        "a fresh install: no password to set, nothing to unlock"
    );
    assert_eq!(
        status(Some(VaultKeyState::Auto([1u8; 32])), false),
        (false, true),
        "a passwordless vault: the key file opens it without being asked anything"
    );
    assert_eq!(
        status(
            Some(VaultKeyState::Locked {
                salt: [0; 32],
                verifier: [0; 32]
            }),
            false
        ),
        (true, false),
        "a password is set and has not been entered since this process started"
    );
    assert_eq!(
        status(
            Some(VaultKeyState::Locked {
                salt: [0; 32],
                verifier: [0; 32]
            }),
            true
        ),
        (true, true),
        "a password is set and the vault is open"
    );
}

/// Every refusal keeps the arm that says what to do about it, and the wire carries it.
///
/// The two sentences the key-file layers answer with are classified by *value*, so the test uses
/// the constants those layers use — a copy of the string here would pass while the production
/// comparison fell through to the wrong arm.
#[test]
fn a_refusal_keeps_the_reason_it_came_with() {
    assert_eq!(
        key_file_error(NO_MASTER_PASSWORD.to_string()),
        VaultCommandError::NoMasterPassword {
            message: NO_MASTER_PASSWORD.to_string()
        },
        "\"nothing to unlock\" is not \"the password was wrong\""
    );
    assert_eq!(
        unlock_error(WRONG_MASTER_PASSWORD.to_string()),
        VaultCommandError::WrongPassword {
            message: WRONG_MASTER_PASSWORD.to_string()
        },
        "the password failed against every key file, which is the one refusal the user can act on \
         by typing"
    );
    assert_eq!(
        key_file_error(WRONG_MASTER_PASSWORD.to_string()),
        VaultCommandError::KeyFilesUnreadable {
            message: WRONG_MASTER_PASSWORD.to_string()
        },
        "and the key-file classifier is deliberately not the one that knows that sentence: the \
         command that runs the unlock is. This pins the division so a change that moved the \
         password arm down into the file classifier has to say so here"
    );
    assert_eq!(
        key_file_error("master key file has invalid length 12 (expected 34 or 66)".to_string()),
        VaultCommandError::KeyFilesUnreadable {
            message: "master key file has invalid length 12 (expected 34 or 66)".to_string()
        },
        "a damaged key file is the files' problem, and no password fixes it"
    );
}

/// The arms as the window reads them: `{"code": …, "message": …}`.
///
/// The frontend branches on `code` and shows `message`, so the spelling of both is a contract
/// rather than an implementation detail — this is the test that fails if either is renamed.
#[test]
fn the_arms_serialize_to_the_codes_the_window_branches_on() {
    let cases = [
        (
            VaultCommandError::NoMasterPassword {
                message: "no master password is set".into(),
            },
            "noMasterPassword",
        ),
        (
            VaultCommandError::WrongPassword {
                message: "incorrect master password".into(),
            },
            "wrongPassword",
        ),
        (
            VaultCommandError::VaultLocked {
                message: "vault is locked".into(),
            },
            "vaultLocked",
        ),
        (
            VaultCommandError::EmptyPassword {
                message: "password cannot be empty".into(),
            },
            "emptyPassword",
        ),
        (
            VaultCommandError::KeyFilesUnreadable {
                message: "unreadable".into(),
            },
            "keyFilesUnreadable",
        ),
        (
            VaultCommandError::ChangeFailed {
                message: "unchanged".into(),
            },
            "changeFailed",
        ),
    ];
    for (error, code) in cases {
        let wire = serde_json::to_value(&error).unwrap();
        assert_eq!(wire["code"], code, "the arm the window branches on");
        assert_eq!(
            wire["message"],
            error_message(&error),
            "and the sentence it shows, unaltered"
        );
    }
}

/// The `message` one arm carries, read back without a second match arm to fall out of date.
fn error_message(error: &VaultCommandError) -> &str {
    match error {
        VaultCommandError::NoMasterPassword { message }
        | VaultCommandError::WrongPassword { message }
        | VaultCommandError::VaultLocked { message }
        | VaultCommandError::EmptyPassword { message }
        | VaultCommandError::KeyFilesUnreadable { message }
        | VaultCommandError::ChangeFailed { message } => message,
    }
}
