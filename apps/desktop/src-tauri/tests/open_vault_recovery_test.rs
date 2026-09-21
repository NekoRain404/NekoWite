//! The load path's own recovery: what `key_store::open_vault` does with a
//! `Locked` `master.key` beside the passwordless key that still opens the live
//! snapshot.
//!
//! **The state (finding S6 in `docs/audits/2026-09-21-code-review.md`).** A crash
//! between step 4 and step 5 of the `set_master_password` swap promotes the new,
//! password-protected key to `master.key` over a snapshot that is still the old,
//! passwordless one, whose key stays in `master.key.old`. `open_vault` matched
//! `Locked` and refused before consulting the backups, so the window could not
//! open a vault whose key was on disk right beside it — and the unlock could not
//! either, because `password_candidates` builds candidates from typed passwords
//! and a passwordless backup has none to offer. The user was told their password
//! was wrong over a vault that never used one.
//!
//! **Why these cases drive `open_vault` and not a helper.** The arm that broke is
//! the load path the window reaches, and `open_snapshot`'s backup search — the
//! part that always worked — is a function the broken arm never called. A test of
//! the helper would have stayed green through the whole bug, so these build the
//! app under `tauri::test::mock_builder()` with `KeyVault` managed, like the real
//! one is, and hand `open_vault` the state `init` resolves from a real
//! `master.key`.
//!
//! **Cost.** Every `Stronghold::new` pays stronghold's Argon2id KDF, so each case
//! is kept to the opens it needs: a backup that is absent or password-protected is
//! never opened at all, which is why the last two cases cost nothing.

#![cfg(unix)]

use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::Manager;
use tauri_plugin_stronghold::stronghold::Stronghold;

use nekowite_lib::state::KeyVault;
use nekowite_lib::storage::key_store::{
    encode_keyfile_password, encode_keyfile_passwordless, open_vault, read_vault_key_state,
    sibling_suffixed, VaultKeyState,
};

/// The snapshot's single client slot, as the re-encryption path defines it.
const CLIENT: [u8; 32] = [1u8; 32];
/// One stored record, so "the vault opened" means the live data was readable and
/// not merely that a handle came back.
const RECORD: &[u8] = b"openai";
const SECRET: &[u8] = b"sk-live";

/// The refusal a genuinely locked vault gets, word for word. It is the string the
/// window shows, and it is what sends the user to the unlock dialog in the first
/// place, so a change to it is a change to what the user is told to do.
const LOCKED_REFUSAL: &str =
    "vault is locked: unlock it with your master password first (unlock_vault)";

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "nekowite-open-vault-{label}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Write a key file the way the key store does: mode `0600`, synced.
fn write_key_file(path: &Path, bytes: &[u8]) {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    options.mode(0o600);
    let mut f = options.open(path).unwrap();
    f.write_all(bytes).unwrap();
    f.sync_all().unwrap();
}

/// A real snapshot at `path` encrypted with `key`, holding one record — the live
/// vault as the app has it before a master password is set.
fn write_snapshot(path: &Path, key: [u8; 32]) {
    let stronghold = Stronghold::new(path.to_path_buf(), key.to_vec()).unwrap();
    let client = stronghold.inner().create_client(CLIENT).unwrap();
    client
        .store()
        .insert(RECORD.to_vec(), SECRET.to_vec(), None)
        .unwrap();
    stronghold.save().unwrap();
}

/// The app under test: the load path's own managed state, on a runtime that needs
/// no display.
fn app() -> tauri::App<MockRuntime> {
    mock_builder()
        .manage(KeyVault::default())
        .build(mock_context(noop_assets()))
        .expect("the load path's app builds")
}

/// The state the interrupted swap leaves behind: `master.key` holds the new,
/// password-protected key (promoted over a snapshot it cannot decrypt yet) and
/// `master.key.old` holds `backup_key`.
///
/// Returns the paths and the bytes of both key files, so a case can assert that
/// opening the vault rewrote neither.
fn interrupted_swap(
    dir: &Path,
    live_key: [u8; 32],
    backup_key: Option<[u8; 32]>,
) -> (PathBuf, PathBuf, Vec<u8>, Option<Vec<u8>>) {
    let snapshot = dir.join("stronghold.bin");
    let key_path = dir.join("master.key");
    write_snapshot(&snapshot, live_key);

    let locked = encode_keyfile_password(&[42u8; 32], &[43u8; 32]);
    write_key_file(&key_path, &locked);
    let backup = backup_key.map(|key| {
        let bytes = encode_keyfile_passwordless(&key);
        write_key_file(&sibling_suffixed(&key_path, "old"), &bytes);
        bytes
    });
    (snapshot, key_path, locked, backup)
}

/// The `init` the real app installs ([`nekowite_lib::storage::key_store::default_init`]),
/// over this test's paths: the state is read from the `master.key` on disk rather
/// than handed in, so the case covers the resolution the load path really does.
fn init(
    snapshot: &Path,
    key_path: &Path,
) -> impl FnMut() -> Result<(PathBuf, PathBuf, VaultKeyState), String> {
    let snapshot = snapshot.to_path_buf();
    let key_path = key_path.to_path_buf();
    move || {
        Ok((
            snapshot.clone(),
            key_path.clone(),
            read_vault_key_state(&key_path)?,
        ))
    }
}

/// The record `f` reads out of the vault it is handed, so a case proves the
/// stronghold it got is the live vault and not an empty one.
fn read_record(stronghold: &Stronghold) -> Result<Option<String>, String> {
    let client = stronghold
        .inner()
        .load_client(CLIENT)
        .map_err(|e| e.to_string())?;
    Ok(client
        .store()
        .get(RECORD)
        .map_err(|e| e.to_string())?
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string()))
}

/// **The symptom.** The key that opens the live snapshot is in `master.key.old`,
/// and `master.key` is the password-protected key a crash promoted over it.
///
/// Before the fix this failed with [`LOCKED_REFUSAL`]: the load path refused the
/// vault without ever asking whether a backup opens it, so the vault stayed shut
/// while its key sat on disk — and `unlock_vault`, the only path the message
/// offers, derives its candidates from the typed password and skips passwordless
/// backups, so it could not open this vault either. The vault must open with the
/// backup, `f` must see the live records, and the key files must be left exactly
/// as they were: the retry decides, it does not repair.
#[test]
fn a_locked_master_key_opens_from_the_backup_that_decrypts_the_live_snapshot() {
    let dir = temp_dir("locked-live-backup");
    let live_key = [3u8; 32];
    let (snapshot, key_path, locked, backup) = interrupted_swap(&dir, live_key, Some(live_key));
    let backup_path = sibling_suffixed(&key_path, "old");
    assert_eq!(
        read_vault_key_state(&key_path).unwrap(),
        VaultKeyState::Locked {
            salt: [42u8; 32],
            verifier: [43u8; 32]
        },
        "the state under test is the promoted password-protected key"
    );

    let app = app();
    let seen = open_vault(
        app.handle(),
        &mut init(&snapshot, &key_path),
        |stronghold| read_record(stronghold),
    );

    assert_eq!(
        seen.unwrap().as_deref(),
        Some("sk-live"),
        "the backup key opens the live snapshot, so the load path must open with it"
    );
    assert!(
        app.state::<KeyVault>().0.lock().unwrap().is_some(),
        "the vault stays open for the next caller, not only for this closure"
    );

    // A failed retry never writes, and neither does a successful one: the state
    // is left for the user (and the crash-recovery story) exactly as it was.
    assert_eq!(fs::read(&key_path).unwrap(), locked);
    assert_eq!(fs::read(&backup_path).unwrap(), backup.unwrap());
    let _ = fs::remove_dir_all(&dir);
}

/// **The search is not just `.old`.** `displace_current_key` rotates an occupied
/// backup out of that slot rather than deleting it, precisely because it can be
/// the only key that opens the live snapshot — so after two interrupted swaps the
/// key that opens the vault is under the rotated name, behind a canonical slot
/// holding a password-protected file the load path has to skip.
#[test]
fn a_locked_master_key_opens_from_a_rotated_backup_behind_a_password_protected_one() {
    let dir = temp_dir("locked-rotated-backup");
    let snapshot = dir.join("stronghold.bin");
    let key_path = dir.join("master.key");
    let live_key = [3u8; 32];
    write_snapshot(&snapshot, live_key);
    write_key_file(
        &key_path,
        &encode_keyfile_password(&[42u8; 32], &[43u8; 32]),
    );
    write_key_file(
        &sibling_suffixed(&key_path, "old"),
        &encode_keyfile_password(&[44u8; 32], &[45u8; 32]),
    );
    write_key_file(
        &sibling_suffixed(&key_path, "old-1700000000000"),
        &encode_keyfile_passwordless(&live_key),
    );

    let app = app();
    let seen = open_vault(
        app.handle(),
        &mut init(&snapshot, &key_path),
        |stronghold| read_record(stronghold),
    );

    assert_eq!(
        seen.unwrap().as_deref(),
        Some("sk-live"),
        "a rotated backup that opens the live snapshot is a candidate like any other"
    );
    let _ = fs::remove_dir_all(&dir);
}

/// **No bypass.** The same crash state, but the passwordless key beside it does
/// NOT open the live snapshot: this vault's data really is encrypted with
/// something else.
///
/// The refusal must stand, word for word, and the closure must never run. This is
/// the case that stops a later change from "fixing" the one above by ignoring the
/// lock and handing back a stronghold that opens nothing.
#[test]
fn a_locked_master_key_whose_backup_does_not_open_the_snapshot_stays_locked() {
    let dir = temp_dir("locked-wrong-backup");
    let (snapshot, key_path, locked, backup) = interrupted_swap(&dir, [3u8; 32], Some([4u8; 32]));
    let backup_path = sibling_suffixed(&key_path, "old");

    let app = app();
    // The clue is in the closure's return type: `f` is the caller that would see
    // the vault, and there must be no caller to see it.
    let refused = open_vault(
        app.handle(),
        &mut init(&snapshot, &key_path),
        |_| -> Result<(), String> {
            panic!("the vault must not open: no backup key decrypts the live snapshot")
        },
    );

    assert_eq!(refused.unwrap_err(), LOCKED_REFUSAL);
    assert!(
        app.state::<KeyVault>().0.lock().unwrap().is_none(),
        "a refused open must not leave a stronghold behind for the next caller"
    );
    assert_eq!(fs::read(&key_path).unwrap(), locked);
    assert_eq!(fs::read(&backup_path).unwrap(), backup.unwrap());
    let _ = fs::remove_dir_all(&dir);
}

/// **Nothing to recover from.** `master.key` is `Locked` and nothing is beside
/// it: the search must not invent a key, and the refusal is the one the user gets
/// today.
///
/// Cheap on purpose: no backup means no candidate, so no snapshot is ever opened
/// here — and the file at the snapshot path is deliberately not a snapshot, so a
/// future change that tried to open it anyway would fail loudly instead of
/// passing by luck.
#[test]
fn a_locked_master_key_with_no_backup_stays_locked() {
    let dir = temp_dir("locked-no-backup");
    let snapshot = dir.join("stronghold.bin");
    let key_path = dir.join("master.key");
    let locked = encode_keyfile_password(&[42u8; 32], &[43u8; 32]);
    write_key_file(&key_path, &locked);
    fs::write(&snapshot, b"not a snapshot: nothing here may be opened").unwrap();

    let app = app();
    let refused = open_vault(
        app.handle(),
        &mut init(&snapshot, &key_path),
        |_| -> Result<(), String> {
            panic!("no backup key exists, so no closure may reach a stronghold")
        },
    );

    assert_eq!(refused.unwrap_err(), LOCKED_REFUSAL);
    assert_eq!(fs::read(&key_path).unwrap(), locked);
    assert!(
        !sibling_suffixed(&key_path, "old").exists(),
        "a refused open must not forge a backup beside the key file"
    );
    let _ = fs::remove_dir_all(&dir);
}

/// **A password-protected backup is not a key.** When `master.key.old` holds a
/// `Locked` key file — the interrupted `Locked`→`Locked` change, where the user's
/// password is the only way in — the load path has no key to use: the salt and
/// verifier there must be derived from a typed password, which is `unlock_vault`'s
/// job, not this path's.
///
/// Skipping it must not be an error the search reports as a different one: the
/// refusal is unchanged, and no snapshot is opened (so this case costs no KDF).
#[test]
fn a_password_protected_backup_is_skipped_and_the_refusal_stands() {
    let dir = temp_dir("locked-locked-backup");
    let snapshot = dir.join("stronghold.bin");
    let key_path = dir.join("master.key");
    write_key_file(
        &key_path,
        &encode_keyfile_password(&[42u8; 32], &[43u8; 32]),
    );
    let backup = encode_keyfile_password(&[44u8; 32], &[45u8; 32]);
    write_key_file(&sibling_suffixed(&key_path, "old"), &backup);
    fs::write(&snapshot, b"not a snapshot: nothing here may be opened").unwrap();

    let app = app();
    let refused = open_vault(
        app.handle(),
        &mut init(&snapshot, &key_path),
        |_| -> Result<(), String> {
            panic!("a password-protected backup has no key to hand this path")
        },
    );

    assert_eq!(refused.unwrap_err(), LOCKED_REFUSAL);
    assert_eq!(
        fs::read(sibling_suffixed(&key_path, "old")).unwrap(),
        backup
    );
    let _ = fs::remove_dir_all(&dir);
}
