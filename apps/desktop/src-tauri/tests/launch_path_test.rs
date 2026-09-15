//! Where a path the OS handed this process is allowed to point.
//!
//! `launch_channel_test.rs` owns the boundary: which channel may create a root,
//! and that a bus launch may not. This file is the other half of the same
//! question, and the two do not overlap — every test here would still be right
//! if the channels were one, because none of them is about who spoke. They are
//! about what the argument they spoke is evidence FOR.
//!
//! Two of them, and each is a place `resolve_launch` used the launch's evidence
//! for something it does not cover:
//!
//! - **A symlink is evidence about the LINK.** Anchoring the containment check
//!   on the canonicalized path answers about the link's TARGET instead, so a
//!   `notes/shared.md -> ~/.ssh/keys.md` inside the vault was judged to live in
//!   `~/.ssh` — and adopted that folder as the vault root, which every
//!   path-confined command then serves. The listing path already skips
//!   symlinks (`domain::vault::should_skip_entry`), so treating one as the door
//!   to a new vault was the app contradicting itself.
//! - **The refusal of a ROOT is not a refusal of a FILE.** `nekowite ~/todo.md`
//!   cannot adopt `$HOME`, and it must not — but the message the user got was
//!   about their home directory, and its advice ("choose a folder inside it")
//!   cannot open the note they named. The structural rule is unchanged; what
//!   changes is that its sentence is now written about the document.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use nekowite_lib::open_file::{resolve_launch, LaunchChannel};
use nekowite_lib::VaultRegistry;

use LaunchChannel::{CommandLine, SessionBus};

/// `HOME` is the structural rule's one input, and two tests below redirect it.
/// `cargo test` runs one binary's tests on threads of ONE process, so they hold
/// this for the whole of their body — two homes installed at once would decide
/// the answer for whichever test asked second.
static HOME_LOCK: Mutex<()> = Mutex::new(());

/// Run `body` with `HOME` pointing at `home`, restoring it afterwards. The
/// alternative is writing a stray `.md` into the real home directory of whoever
/// runs the suite, which is not something a test gets to do.
fn with_home<T>(home: &Path, body: impl FnOnce() -> T) -> T {
    let guard = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let previous = std::env::var_os("HOME");
    std::env::set_var("HOME", home);
    let out = body();
    match previous {
        Some(previous) => std::env::set_var("HOME", previous),
        None => std::env::remove_var("HOME"),
    }
    drop(guard);
    out
}

fn temp(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "nkw-launchpath-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

fn as_str(path: &Path) -> &str {
    path.to_str().unwrap()
}

fn note(dir: &Path, name: &str) -> PathBuf {
    let file = dir.join(name);
    fs::write(&file, "# note\n").unwrap();
    file.canonicalize().unwrap()
}

/// A session already in a vault the user picked in the folder dialog.
fn session_in(dir: &Path) -> VaultRegistry {
    let registry = VaultRegistry::default();
    registry.approve_pick(as_str(dir)).unwrap();
    registry.register(as_str(dir), None).unwrap();
    registry
}

// ---------------------------------------------------------------------------
// (a) A symlink is judged where it LIVES, not where it points
// ---------------------------------------------------------------------------

/// The defect, as an assertion. `notes/shared.md` is a symlink inside the open
/// vault pointing at a document in a folder that is none of the app's business.
///
/// Pre-fix this resolved to the TARGET's folder: `resolve_launch` canonicalized
/// the argument first, so the link collapsed to `…/secret/keys.md`, the
/// containment check asked about a file in `secret`, and `approve_launch_root`
/// put that folder into `chosen` — the set `register` reads as proof the user
/// picked it in the native dialog. Quoted from that run:
///
/// ```text
/// the link's own vault must be the root, not its target's folder:
///   left: "/tmp/nkw-launchpath-link-7-…/secret"
///  right: "/tmp/nkw-launchpath-link-7-…/vault"
///
/// a symlink inside the vault may not vouch for another folder: secret/ stayed
/// out
/// ```
///
/// The assertions below are the ones that produced those two failures.
#[test]
fn a_symlink_inside_the_vault_is_judged_there() {
    let vault = temp("link-vault");
    let secret = temp("link-secret");
    let target = note(&secret, "keys.md");
    let link = vault.join("shared.md");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let registry = session_in(&vault);

    let (path, root, same_vault) = resolve_launch(&registry, None, &link, CommandLine)
        .expect("a note inside the open vault is openable");

    assert_eq!(
        root,
        as_str(&vault),
        "the link's own vault is the root, not its target's folder"
    );
    assert!(
        same_vault,
        "the file belongs to the vault on screen: nothing about the vault changes"
    );
    assert_eq!(
        path,
        as_str(&vault.join("shared.md")),
        "the document the OS named is the link, at the path the user would see it"
    );
    assert!(
        registry.register(as_str(&secret), None).is_err(),
        "a symlink inside the vault may not vouch for another folder: {} stayed out",
        secret.display()
    );
    assert!(
        registry.authorize(as_str(&vault)).is_ok(),
        "and the vault the user is working in is still the one that is open"
    );

    let _ = fs::remove_dir_all(&vault);
    let _ = fs::remove_dir_all(&secret);
}

/// The same rule through the other channel: a second launch naming a symlink
/// inside the open vault opens it, and still may not create a root.
#[test]
fn a_bus_launch_for_a_symlink_inside_the_vault_opens_it() {
    let vault = temp("link-bus-vault");
    let secret = temp("link-bus-secret");
    let target = note(&secret, "keys.md");
    let link = vault.join("shared.md");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let registry = session_in(&vault);

    let (_, root, same_vault) = resolve_launch(&registry, None, &link, SessionBus)
        .expect("the link is inside a root the user already authorised");

    assert_eq!(root, as_str(&vault));
    assert!(same_vault);
    assert!(
        registry.register(as_str(&secret), None).is_err(),
        "the bus half of the same rule: no root is ever created from a link"
    );

    let _ = fs::remove_dir_all(&vault);
    let _ = fs::remove_dir_all(&secret);
}

/// The half that must not be lost: a symlink whose target is inside the vault
/// is an ordinary note, and opens as one. It resolves to a path inside the root
/// either way, so the confinement policy is happy with it — this is the case
/// the fix must not turn into a refusal.
#[test]
fn a_symlink_to_a_note_inside_the_vault_opens_as_a_note() {
    let vault = temp("link-inside-vault");
    fs::create_dir_all(vault.join("archive")).unwrap();
    let target = note(&vault.join("archive"), "real.md");
    let link = vault.join("shared.md");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let registry = session_in(&vault);

    let (path, root, same_vault) =
        resolve_launch(&registry, None, &link, CommandLine).expect("a note in the vault");

    assert_eq!(path, as_str(&vault.join("shared.md")));
    assert_eq!(root, as_str(&vault));
    assert!(same_vault);

    let _ = fs::remove_dir_all(&vault);
}

/// A symlink outside every vault keeps the launch's power over its own folder:
/// the folder the LINK lives in is what the launch may adopt, never the one it
/// points at.
#[test]
fn a_symlink_outside_every_vault_adopts_its_own_folder() {
    let vault = temp("link-away-vault");
    let links = temp("link-away-links");
    let secret = temp("link-away-secret");
    let target = note(&secret, "keys.md");
    let link = links.join("shared.md");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let registry = session_in(&vault);

    let (_, root, same_vault) = resolve_launch(&registry, None, &link, CommandLine)
        .expect("the process's own argv names a file");

    assert_eq!(
        root,
        as_str(&links),
        "the folder the launch may adopt is the one the argument names"
    );
    assert!(!same_vault);
    assert!(
        registry.register(as_str(&secret), None).is_err(),
        "the target's folder is not what the user pointed at"
    );

    let _ = fs::remove_dir_all(&vault);
    let _ = fs::remove_dir_all(&links);
    let _ = fs::remove_dir_all(&secret);
}

// ---------------------------------------------------------------------------
// (d) The root is refused; the file is still the subject
// ---------------------------------------------------------------------------

/// The structural rule is not weakened: a note in the user's home directory
/// still cannot be served, because serving it would mean serving `$HOME`. What
/// changes is what the user is told — the refusal is about the FILE they named,
/// and the remedy it offers is one that reaches that file.
///
/// `HOME` is redirected to a temporary folder for this test — see [`with_home`].
#[test]
fn a_launch_for_a_file_in_the_home_directory_names_the_file() {
    let home = temp("home-dir");
    let file = note(&home, "todo.md");
    let registry = VaultRegistry::default();

    let err = with_home(&home, || resolve_launch(&registry, None, &file, CommandLine))
        .expect_err("$HOME cannot be a vault, so this file cannot be served");

    assert!(
        err.contains(as_str(&file)),
        "the refusal is about the document the user asked for, not only the \
         folder that cannot hold it: {err}"
    );
    assert!(
        err.contains("home directory"),
        "and it still says WHY the folder cannot be a vault: {err}"
    );
    assert!(
        err.contains("Move the note"),
        "the remedy must be one that reaches this file; 'choose another vault' \
         cannot open a note that is outside every vault: {err}"
    );
    assert!(
        registry.register(as_str(&home), None).is_err(),
        "the structural rule is unmoved: {} never became a vault",
        home.display()
    );

    let _ = fs::remove_dir_all(&home);
}

/// The rule has three clauses and the sentence must be launch-shaped for each
/// of them. This is the second kind the suite can reach: a folder that CONTAINS
/// home is refused too, so a note one level above the user's home directory is
/// refused for a different reason — and the same complaint applies. The remedy
/// still has to be one that reaches the file.
///
/// The third kind, the filesystem root, has no test here: reaching it means
/// putting a real `.md` in `/`, which the suite cannot do. It is the same code
/// path — `vault_root_structural_refusal` returns its clause and
/// `unservable_launch_file` writes the sentence — and the clause is covered by
/// `vault_auth_test.rs` at the rule.
#[test]
fn a_launch_one_level_above_home_names_the_file_too() {
    let base = temp("above-home");
    let home = base.join("home");
    fs::create_dir_all(&home).unwrap();
    let home = home.canonicalize().unwrap();
    let file = note(&base, "todo.md");
    let registry = VaultRegistry::default();

    let err = with_home(&home, || resolve_launch(&registry, None, &file, CommandLine))
        .expect_err("a folder containing home cannot be a vault");

    assert!(
        err.contains(as_str(&file)),
        "the refusal names the file the launch asked for: {err}"
    );
    assert!(
        err.contains("contains your home directory"),
        "and the reason, unchanged from the rule's own words: {err}"
    );
    assert!(
        err.contains("Move the note"),
        "the remedy reaches the document rather than pointing at another folder: {err}"
    );

    let _ = fs::remove_dir_all(&base);
}
