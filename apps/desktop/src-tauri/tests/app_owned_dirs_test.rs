//! The app's own directories are not vault content, whatever vault is open.
//!
//! The configuration directory holds `last-vault`, the record `register` reads
//! as proof the user chose a vault root; the data directory holds the master
//! key and the stronghold snapshot. A vault can CONTAIN them — the folder
//! dialog returns `~/.config` as readily as a notes directory — and every
//! path-confined command serves whatever lies inside the vault it was given, so
//! this file is about the one route from the window to the app's own state.
//!
//! The rule itself lives in `domain::app_owned` and is applied in
//! `resolve_within_rel`, which is why the cases below are written against the
//! storage functions rather than against the commands: the commands are
//! one-line delegators, and the function under test is the one every one of
//! them ends in.

use nekowite_lib::domain::app_owned::{install, AppDir};
use nekowite_lib::state::{read_remembered_vault, write_remembered_vault};
use nekowite_lib::storage::{file_store, trash_store};
use nekowite_lib::VaultRegistry;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// `install` is process-wide, and `cargo test` runs this file's tests on
/// threads of ONE process: two tests installing over each other would fail only
/// sometimes. Every test that needs a set holds this for its whole body.
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

/// A tree shaped like the real one: the folder the user opens (`config`, the
/// stand-in for `~/.config`) CONTAINS the app's configuration directory, and
/// the app's data directory sits in a sibling folder the user may also open.
struct Tree {
    base: PathBuf,
    vault: PathBuf,
    config_dir: PathBuf,
    data_dir: PathBuf,
}

fn tree(label: &str) -> Tree {
    let base = std::env::temp_dir().join(format!("nkw-appowned-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let vault = base.join("config");
    let config_dir = vault.join("dev.nekowite.app");
    let data_dir = base.join("data").join("dev.nekowite.app");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::create_dir_all(data_dir.join(".nekowite")).unwrap();
    Tree {
        base,
        vault,
        config_dir,
        data_dir,
    }
}

fn as_str(path: &Path) -> &str {
    path.to_str().unwrap()
}

/// Install the app's directories for the duration of `body`. The lock is held
/// for the whole body, not just the install: another test's install landing
/// mid-body would otherwise decide the answer for this one.
fn with_app_dirs<T>(config_dir: &Path, data_dir: &Path, body: impl FnOnce() -> T) -> T {
    let guard = INSTALL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    install(vec![
        (AppDir::Configuration, config_dir.to_path_buf()),
        (AppDir::Data, data_dir.to_path_buf()),
    ]);
    let out = body();
    drop(guard);
    out
}

fn refused(what: &str, result: Result<impl std::fmt::Debug, String>) {
    let Err(err) = result else {
        panic!("{what} was served: the app's own directory is not vault content");
    };
    assert!(
        err.contains("own configuration directory") || err.contains("own data directory"),
        "{what}: expected the app-owned refusal, got: {err}"
    );
}

/// The user's vault, opened the way the app opens one.
fn opened(reg: &VaultRegistry, vault: &Path) -> PathBuf {
    reg.approve_pick(as_str(vault)).unwrap();
    reg.register(as_str(vault), None).unwrap()
}

// ---------------------------------------------------------------------------
// The forgery
// ---------------------------------------------------------------------------

/// The forgery of finding 1, refused.
///
/// The user opens a vault that contains the app's configuration directory. The
/// window then writes the remembered-vault record — an ordinary file of an
/// ordinary vault, through `write_file`, with every gate the command has
/// passing: the root is open, the path is inside it, the file is a plain
/// `0644`. Pre-fix this landed, and the rest of the chain followed:
///
/// ```text
/// 1. register_vault("/tmp/nkw-probe-3460634/config") -> ok
/// 2. write_file(dev.nekowite.app/last-vault, "/tmp/nkw-probe-3460634/elsewhere") -> Ok(None)
///    record now = Some("/tmp/nkw-probe-3460634/elsewhere")
/// 3. register("/tmp/nkw-probe-3460634/elsewhere", remembered) -> Ok("/tmp/nkw-probe-3460634/elsewhere")
/// 4. list_dir("/tmp/nkw-probe-3460634/elsewhere") -> Ok(["secret.md"])
///    read_file(secret.md) -> Ok("# not yours\n")
/// ```
///
/// The record named a directory the user never chose, `register` accepted it on
/// the record's authority, and the confinement model was gone for the session
/// and for the next launch.
#[test]
fn the_remembered_vault_record_cannot_be_forged_from_inside_the_vault() {
    let t = tree("forge");
    with_app_dirs(&t.config_dir, &t.data_dir, || {
        let record = t.config_dir.join("last-vault");
        let elsewhere = t.base.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("secret.md"), "# not yours\n").unwrap();
        let forged_root = elsewhere.canonicalize().unwrap();

        // What `register_vault` does on success, in the folder it does it in.
        let reg = VaultRegistry::default();
        let opened_root = opened(&reg, &t.vault);
        write_remembered_vault(&record, &opened_root).unwrap();

        let refusal = file_store::write_file(
            as_str(&t.vault),
            "dev.nekowite.app/last-vault",
            &format!("{}\n", forged_root.display()),
            None,
        )
        .expect_err("the forge is a write to a file the app owns, and it must be refused");
        assert!(
            refusal.contains("own configuration directory"),
            "the refusal must name the directory it protects, got: {refusal}"
        );
        assert_eq!(
            read_remembered_vault(&record).as_deref(),
            Some(opened_root.as_path()),
            "the record still names the vault the user opened"
        );

        // Nothing left for `register_vault` to accept on the record's authority:
        // the root the window pointed at is still unvouched for, and the vault
        // the user is working in stays open.
        let remembered = read_remembered_vault(&record);
        assert!(
            reg.register(as_str(&forged_root), remembered.as_deref())
                .is_err(),
            "a forged root must not be registered"
        );
        assert!(reg.authorize(as_str(&forged_root)).is_err());
        assert!(reg.authorize(as_str(&t.vault)).is_ok());

        // The vault itself is still the user's: one folder inside it is the
        // app's. (The other shape of this fix — refusing the root at `register`
        // — would have cost them the vault choice altogether.)
        assert!(file_store::write_file(as_str(&t.vault), "note.md", "# mine\n", None).is_ok());
        assert_eq!(file_store::read_file(as_str(&t.vault), "note.md").unwrap(), "# mine\n");

        let _ = std::fs::remove_dir_all(&t.base);
    });
}

/// Every route to the same file, refused — which is really a test that the rule
/// sits in the one function all of them end in. `save_attachment`'s own name
/// rules already stop the record's exact name (it demands `stem.ext`), and the
/// case is here anyway: the rule does not consult the name, and the DIRECTORY
/// the window hands it is the argument that matters.
#[test]
fn every_route_to_the_app_directory_is_refused() {
    let t = tree("routes");
    with_app_dirs(&t.config_dir, &t.data_dir, || {
        let reg = VaultRegistry::default();
        opened(&reg, &t.vault);
        let vault = as_str(&t.vault);
        std::fs::write(t.vault.join("evil.md"), "# mine\n").unwrap();
        let picture = t.base.join("pic.png");
        std::fs::write(&picture, b"not really a png").unwrap();

        refused(
            "write_file",
            file_store::write_file(vault, "dev.nekowite.app/last-vault", "/tmp/elsewhere", None),
        );
        refused(
            "create_new_file",
            file_store::create_new_file(vault, "dev.nekowite.app/last-vault", "/tmp/elsewhere"),
        );
        refused(
            "read_file",
            file_store::read_file(vault, "dev.nekowite.app/last-vault"),
        );
        refused(
            "stat_file",
            file_store::stat_file(vault, "dev.nekowite.app/last-vault"),
        );
        refused(
            "list_dir",
            file_store::list_dir(vault, Some("dev.nekowite.app")),
        );
        refused(
            "create_dir",
            file_store::create_dir(vault, "dev.nekowite.app"),
        );
        refused(
            "rename_entry (destination)",
            file_store::rename_entry(vault, "evil.md", "dev.nekowite.app/last-vault"),
        );
        refused(
            "save_attachment (directory)",
            file_store::save_attachment(vault, "note.png", "aGk=", "dev.nekowite.app"),
        );
        refused(
            "import_attachment (directory)",
            file_store::import_attachment(vault, as_str(&picture), "dev.nekowite.app"),
        );
        refused(
            "resolve_media_path",
            file_store::resolve_media_path(vault, "dev.nekowite.app/pic.png"),
        );
        refused(
            "delete_file",
            trash_store::delete_file(vault, "dev.nekowite.app/last-vault"),
        );
        assert!(
            !t.config_dir.join("last-vault").exists(),
            "no route may have created the record"
        );

        let _ = std::fs::remove_dir_all(&t.base);
    });
}

// ---------------------------------------------------------------------------
// The other directory, and the vaults that are not involved
// ---------------------------------------------------------------------------

/// The data directory, the same rule: the master key and the stronghold
/// snapshot are not vault files either. Overwriting them is destructive rather
/// than escalating — the vault stops opening and the stored provider keys
/// become unreachable — but it is one path policy, so it is one refusal.
#[test]
fn the_data_directory_is_refused_too() {
    let t = tree("data");
    with_app_dirs(&t.config_dir, &t.data_dir, || {
        let key = "dev.nekowite.app/.nekowite/master.key";
        let snapshot = "dev.nekowite.app/.nekowite/stronghold.bin";
        let key_file = t.data_dir.join(".nekowite/master.key");
        std::fs::write(&key_file, b"the real key material").unwrap();

        // The user's vault here is the folder that holds the app's data
        // directory, which is what puts the key files inside a served tree.
        let vault = t.base.join("data");
        let reg = VaultRegistry::default();
        opened(&reg, &vault);

        refused(
            "write_file(master.key)",
            file_store::write_file(as_str(&vault), key, "the attacker's key", None),
        );
        refused(
            "read_file(stronghold.bin)",
            file_store::read_file(as_str(&vault), snapshot),
        );
        assert_eq!(
            std::fs::read(&key_file).unwrap(),
            b"the real key material",
            "the key file still holds what the app wrote"
        );

        let _ = std::fs::remove_dir_all(&t.base);
    });
}

/// An ordinary vault is unaffected in every way: nothing the user asked for is
/// refused, and the mechanism the rule protects — a dialog pick, the record,
/// the restore from it — still works end to end.
#[test]
fn an_ordinary_vault_is_unaffected() {
    let t = tree("ordinary");
    with_app_dirs(&t.config_dir, &t.data_dir, || {
        let vault_path = t.base.join("notes");
        std::fs::create_dir_all(&vault_path).unwrap();
        let vault = as_str(&vault_path).to_string();
        let record = t.config_dir.join("last-vault");

        let reg = VaultRegistry::default();
        let opened_root = opened(&reg, &vault_path);
        write_remembered_vault(&record, &opened_root).unwrap();

        // The whole vault surface, in one pass.
        assert!(file_store::write_file(&vault, "note.md", "# hello\n", Some(5)).is_ok());
        assert_eq!(
            file_store::read_file(&vault, "note.md").unwrap(),
            "# hello\n"
        );
        assert_eq!(file_store::stat_file(&vault, "note.md").unwrap().size, 8);
        assert!(file_store::create_new_file(&vault, "second.md", "# two\n").is_ok());
        assert!(file_store::create_dir(&vault, "docs").is_ok());
        assert!(file_store::rename_entry(&vault, "second.md", "docs/second.md").is_ok());
        assert!(file_store::save_attachment(&vault, "note.png", "aGk=", "attachments").is_ok());
        let mut names: Vec<String> = file_store::list_dir(&vault, None)
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        names.sort();
        assert_eq!(names, ["attachments", "docs", "note.md"]);
        assert!(trash_store::delete_file(&vault, "note.md").is_ok());
        assert_eq!(trash_store::list_trash(&vault).unwrap().len(), 1);

        // The restore path: the record the backend wrote is still the proof a
        // fresh session needs, with the rule installed.
        let fresh = VaultRegistry::default();
        let remembered = read_remembered_vault(&record);
        assert_eq!(
            fresh.register(&vault, remembered.as_deref()).unwrap(),
            opened_root
        );
        assert!(fresh.authorize(&vault).is_ok());

        let _ = std::fs::remove_dir_all(&t.base);
    });
}

/// The rule refuses nothing until the set is installed, and only the app handle
/// knows where the platform put those directories — so the install is a line in
/// `run()`'s setup pass that no test in this file can execute. This is that
/// line's guard: without it, deleting the wiring would put finding 1 back and
/// every other test here would still pass, because `install` is what the tests
/// above call themselves.
///
/// The two folders must come from the modules that write those files, not from
/// a fresh call to `app_config_dir()` here: `remembered_vault_dir` is the answer
/// the record's own path is built from, so a later move of the record cannot
/// leave the rule refusing a folder nothing is written in.
#[test]
fn the_startup_install_is_wired() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let lib = std::fs::read_to_string(manifest.join("src/lib.rs")).unwrap();
    assert!(
        lib.contains("app_owned::install("),
        "run()'s setup no longer installs the app's own directories: nothing is refused"
    );
    for owner in [
        "remembered_vault_dir(",
        "key_store::data_dir(",
        "AppDir::Configuration",
        "AppDir::Data",
    ] {
        assert!(
            lib.contains(owner),
            "{owner} is no longer among the installed directories"
        );
    }
}
