//! Vault authorization: which root the backend is willing to serve.
//!
//! `register_vault` is reachable from the window, so a path it is handed is a
//! path a compromised renderer can hand it. These tests pin the two things that
//! make the authority real: a root must be a folder the user actually chose
//! (a native dialog pick, or the root the backend itself recorded last), and it
//! must be structurally capable of being a vault at all — never the filesystem
//! root and never the user's home.

use nekowite_lib::state::{read_remembered_vault, write_remembered_vault};
use nekowite_lib::VaultRegistry;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::symlink;

fn temp_vault(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-vaultauth-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn as_str(path: &Path) -> &str {
    path.to_str().unwrap()
}

/// The folder dialog's half of the handshake: the user picked this folder.
fn picked(reg: &VaultRegistry, path: &Path) {
    reg.approve_pick(as_str(path)).unwrap();
}

// ---------------------------------------------------------------------------
// Registration requires a user choice
// ---------------------------------------------------------------------------

/// [A] A vault root the user never opened is refused by `authorize`, with a
/// recovery hint — this is the P0 hole: an arbitrary absolute path must not be
/// treated as a valid vault root.
#[test]
fn unregistered_vault_root_is_rejected() {
    let reg = VaultRegistry::default();
    let dir = temp_vault("never-opened");
    let root = as_str(&dir);
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

/// [A] The hole this closes: a real folder the user never chose is not a vault
/// just because the interface says so.
#[test]
fn a_folder_the_user_never_chose_is_refused() {
    let reg = VaultRegistry::default();
    let dir = temp_vault("not-chosen");
    let err = reg.register(as_str(&dir), None).unwrap_err();
    assert!(
        err.contains("did not choose"),
        "expected a 'not chosen' refusal, got: {err}"
    );
    assert!(
        err.contains("Open folder"),
        "the error must say how to open it, got: {err}"
    );
    assert!(
        reg.authorize(as_str(&dir)).is_err(),
        "a refused registration must not authorize anything"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A root that *was* chosen in the folder dialog is served, and any other root
/// is still refused.
#[test]
fn a_chosen_folder_is_served_and_others_are_refused() {
    let reg = VaultRegistry::default();
    let dir = temp_vault("opened");
    let root = as_str(&dir);
    picked(&reg, &dir);
    let canonical = reg.register(root, None).unwrap();
    assert!(canonical.is_absolute(), "authorized root is absolute");
    assert!(reg.authorize(root).is_ok(), "registered vault is served");

    // A different, never-chosen absolute path is still refused.
    assert!(reg.authorize("/etc").is_err());
    assert!(reg.authorize("/usr").is_err());
    assert!(reg.register("/etc", None).is_err());

    std::fs::remove_dir_all(&dir).unwrap();
}

/// The restore path: the root the backend itself recorded last is accepted
/// without a fresh dialog, and that record does not vouch for anything else.
#[test]
fn the_root_the_backend_remembered_is_accepted_and_nothing_else_is() {
    let reg = VaultRegistry::default();
    let remembered = temp_vault("remembered");
    let other = temp_vault("remembered-other");

    let canonical = reg
        .register(as_str(&remembered), Some(&remembered))
        .expect("the recorded root is the one the user opened last");
    assert_eq!(canonical, remembered.canonicalize().unwrap());
    assert!(reg.authorize(as_str(&remembered)).is_ok());

    // A record for one root never authorizes a different one.
    let err = reg.register(as_str(&other), Some(&remembered)).unwrap_err();
    assert!(err.contains("did not choose"), "got: {err}");

    // Nor does a successful restore launder a second root: the record now names
    // the vault that was just opened, and that record is what the renderer
    // would have to reproduce for the next one.
    assert!(reg.register(as_str(&other), Some(&remembered)).is_err());

    std::fs::remove_dir_all(&remembered).unwrap();
    std::fs::remove_dir_all(&other).unwrap();
}

/// Registering a second vault replaces the first: the UI is single-vault, and
/// a closed root must not stay authorized for the rest of the session.
#[test]
fn registering_a_new_vault_unauthorizes_the_previous() {
    let reg = VaultRegistry::default();
    let first = temp_vault("first");
    let second = temp_vault("second");
    picked(&reg, &first);
    picked(&reg, &second);
    reg.register(as_str(&first), None).unwrap();
    assert!(reg.authorize(as_str(&first)).is_ok());
    reg.register(as_str(&second), None).unwrap();
    assert!(reg.authorize(as_str(&second)).is_ok());
    assert!(
        reg.authorize(as_str(&first)).is_err(),
        "the previous vault must not stay authorized after a switch"
    );
    std::fs::remove_dir_all(&first).unwrap();
    std::fs::remove_dir_all(&second).unwrap();
}

/// The roadmap's nested-vault case: opening a folder inside the vault that is
/// open closes the parent for every path-confined command, even though the
/// parent's files are still on disk.
#[test]
fn switching_to_a_nested_vault_unauthorizes_the_parent() {
    let reg = VaultRegistry::default();
    let parent = temp_vault("nested-parent");
    let nested = parent.join("inner");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::write(parent.join("outside.md"), "# parent note\n").unwrap();
    std::fs::write(nested.join("inside.md"), "# nested note\n").unwrap();

    picked(&reg, &parent);
    reg.register(as_str(&parent), None).unwrap();
    assert!(reg.authorize(as_str(&parent)).is_ok());

    picked(&reg, &nested);
    reg.register(as_str(&nested), None).unwrap();
    assert!(reg.authorize(as_str(&nested)).is_ok());
    assert!(
        reg.authorize(as_str(&parent)).is_err(),
        "the parent vault is closed once its child is opened"
    );
    assert!(
        reg.authorize(as_str(&nested.join("inside.md"))).is_err(),
        "only the root itself is authorized, never a file inside it"
    );

    std::fs::remove_dir_all(&parent).unwrap();
}

#[test]
fn unregister_drops_authorization() {
    let reg = VaultRegistry::default();
    let dir = temp_vault("unreg");
    let root = as_str(&dir);
    picked(&reg, &dir);
    reg.register(root, None).unwrap();
    assert!(reg.authorize(root).is_ok());
    reg.unregister(root).unwrap();
    assert!(reg.authorize(root).is_err());
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

    let alias_root = as_str(&alias_link);
    picked(&reg, &alias_link);
    reg.register(alias_root, None).unwrap();

    // The real (canonical) path is authorized too, since both canonicalize to
    // the same directory.
    assert!(reg.authorize(as_str(&dir)).is_ok());
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
    assert!(reg.register("relative/vault", None).is_err());
    assert!(reg.authorize("relative/vault").is_err());
    assert!(reg.register(".", None).is_err());
}

// ---------------------------------------------------------------------------
// Structural refusals: a choice does not make every folder a vault
// ---------------------------------------------------------------------------

/// `/` is never a vault: it is the ancestor of every file on the machine, so
/// registering it would turn every path-confined command into an unrestricted
/// one. It is refused even when the renderer claims the user picked it.
#[test]
fn the_filesystem_root_is_refused_even_when_claimed_as_a_pick() {
    let reg = VaultRegistry::default();
    reg.approve_pick("/").unwrap();
    let err = reg.register("/", None).unwrap_err();
    assert!(
        err.contains("filesystem root"),
        "expected the root refusal, got: {err}"
    );
    assert!(reg.authorize("/").is_err());
}

/// The user's home directory is refused for the same reason, and so is any
/// ancestor of it (`/home`, and `/` again on a machine whose home is deeper).
/// Notes live in a folder inside home; home itself holds `.ssh`, `.config` and
/// every other secret the app has no business serving.
#[cfg(unix)]
#[test]
fn the_home_directory_and_its_ancestors_are_refused_even_when_claimed_as_a_pick() {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return;
    };
    let Some(home) = home.canonicalize().ok() else {
        return;
    };
    if !home.is_dir() {
        return;
    }
    let reg = VaultRegistry::default();
    reg.approve_pick(as_str(&home)).unwrap();
    let err = reg.register(as_str(&home), None).unwrap_err();
    assert!(
        err.contains("home directory"),
        "expected the home refusal, got: {err}"
    );

    // Only meaningful when the ancestor exists and is not already the root.
    if let Some(ancestor) = home.parent() {
        if ancestor != Path::new("/") && ancestor.is_dir() {
            let reg = VaultRegistry::default();
            let _ = reg.approve_pick(as_str(ancestor));
            let err = reg.register(as_str(ancestor), None).unwrap_err();
            assert!(
                err.contains("home directory"),
                "an ancestor of home may not become a vault, got: {err}"
            );
        }
    }
}

/// A file, a missing path, and a relative spelling are not vault roots.
#[test]
fn a_vault_root_must_be_an_existing_folder() {
    let reg = VaultRegistry::default();
    let dir = temp_vault("shape");
    let file = dir.join("note.md");
    std::fs::write(&file, "# note\n").unwrap();
    // A folder dialog cannot return a file, and the pick is refused as such —
    // but even a root that claims to have been picked must still be a folder.
    assert!(reg.approve_pick(as_str(&file)).is_err());
    let err = reg.register(as_str(&file), None).unwrap_err();
    assert!(err.contains("not a folder"), "got: {err}");

    let missing = dir.join("nope");
    let _ = reg.approve_pick(as_str(&missing));
    assert!(reg.register(as_str(&missing), None).is_err());

    std::fs::remove_dir_all(&dir).unwrap();
}

/// The classic escalation: having opened a vault, ask for its parent so every
/// neighbouring folder comes with it. The parent was never chosen by hand.
#[test]
fn the_parent_of_an_opened_vault_is_refused() {
    let reg = VaultRegistry::default();
    let parent = temp_vault("escalate");
    let vault = parent.join("notes");
    std::fs::create_dir_all(&vault).unwrap();

    picked(&reg, &vault);
    reg.register(as_str(&vault), None).unwrap();
    assert!(reg.authorize(as_str(&vault)).is_ok());

    let err = reg.register(as_str(&parent), None).unwrap_err();
    assert!(err.contains("did not choose"), "got: {err}");
    assert!(
        reg.authorize(as_str(&parent)).is_err(),
        "the parent must not be served after the attempt"
    );
    // ... and the vault that was open stays open: a refused registration must
    // not tear down what the user is working in.
    assert!(reg.authorize(as_str(&vault)).is_ok());

    std::fs::remove_dir_all(&parent).unwrap();
}

// ---------------------------------------------------------------------------
// The record restore depends on
// ---------------------------------------------------------------------------

/// The backend-owned record round-trips a canonical root, and a missing or
/// unusable record vouches for nothing (a relative or empty line is exactly
/// what a tampered record would look like).
#[test]
fn the_remembered_vault_record_round_trips_and_rejects_junk() {
    let dir = temp_vault("record");
    let file = dir.join("last-vault");
    let vault = dir.join("vault");
    std::fs::create_dir_all(&vault).unwrap();

    assert!(read_remembered_vault(&file).is_none(), "no record yet");

    let canonical = vault.canonicalize().unwrap();
    write_remembered_vault(&file, &canonical).unwrap();
    let read = read_remembered_vault(&file).expect("the record round-trips");
    assert_eq!(read, canonical);

    std::fs::write(&file, "relative/vault\n").unwrap();
    assert!(
        read_remembered_vault(&file).is_none(),
        "a relative path is not a vault record"
    );
    std::fs::write(&file, "\n").unwrap();
    assert!(read_remembered_vault(&file).is_none());

    std::fs::remove_dir_all(&dir).unwrap();
}

/// The case the test above does not cover, and the one the Rust audit named: a
/// WELL-FORMED record — an absolute path to a folder that exists, exactly what
/// [`write_remembered_vault`] writes — naming a directory the user never chose.
///
/// It is honoured, deliberately. The record is the second of the two things
/// that vouch for a root (`register`'s `recalled`), and the restore it serves
/// is load-bearing: a session starts on the vault the user was in yesterday
/// without a dialog. What made it a hole was never the trust — it was that the
/// file was writable from inside a vault that CONTAINS the config directory, so
/// the window could manufacture a record naming any absolute path at all, and
/// `register_vault` then accepted it for that session and the next one.
///
/// That write is what is refused now, whatever command attempts it and whether
/// it reads or writes: [`crate::domain::app_owned`], applied in
/// `resolve_within_rel`, the one function every path-confined command's target
/// goes through. `tests/app_owned_dirs_test.rs` performs the forgery and
/// watches it be refused; this test pins what is left of the mechanism, so the
/// boundary is visible instead of looking like a gap.
#[test]
fn a_well_formed_record_is_the_authority_it_looks_like() {
    let never_chosen = temp_vault("record-names-a-stranger");
    let record_file = temp_vault("record-file").join("last-vault");
    let forged = never_chosen.canonicalize().unwrap();
    write_remembered_vault(&record_file, &forged).unwrap();

    let recorded = read_remembered_vault(&record_file).expect("a well-formed record reads back");
    assert_eq!(recorded, forged);

    let reg = VaultRegistry::default();
    assert!(
        reg.register(as_str(&forged), Some(&recorded)).is_ok(),
        "the record vouches for the root it names: the refusal is at the write"
    );
    assert!(reg.authorize(as_str(&forged)).is_ok());

    std::fs::remove_dir_all(&never_chosen).unwrap();
    std::fs::remove_dir_all(record_file.parent().unwrap()).unwrap();
}
