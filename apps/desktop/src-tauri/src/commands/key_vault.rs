//! The key vault's own state, and the vocabulary for refusing to change it.
//!
//! Two halves of one question the settings section has to answer before it can draw anything: what
//! state is the vault in right now ([`key_vault_status`]), and — when a command against it fails —
//! *which* failure was it ([`VaultCommandError`]). They live together because the arms of the
//! error are the states of the read: "there is no master password to unlock" is not a message
//! about a password, it is the read's first state arriving at a command that assumed the second.
//!
//! **"Vault" here is the key vault, not the notes folder.** This crate already uses the word for
//! the authorized notes root (`register_vault`, `VaultRegistry`, `vault_root`), which is why every
//! name in this file carries the `key_` prefix the storage layer uses for the same thing
//! (`storage::key_store`, `domain::key_files`). `master.password` is the notes folder's; this is
//! the file that holds the user's provider keys.
//!
//! Nothing here reads a secret or discloses one. [`key_vault_status`] answers two booleans about
//! the *key file* and the *open handle*, and [`VaultCommandError`] carries the lower layers' own
//! sentences — none of which is built from a password (`key_file_store::validate_password` answers
//! "password cannot be empty" and never quotes what it was given, and every other arm wraps an fs
//! or KDF error that never saw the password at all).

use serde::Serialize;
use tauri::Manager;

use crate::state::KeyVault;
use crate::storage::key_store::{self, VaultKeyState};

/// Why a vault command refused, kept apart all the way to the window.
///
/// Each arm is a different next move, and that is the whole reason they are not one string:
/// "there is no master password to unlock" means the vault the user thinks they have is not the
/// vault they have; "the password did not match" means retype it; "the vault is locked" means
/// unlock first and *then* change it; an unreadable key file means the files are the problem and no
/// amount of typing will help. One "could not unlock" sends every one of them at the password
/// field, which is the one control that cannot fix two of them.
///
/// Serializes as `{"code": "wrongPassword", "message": "…"}`, so the window branches on the code
/// and shows the message — the two are not the same job and neither is a rendering of the other.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum VaultCommandError {
    /// `unlock_vault` on a vault that has no master password to unlock.
    NoMasterPassword { message: String },
    /// The password matched no verifier in any key file that could open the snapshot.
    WrongPassword { message: String },
    /// `set_master_password` on a password-protected vault that has not been unlocked yet.
    VaultLocked { message: String },
    /// An empty or whitespace-only password.
    EmptyPassword { message: String },
    /// The key files on disk could not be read — missing with no readable backup, malformed, or
    /// unreadable. The message names the file where there is one to name.
    KeyFilesUnreadable { message: String },
    /// The change could not be completed. The vault on disk is left as it was; the message is the
    /// storage layer's own.
    ChangeFailed { message: String },
}

/// The arm a failure from the key-file layer belongs to.
///
/// One of those layers' sentences is *named* — [`crate::commands::keys::NO_MASTER_PASSWORD`] —
/// because it is the one that is not about the files at all, and the comparison is against the
/// constant that function answers with rather than a copy of it, so a rewording cannot leave the
/// arm silently unreachable.
///
/// Everything else a key file can fail with is the files' problem rather than the password's: a
/// missing `master.key` whose backups hold nothing readable, a malformed one, an fs error, a KDF
/// that could not run. They are one arm because they are one next move — nothing the user types at
/// the password field changes any of them.
pub fn key_file_error(message: String) -> VaultCommandError {
    if message == crate::commands::keys::NO_MASTER_PASSWORD {
        VaultCommandError::NoMasterPassword { message }
    } else {
        VaultCommandError::KeyFilesUnreadable { message }
    }
}

/// The arm an [`crate::commands::keys::unlock_snapshot`] failure belongs to.
///
/// That function answers [`crate::commands::keys::WRONG_MASTER_PASSWORD`] when every key file was
/// tried and the password matched none of them, and one of [`key_file_error`]'s sentences
/// otherwise — so this is the one caller that has to name the password arm as well, and it does it
/// here rather than at the command, where the constant and the arm it produces would sit in
/// different files.
pub fn unlock_error(message: String) -> VaultCommandError {
    if message == crate::commands::keys::WRONG_MASTER_PASSWORD {
        VaultCommandError::WrongPassword { message }
    } else {
        key_file_error(message)
    }
}

/// What the master password is doing right now, in the terms the settings section draws.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultKeyStatus {
    /// A master password is set. The key file holds a salt and a one-way verifier instead of a key,
    /// so no command can open the vault until `unlock_vault` has been given that password.
    pub password_set: bool,
    /// The vault can be used right now without asking the user for anything — it is open in this
    /// process, or it has no password to ask for. `false` describes exactly one state: a password
    /// is set and has not been entered since this process started.
    pub unlocked: bool,
}

/// The status the window draws, from the two facts the command can observe.
///
/// Pure, so the one rule that is not a matter of reading a field — a vault with no password is
/// usable before anything has opened it — is stated where it can be tested rather than inline in a
/// command that needs an `AppHandle`.
///
/// `state` is `None` for "no key material on disk at all": a fresh install, which has no master
/// password and none of the problems one brings. It is the same answer as a passwordless file,
/// which is the point — the two differ in what the vault would do on first use, not in what the
/// user has to be told.
pub fn status_of(state: Option<VaultKeyState>, open: bool) -> VaultKeyStatus {
    let password_set = matches!(state, Some(VaultKeyState::Locked { .. }));
    VaultKeyStatus {
        password_set,
        // A passwordless vault asks for nothing, so it is usable from the moment the app starts
        // even though nothing has opened it yet. Reporting `open` alone here would draw a vault
        // with no password as locked until the first key was read.
        unlocked: !password_set || open,
    }
}

/// Read the key vault's state without changing it.
///
/// The read the settings section needs and could not make: without it the section has two
/// controls and no way to say which of them is the one that applies, which is the difference
/// between a page that offers to unlock a vault that has no password and a page that offers to set
/// one that already has it.
///
/// **It creates nothing.** `read_vault_key_state` answers a missing `master.key` by generating a
/// passwordless one, which is right for an opening command and wrong here —
/// `existing_vault_key_state` is the same resolution with that arm removed. A status read that
/// minted a key file would have answered "no master password is set" by making it true. A key file
/// already on disk is still upgraded to the current format if it is a legacy bare key, exactly as
/// every other read path upgrades it; see that function for why that is not the same thing.
///
/// An unreadable key file is an error rather than a state: this is a description of what is on
/// disk, and "I could not read it" is not one of the things that can be on disk. The section draws
/// it as its own arm rather than picking a state to guess at.
#[tauri::command]
pub async fn key_vault_status(app: tauri::AppHandle) -> Result<VaultKeyStatus, String> {
    // The key file is read BEFORE the vault lock is taken. The answer is about the files, and
    // holding the lock across an fs read would stall every other vault command for a reason none
    // of them has.
    let key_path = key_store::master_key_path(&app)?;
    let state = key_store::existing_vault_key_state(&key_path)?;
    let open = app
        .state::<KeyVault>()
        .0
        .lock()
        .map_err(|e| format!("the key vault could not be read: {e}"))?
        .is_some();
    Ok(status_of(state, open))
}
