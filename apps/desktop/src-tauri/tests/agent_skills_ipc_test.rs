//! The skills page's IPC surface: four commands, over a real profile.
//!
//! `agent_skills_test.rs` and `agent_skills_scope_test.rs` own the rules (`skills.rs`: discovery,
//! the import, the switch). This file owns the wire between them and the settings page, and the
//! decisions a *request* is not allowed to make — the same split `agent_registry_ipc_test.rs` makes
//! for the registry.
//!
//! Four properties are what the cases below are grouped by:
//!
//! 1. **The scope list is the profile's, not a window's.** The roots come off the profile the
//!    backend opened, and the engine's switches come off the very environment the launch is given
//!    (`isolated_profile_env`) — so the first test asserts what an app-managed profile's readout
//!    says about `.claude` (configured, and not read, because the launch sets
//!    `OPENCODE_DISABLE_EXTERNAL_SKILLS`) and that the project scope is not in the list at all.
//! 2. **A refusal and a rejection are two channels.** A refusal is a value from a call that
//!    completed — the kind plus the facts the page's sentence interpolates — and an `Err` is a call
//!    that did not run: a profile that cannot be opened for this pair. Both are asserted, because
//!    telling them apart is the difference between "this skill cannot be used" and "this page could
//!    not reach the backend".
//! 3. **A window names a skill, never a directory.** The three actions are driven by (scope, name),
//!    and a name that is no longer on disk is refused rather than resolved against a path the
//!    renderer sent.
//! 4. **A replacement is recoverable, and a refusal moves nothing.** §8.2's two hard clauses, read
//!    at the boundary: an import over a taken name is refused *and* leaves the directory alone, the
//!    confirmed one keeps the copy it displaced in this host's store, and a scope this host may not
//!    write in is refused with the engine's own variable named while its directory stays as it was.
//!
//! Scratch directories live under this crate's `target/`, which is inside the repository and
//! git-ignored. The one test that drives a profile reusing the user's installation redirects `HOME`
//! (`with_home`, the pattern `launch_path_test.rs` uses) so that the machine's real `~/.claude` is
//! never what a test reads.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;

use nekowite_lib::agent_runtime::profile::{ConfigMode, ProfileFields, ProfileStore};
use nekowite_lib::agent_runtime::skills::{
    DISABLE_CLAUDE_CODE_SKILLS, DISABLE_EXTERNAL_SKILLS, SKILL_FILE_NAME,
};
use nekowite_lib::commands::agent_skills::{
    import_skill, preview_skill, read_skills, set_skill_enabled,
};

const AGENT: &str = "bundled-engine";
const PROFILE: &str = "default";

/// `HOME` is an input to a profile that reuses the user's installation, and two tests here
/// redirect it. `cargo test` runs one binary's tests on threads of ONE process, so they hold this
/// for the whole of their body.
static HOME_LOCK: Mutex<()> = Mutex::new(());

/// Run `body` with `HOME` pointing at `home`, restoring it afterwards. The alternative is reading
/// whoever runs the suite out of their own `.claude` directory.
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

/// A scratch tree inside the repository. Removed on entry, so a previous run's leftovers cannot be
/// what a test passes on.
fn scratch(label: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/agent-skills-ipc-test")
        .join(format!("{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch directory");
    dir
}

/// A store over a scratch data directory, and the profile's root — opened, so the record exists and
/// the pair is bound.
fn profile_of(label: &str) -> (ProfileStore, PathBuf) {
    let managed = scratch(label);
    let store = ProfileStore::new(&managed);
    let root = store.root_of(PROFILE).expect("a profile id");
    // The mode a fresh profile starts in is `app-managed` (`ProfileFields::initial`), which is the
    // one this file's first three tests are about.
    store.open(AGENT, PROFILE).expect("the profile opens");
    (store, root)
}

/// A skill directory the way an author writes one: a folder, and a `SKILL.md` naming it.
fn write_skill(root: &Path, folder: &str, name: &str, description: Option<&str>) -> PathBuf {
    let directory = root.join(folder);
    let described = match description {
        Some(description) => format!("description: {description}\n"),
        None => String::new(),
    };
    write_file(
        &directory.join(SKILL_FILE_NAME),
        &format!("---\nname: {name}\n{described}---\n\n# {name}\n\nBody.\n"),
    );
    directory
}

fn write_file(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("parent directory");
    }
    fs::write(path, contents).expect("write file");
}

/// The readout, as the page reads it.
fn read(store: &ProfileStore) -> Value {
    read_skills(store, AGENT, PROFILE).expect("the readout is an answer")
}

fn rows<'a>(readout: &'a Value, key: &str) -> &'a [Value] {
    readout[key].as_array().expect("a list").as_slice()
}

fn row_named<'a>(readout: &'a Value, key: &str, name: &str) -> &'a Value {
    rows(readout, key)
        .iter()
        .find(|row| row["name"] == name)
        .unwrap_or_else(|| panic!("no row named {name} in {key}"))
}

fn scope_ids(readout: &Value) -> Vec<&str> {
    rows(readout, "scopes")
        .iter()
        .map(|scope| scope["id"].as_str().expect("a scope id"))
        .collect()
}

// ---------------------------------------------------------------------------
// The scope list is the profile's
// ---------------------------------------------------------------------------

/// What an app-managed profile's page reads, and the two facts a readout gets wrong by omission.
///
/// The launch sets `OPENCODE_DISABLE_EXTERNAL_SKILLS`, so `.claude` and `.agents` are *configured*
/// and contribute nothing — both have to be said, which is why the row carries the scope's state
/// (`suppressedBy`) beside the skill's own surface. And the project's own `.opencode/skills` is not
/// in the list at all: this dialog is not about a folder, so there is no project to build that
/// scope from (`opencode_scopes_without_project`), and the page states it in words.
#[test]
fn the_readout_is_the_profiles_own_directories_and_not_a_projects() {
    let (store, root) = profile_of("readout");
    write_skill(
        &root.join("XDG_CONFIG_HOME/skills"),
        "planted",
        "planted",
        Some("a skill this app owns"),
    );
    write_skill(
        &root.join("HOME/.claude/skills"),
        "private",
        "private",
        Some("mine"),
    );
    write_skill(
        &root.join("HOME/.agents/skills"),
        "agents-one",
        "agents-one",
        Some("another tool's"),
    );

    let readout = read(&store);
    assert_eq!(
        scope_ids(&readout),
        vec!["engine-global", "claude-code", "agents-directory"],
        "three directories, and no project"
    );
    assert_eq!(
        readout["importScope"], "engine-global",
        "the one directory this host may write in"
    );

    // The app's own profile: managed, so a per-skill switch exists and the engine reads it.
    let planted = row_named(&readout, "skills", "planted");
    assert_eq!(planted["scope"], "engine-global");
    assert_eq!(planted["owner"], "managed");
    assert_eq!(planted["surface"]["kind"], "offered");
    assert_eq!(planted["disable"]["kind"], "per-skill");
    assert_eq!(planted["suppressedBy"], Value::Null);
    assert_eq!(
        planted["directory"],
        root.join("XDG_CONFIG_HOME/skills/planted")
            .to_string_lossy()
            .as_ref()
    );

    // Another tool's directory, which this launch stopped the engine reading: the row is still
    // there, it says who owns it, and it names the switch that is set — never one that is not.
    let private = row_named(&readout, "skills", "private");
    assert_eq!(private["scope"], "claude-code");
    assert_eq!(private["owner"], "foreign");
    assert_eq!(private["surface"]["kind"], "suppressed");
    assert_eq!(private["surface"]["variable"], DISABLE_EXTERNAL_SKILLS);
    assert_eq!(private["suppressedBy"], DISABLE_EXTERNAL_SKILLS);
    assert_eq!(private["disable"]["kind"], "engine-switch");
    assert_eq!(private["disable"]["variable"], DISABLE_CLAUDE_CODE_SKILLS);

    // And the scope's own sentence, which the page draws in place of a control: a directory the
    // engine's rules name is listed whether or not this launch reads it.
    let scopes = rows(&readout, "scopes");
    let claude = scopes
        .iter()
        .find(|scope| scope["id"] == "claude-code")
        .expect("the .claude scope");
    assert_eq!(claude["suppressedBy"], DISABLE_EXTERNAL_SKILLS);
    assert_eq!(
        claude["root"],
        root.join("HOME/.claude/skills").to_string_lossy().as_ref()
    );
}

/// A profile that reuses the user's installation: no directory this host may write in, so no import
/// and nothing switched off by this app.
///
/// `importScope: null` is the fact the page needs to state the reason instead of drawing a form
/// (§5.2), and the *absence* of a switch is the other half: with nothing injected, `.claude` is a
/// directory this engine is reading, which is what `suppressedBy: null` says.
#[test]
fn a_profile_that_reuses_the_users_installation_has_nothing_to_import_into() {
    let managed = scratch("reused");
    let store = ProfileStore::new(&managed);
    let root = store.root_of(PROFILE).expect("a profile id");
    let opened = store.open(AGENT, PROFILE).expect("the profile opens");
    let revision = opened.revision().clone();
    opened
        .set_fields(
            &revision,
            ProfileFields {
                mode: ConfigMode::UserConfig,
                provider: None,
                model_id: None,
            },
        )
        .expect("the mode switch is written");

    let home = managed.join("machine-home");
    write_skill(&home.join(".claude/skills"), "mine", "mine", Some("mine"));

    let readout = with_home(&home, || read(&store));
    assert_eq!(scope_ids(&readout), vec!["claude-code", "agents-directory"]);
    assert_eq!(
        readout["importScope"],
        Value::Null,
        "this host owns no directory in that engine's scope list"
    );
    let mine = row_named(&readout, "skills", "mine");
    assert_eq!(mine["surface"]["kind"], "offered");
    assert_eq!(
        mine["suppressedBy"],
        Value::Null,
        "this host injects nothing into that launch, so no switch of the engine's is set by it"
    );

    // The action is refused rather than answered with a directory that was never this app's — and
    // the source is asserted to be exactly where it was.
    let authored = managed.join("authored");
    let source = write_skill(&authored, "incoming", "incoming", Some("one"));
    let refusal = with_home(&home, || {
        import_skill(&store, AGENT, PROFILE, source.to_str().unwrap(), false)
            .expect("a refusal is an answer")
    });
    assert_eq!(refusal["kind"], "not-managed");
    assert!(
        source.join(SKILL_FILE_NAME).is_file(),
        "a refusal leaves the folder it was handed where it was"
    );
    assert!(
        !home.join(".claude/skills/incoming").exists(),
        "and copies nothing into a directory this host does not own"
    );
    assert!(
        !root.join("skills-store").exists(),
        "no store was made either: there was nothing this host could have kept"
    );
}

/// A pair that is not this profile's: the call did not run at all, which is the channel the page
/// answers with its unreadable state rather than with a sentence about a skill.
#[test]
fn another_engines_pair_is_a_rejection_and_not_a_refusal() {
    let (store, _) = profile_of("pair");
    let error = read_skills(&store, "another-engine", PROFILE)
        .expect_err("a profile bound to one engine is not opened as another's");
    assert!(
        error.contains("another-engine"),
        "the sentence names the engine it was asked for: {error}"
    );
}

// ---------------------------------------------------------------------------
// The switch is a move
// ---------------------------------------------------------------------------

/// §8.2's 「禁用真实生效」 at the boundary: the skill leaves the directory the engine reads, it is
/// kept in this host's store, the readout moves it to the second list, and switching it back on
/// puts it where it was.
///
/// The store's own placement is asserted too, because that placement is what makes the property
/// structural: `SkillLibrary::new` refuses a store inside any scope root, so a "switched off" skill
/// that the next scan would still find cannot be built at all.
#[test]
fn switching_a_skill_off_moves_it_out_of_every_directory_the_engine_reads() {
    let (store, root) = profile_of("switch");
    let directory = write_skill(
        &root.join("XDG_CONFIG_HOME/skills"),
        "planted",
        "planted",
        Some("a skill"),
    );

    let accepted = set_skill_enabled(&store, AGENT, PROFILE, "planted", "engine-global", false)
        .expect("an answer");
    assert_eq!(accepted, Value::Null, "`null` is the accepted arm");

    let readout = read(&store);
    assert!(
        rows(&readout, "skills").is_empty(),
        "the engine's next scan does not find it"
    );
    let off = row_named(&readout, "disabled", "planted");
    assert_eq!(off["scope"], "engine-global");
    assert_eq!(off["surface"]["kind"], "disabled");
    let stored = off["directory"].as_str().expect("a directory");
    assert!(
        !directory.exists(),
        "the directory the engine read is gone: {stored}"
    );

    // Nowhere the engine looks: not inside any scope root the readout named, and not the root
    // themselves.
    for scope in rows(&readout, "scopes") {
        let scope_root = PathBuf::from(scope["root"].as_str().expect("a root"));
        assert!(
            !Path::new(stored).starts_with(&scope_root),
            "{stored} is inside {}",
            scope_root.display()
        );
    }

    // And back: the same (scope, name) pair, with the directory re-read rather than remembered.
    set_skill_enabled(&store, AGENT, PROFILE, "planted", "engine-global", true).expect("an answer");
    let readout = read(&store);
    assert_eq!(
        row_named(&readout, "skills", "planted")["surface"]["kind"],
        "offered"
    );
    assert!(rows(&readout, "disabled").is_empty());
    assert!(directory.join(SKILL_FILE_NAME).is_file());
}

/// A row that was read before something moved the skill: refused, and nothing moved.
///
/// This is the reason the actions take a (scope, name) pair and re-read — a request may not name
/// the directory, and a name that is gone must not be resolved against a path this host guessed at.
#[test]
fn a_skill_that_is_gone_is_refused_rather_than_resolved_from_the_row() {
    let (store, root) = profile_of("stale");
    let directory = write_skill(
        &root.join("XDG_CONFIG_HOME/skills"),
        "planted",
        "planted",
        Some("a skill"),
    );
    let readout = read(&store);
    assert_eq!(row_named(&readout, "skills", "planted")["name"], "planted");

    // Somebody else removed it between the read and the click.
    fs::remove_dir_all(&directory).expect("removed");

    let refusal = set_skill_enabled(&store, AGENT, PROFILE, "planted", "engine-global", false)
        .expect("a refusal is an answer");
    assert_eq!(refusal["kind"], "no-such-skill");
    assert_eq!(refusal["name"], "planted");
    assert_eq!(refusal["scope"], "engine-global");
    assert!(
        !root.join("skills-store").exists(),
        "a refused action moved nothing, and made no store to move it into"
    );
}

/// A directory this host does not own: the refusal names the engine's variable, and the directory
/// is asserted to be exactly as it was.
#[test]
fn a_directory_with_no_per_skill_switch_is_refused_and_left_alone() {
    let (store, root) = profile_of("no-switch");
    let directory = write_skill(
        &root.join("HOME/.agents/skills"),
        "theirs",
        "theirs",
        Some("d"),
    );

    let refusal = set_skill_enabled(&store, AGENT, PROFILE, "theirs", "agents-directory", false)
        .expect("a refusal is an answer");
    assert_eq!(refusal["kind"], "no-switch");
    assert_eq!(refusal["variable"], DISABLE_EXTERNAL_SKILLS);
    assert!(
        directory.join(SKILL_FILE_NAME).is_file(),
        "a refused action that had already half-happened would be the same lie in another place"
    );
    // And the scope still reports why there is no control: this launch sets that variable, so the
    // engine is not reading the directory either.
    assert_eq!(
        row_named(&read(&store), "skills", "theirs")["surface"]["kind"],
        "suppressed"
    );
}

// ---------------------------------------------------------------------------
// The import is two steps
// ---------------------------------------------------------------------------

/// §8.2's 「覆盖必须确认并保留可恢复副本」, read at the boundary: the first attempt is refused with
/// the directory named and the existing skill untouched, and only the second, deliberate call
/// replaces it — keeping the copy it displaced in this host's store.
#[test]
fn an_import_over_a_taken_name_is_refused_until_it_is_confirmed() {
    let (store, root) = profile_of("import");
    let installed = write_skill(
        &root.join("XDG_CONFIG_HOME/skills"),
        "incoming",
        "incoming",
        Some("the one that is there"),
    );
    let source = write_skill(
        &root.parent().expect("the data directory").join("authored"),
        "incoming",
        "incoming",
        Some("the one being installed"),
    );
    let at = source.to_str().expect("a UTF-8 path");

    // Step one: read what would be installed, and write nothing.
    let preview = preview_skill(&store, AGENT, PROFILE, at).expect("an answer");
    assert_eq!(preview["name"], "incoming");
    assert_eq!(preview["description"], "the one being installed");
    let files: Vec<&str> = preview["files"]
        .as_array()
        .expect("a file list")
        .iter()
        .map(|file| file["path"].as_str().expect("a path"))
        .collect();
    assert_eq!(
        files,
        vec![SKILL_FILE_NAME],
        "the walk is what produced this"
    );
    assert!(
        preview["scripts"]
            .as_array()
            .expect("a script list")
            .is_empty(),
        "nothing but SKILL.md, so there is no script to run"
    );
    assert!(
        fs::read_to_string(installed.join(SKILL_FILE_NAME))
            .expect("still there")
            .contains("the one that is there"),
        "a preview writes nothing"
    );

    // Step two, unconfirmed: refused, with the directory the conflict is about.
    let refusal = import_skill(&store, AGENT, PROFILE, at, false).expect("a refusal is an answer");
    assert_eq!(refusal["kind"], "name-taken");
    assert_eq!(refusal["name"], "incoming");
    assert_eq!(
        refusal["directory"],
        installed.to_string_lossy().as_ref(),
        "the row the page draws the conflict beside"
    );
    assert!(
        fs::read_to_string(installed.join(SKILL_FILE_NAME))
            .expect("still there")
            .contains("the one that is there"),
        "a refusal moves nothing"
    );

    // Confirmed: installed, and the copy it displaced is kept.
    let accepted = import_skill(&store, AGENT, PROFILE, at, true).expect("an answer");
    assert_eq!(accepted, Value::Null);
    assert!(fs::read_to_string(installed.join(SKILL_FILE_NAME))
        .expect("replaced")
        .contains("the one being installed"));
    let kept: Vec<PathBuf> = fs::read_dir(root.join("skills-store/replaced/engine-global"))
        .expect("the store kept the copy it displaced")
        .map(|entry| entry.expect("an entry").path())
        .collect();
    assert_eq!(kept.len(), 1, "one recoverable copy: {kept:?}");
    assert!(
        fs::read_to_string(kept[0].join(SKILL_FILE_NAME))
            .expect("readable")
            .contains("the one that is there"),
        "and it is the copy that was there, not a second copy of the new one"
    );
}
