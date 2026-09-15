//! Which channel a launch arrived on, and what each channel may do.
//!
//! A launch names a file, and `open_file` decides which vault that file belongs
//! to. Until this file existed, both ways a launch can arrive were treated as
//! the same evidence, and they are not:
//!
//! - **The first launch** reads `std::env::args_os()` — this process's own
//!   command line, which only whatever started this process could have set. That
//!   is OS evidence, the standing a folder-dialog pick has, so a file outside
//!   every vault may adopt its folder as one.
//! - **The second launch** arrives through `tauri-plugin-single-instance`'s
//!   callback, which serves `ExecuteCallback(argv, cwd)` at the session bus with
//!   no peer-credential check. Those arguments are an assertion by whoever
//!   called the method, so a path from outside every vault is refused there.
//!
//! Each test below names the channel it speaks on, because that is now the only
//! thing separating "open my note" from "make this folder a vault".

use std::fs;
use std::path::{Path, PathBuf};

use nekowite_lib::open_file::{resolve_launch, LaunchChannel};
use nekowite_lib::VaultRegistry;

/// The variants are imported so every call site below says which channel it
/// speaks on without the module path in the way: `CommandLine` and `SessionBus`
/// are the whole subject of this file.
use LaunchChannel::{CommandLine, SessionBus};

fn temp(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "nkw-launch-{label}-{}-{}",
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
// The bus: a second launch may open inside a root, never create one
// ---------------------------------------------------------------------------

/// [A] The defect. A second launch names a file outside every vault, and the
/// path arrived over a session-bus method any process of this user can call.
///
/// This test was run against the pre-fix source first, mentioning no channel
/// because there was none to mention: `handle_launch` resolved such a file by
/// calling `approve_launch_root` on its parent, which puts the folder into
/// `chosen` — the set `register` treats as proof the user picked it in the
/// native dialog. Quoted from that run, in the order the assertions failed:
///
/// ```text
/// a folder a bus peer named must not be in `chosen`, which is what `register`
/// accepts as a dialog pick: /tmp/nkw-launch-bus-outside-3535832-… became a
/// vault root
///
/// the vault the user was working in must still be open: it was replaced by
/// /tmp/nkw-launch-bus-outside-3536504-… — a directory nobody chose, that a
/// session-bus caller named
/// ```
///
/// The assertions that produced those two failures are the ones below: the same
/// folder, through the same call, now on the bus channel.
#[test]
fn a_bus_launch_for_a_file_outside_every_root_is_refused() {
    let vault = temp("bus-open-vault");
    let outside = temp("bus-outside");
    let file = note(&outside, "note.md");
    let registry = session_in(&vault);

    let err = resolve_launch(&registry, None, &file, SessionBus)
        .expect_err("a bus peer's folder is not evidence that a person chose it");

    assert!(
        err.contains("not inside a vault"),
        "the refusal must say what is wrong with the path: {err}"
    );
    assert!(
        err.contains("Open folder"),
        "the refusal must say what the user can do instead, and the folder \
         dialog is the one way to make this folder a vault: {err}"
    );
    assert!(
        err.contains(as_str(&outside)),
        "it must name the folder that would have to be opened: {err}"
    );

    // The pre-fix failures, as assertions that now hold.
    assert!(
        registry.register(as_str(&outside), None).is_err(),
        "the folder must not be in `chosen`, which is what `register` accepts \
         as a dialog pick: {} stayed out",
        outside.display()
    );
    assert!(
        registry.authorize(as_str(&vault)).is_ok(),
        "and the vault the user was working in is still the one that is open"
    );
    assert!(
        registry.containing_opened_vault(&file).is_none(),
        "a refused request must not leave the file inside a served root"
    );

    let _ = fs::remove_dir_all(&vault);
    let _ = fs::remove_dir_all(&outside);
}

/// The half of the feature that is legitimate: a `.md` double-clicked while the
/// app is running, inside the vault the user already has open.
#[test]
fn a_bus_launch_for_a_file_inside_the_open_vault_still_opens_it() {
    let vault = temp("bus-current-vault");
    let file = note(&vault, "note.md");
    let registry = session_in(&vault);

    let (path, root, same_vault) =
        resolve_launch(&registry, None, &file, SessionBus).expect("a file in the open vault");

    assert_eq!(path, as_str(&file));
    assert_eq!(root, as_str(&vault));
    assert!(
        same_vault,
        "the file belongs to the vault already on screen: nothing about the \
         vault changes, so the tab opens where the user is"
    );

    let _ = fs::remove_dir_all(&vault);
}

/// The other legitimate half: the window is still starting, so nothing is open
/// yet, and the file sits in the vault startup is about to restore.
#[test]
fn a_bus_launch_for_a_file_inside_the_remembered_vault_still_opens_it() {
    let vault = temp("bus-remembered-vault");
    let file = note(&vault, "note.md");
    let registry = VaultRegistry::default();

    let (path, root, same_vault) = resolve_launch(&registry, Some(&vault), &file, SessionBus)
        .expect("a file in the vault this session restores");

    assert_eq!(path, as_str(&file));
    assert_eq!(root, as_str(&vault));
    assert!(
        same_vault,
        "the root the session restores is not a switch, so the tab opens into it"
    );

    let _ = fs::remove_dir_all(&vault);
}

/// The bus may not reach `approve_launch_root` even indirectly: a file that
/// does not exist is refused for its own reason, and one that is not a file at
/// all is refused before any vault question is asked.
#[test]
fn a_bus_launch_that_cannot_be_opened_creates_no_root() {
    let vault = temp("bus-unopenable");
    let outside = temp("bus-unopenable-outside");
    let registry = session_in(&vault);

    for file in [outside.join("missing.md"), outside.clone()] {
        let err = resolve_launch(&registry, None, &file, SessionBus).unwrap_err();
        assert!(!err.is_empty(), "a refusal that says nothing is not a refusal");
    }

    assert!(
        registry.register(as_str(&outside), None).is_err(),
        "neither refusal may leave the folder vouched for: {}",
        outside.display()
    );
    assert!(registry.authorize(as_str(&vault)).is_ok());

    let _ = fs::remove_dir_all(&vault);
    let _ = fs::remove_dir_all(&outside);
}

// ---------------------------------------------------------------------------
// The command line: the first launch keeps the power it always had
// ---------------------------------------------------------------------------

/// [`a_bus_launch_for_a_file_outside_every_root_is_refused`]'s inputs, through
/// the other channel — and this is the pre-fix behaviour, still reachable, now
/// only from the process's own command line. `std::env::args_os()` is a fact no
/// renderer and no bus peer can manufacture, so the folder is adopted.
#[test]
fn a_first_launch_still_adopts_an_outside_files_folder() {
    let vault = temp("cli-open-vault");
    let outside = temp("cli-outside");
    let file = note(&outside, "note.md");
    let registry = session_in(&vault);

    let (path, root, same_vault) =
        resolve_launch(&registry, None, &file, CommandLine).expect("the process's own argv");

    assert_eq!(path, as_str(&file));
    assert_eq!(
        root,
        as_str(&outside),
        "the file's own folder becomes the vault, so the document opens in the \
         folder it lives in rather than nowhere"
    );
    assert!(!same_vault, "this vault is not the one that was on screen");
    assert!(
        registry.register(as_str(&outside), None).is_ok(),
        "the adopted folder must be one the switch commits: `approve_launch_root` \
         records it in `chosen`, the same set a dialog pick goes in"
    );
    assert!(
        registry.authorize(as_str(&vault)).is_err(),
        "and committing it replaces the vault that was open, as a switch does"
    );

    let _ = fs::remove_dir_all(&vault);
    let _ = fs::remove_dir_all(&outside);
}

/// The first launch's other job, unchanged: a file already inside a vault the
/// session knows opens there instead of adopting anything.
#[test]
fn a_first_launch_for_a_file_inside_a_known_vault_opens_it() {
    let vault = temp("cli-known-vault");
    let file = note(&vault, "note.md");
    let registry = session_in(&vault);

    let (_, root, same_vault) =
        resolve_launch(&registry, None, &file, CommandLine).expect("a file in the open vault");

    assert_eq!(root, as_str(&vault));
    assert!(same_vault);

    let _ = fs::remove_dir_all(&vault);
}

/// A launch at a folder that has a vault's shape but is not a note is refused
/// with a reason either way, rather than adopting something unusable.
#[test]
fn a_launch_for_something_that_is_not_a_file_is_refused_with_a_reason() {
    let vault = temp("cli-not-a-file");
    let registry = session_in(&vault);

    let err = resolve_launch(&registry, None, &vault, CommandLine).unwrap_err();
    assert!(
        err.contains("is not a file"),
        "a folder named where a note was expected is refused, not opened: {err}"
    );

    let _ = fs::remove_dir_all(&vault);
}
