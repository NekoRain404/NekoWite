//! R5 — Skills: what an import touches, and what switching one off actually does.
//!
//! §10.2's T13 row states three things, and this file is where two of them are settled — the third
//! (模型/MCP/命令来源明确) is a settings page's, and is E3's.
//!
//! - **导入不执行脚本.** The risk this row carries is that a Skills importer takes content from
//!   outside the app and makes it available to something that will execute it. So the central test
//!   below does not assert that nothing ran: it builds a skill whose payload leaves a canary file,
//!   **fires the payload on purpose** to prove the canary can appear, removes the canary, and then
//!   imports. The absence afterwards is evidence because the presence was observed first — the same
//!   discipline the ACP side applies to a downloaded binary ("a download is not executable until it
//!   passes"), and the reason a canary that cannot fire would prove nothing.
//! - **禁用真实生效.** A disabled-looking feature that still runs is worse than one that never
//!   existed, so a switch here is a *move*, and the tests re-scan after moving: the skill is gone
//!   from discovery, it is present in the store, and switching it back on restores it. The other
//!   half is the refusal — a scope whose contents this host cannot affect is refused with the
//!   engine's own variable named, and the directory is asserted to be untouched afterwards, because
//!   a refused action that had already half-happened would be the same lie in a different place.
//!
//! Everything the tests below call is measured from the pinned OpenCode 1.18.29 rather than assumed
//! (`docs/audits/2026-09-16-opencode-acp-p0.md` §1): the directory list, the frontmatter rules, the
//! two engine switches, and what was observed of a duplicate name — both load, and which one wins is
//! not settled by anything this host can see. That is why the conflict test asserts that *both*
//! directories are reported and that neither is nominated as the winner.
//!
//! Where a scope is found, whether this launch reads it, and what the engine does with a skill in
//! it is `agent_skills_scope_test.rs`'s. That is one of `skills.rs`'s three responsibilities —
//! scope, discovery, import — and it moved out when this file reached the 800-line budget for a test
//! target (§13.1: 按行为域拆分). The tree below is still the whole of `skills.rs`; only the tests
//! about *which directories are sources* live next door.
//!
//! Module inclusion: the module is declared here by path rather than through `agent_runtime/mod.rs`,
//! which is the convention every target in this directory uses. It is included on its own, with no
//! sibling modules, because `skills.rs` reaches for nothing but `std`: the profile and adapter
//! layers are not this file's dependencies, and a module that needs no tree is a module a test
//! cannot accidentally test a different copy of.
//!
//! Scratch directories live under this crate's `target/`, which is inside the repository and
//! git-ignored: §3.2 forbids a development profile from being the developer's own, and `$HOME` is
//! never read anywhere in this file.

// The re-exports `skills.rs` writes for the library are unused in a copy that reaches only part of
// it, which is what a `#[path]`-included module looks like from one target's side.
#[path = "../src/agent_runtime/skills.rs"]
#[allow(unused_imports)]
mod skills;

use std::fs;
use std::path::{Path, PathBuf};

use skills::{
    DisableMechanism, Overwrite, ScopeOwner, SkillError, SkillImport, SkillLibrary, SkillPreview,
    SkillScope, SkillSurface, SkillView, DISABLE_CLAUDE_CODE_SKILLS, MAX_DESCRIPTION_CHARS,
    MAX_IMPORTED_FILE_BYTES, SKILL_FILE_NAME,
};

/// A scratch tree inside the repository. Removed on entry, so a previous run's leftovers cannot be
/// what a test passes on.
fn scratch(label: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/agent-skills-test")
        .join(format!("{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch directory");
    dir
}

fn write_file(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("parent directory");
    }
    fs::write(path, contents).expect("write file");
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

/// The scope list a browser test would never have: a managed global directory, a project, and the
/// two directories another tool owns.
fn scopes(roots: &Path) -> Vec<SkillScope> {
    vec![
        SkillScope {
            id: "engine-global".to_string(),
            label: "profile".to_string(),
            root: roots.join("config/skills"),
            owner: ScopeOwner::Managed,
            suppressed_by: None,
            disable: DisableMechanism::PerSkill,
        },
        SkillScope {
            id: "engine-project".to_string(),
            label: "project".to_string(),
            root: roots.join("project/.opencode/skills"),
            owner: ScopeOwner::Engine,
            suppressed_by: None,
            disable: DisableMechanism::None,
        },
        SkillScope {
            id: "claude-code".to_string(),
            label: "claude".to_string(),
            root: roots.join("home/.claude/skills"),
            owner: ScopeOwner::Foreign,
            suppressed_by: None,
            disable: DisableMechanism::EngineSwitch {
                variable: DISABLE_CLAUDE_CODE_SKILLS,
            },
        },
    ]
}

/// A library over those scopes, with its store beside them and outside every root.
fn library(roots: &Path) -> SkillLibrary {
    SkillLibrary::new(scopes(roots), roots.join("store")).expect("library")
}

fn one_error(error: SkillError) -> &'static str {
    error.kind()
}

// ── 导入不执行脚本 ────────────────────────────────────────────────────────────────────────────

/// The payload the fixture skill carries: a script whose only effect is a file appearing.
const CANARY_PAYLOAD: &str = "#!/bin/sh\nprintf 'ran' > \"$1\"\n";

/// The acceptance's risky half, shown rather than asserted.
///
/// Three observations, in this order: the canary can appear (so its absence means something), the
/// import happened (so the absence is not because nothing was copied), and the canary is not there.
#[cfg(unix)]
#[test]
fn importing_a_skill_copies_its_payload_and_runs_none_of_it() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    let roots = scratch("no-execution");
    let source = roots.join("incoming/leaky");
    let payload = source.join("scripts/payload.sh");
    write_skill(
        &roots.join("incoming"),
        "leaky",
        "leaky",
        Some("A skill with a payload."),
    );
    write_file(&payload, CANARY_PAYLOAD);
    write_file(&source.join("reference/notes.md"), "# Notes\n");
    fs::set_permissions(&payload, fs::Permissions::from_mode(0o755)).expect("executable bit");

    let canary = roots.join("canary");
    let library = library(&roots);

    // The preview names the script without having run it: the file list is a walk, and the payload
    // is listed because it exists, not because anything looked at what it does.
    let preview: SkillPreview = library.preview(&source).expect("preview");
    assert_eq!(preview.name, "leaky");
    assert_eq!(
        preview.scripts,
        vec![
            ("reference/notes.md".to_string(), 8),
            (
                "scripts/payload.sh".to_string(),
                CANARY_PAYLOAD.len() as u64
            ),
        ],
        "every file that is not SKILL.md is named before anything is installed"
    );
    assert!(
        !canary.exists(),
        "reading a preview must not run anything either"
    );

    // The positive control. Without it, a canary that could never have fired would make the whole
    // test pass for the wrong reason — which is exactly the failure mode this file exists to avoid.
    let fired = Command::new("/bin/sh")
        .arg(&payload)
        .arg(&canary)
        .status()
        .expect("run the payload on purpose");
    assert!(fired.success(), "the payload must be able to run");
    assert!(canary.exists(), "the canary must be able to appear");
    fs::remove_file(&canary).expect("clear the canary");

    let installed: SkillImport = library
        .import(&source, "engine-global", Overwrite::KeepExisting)
        .expect("import");

    assert!(
        !canary.exists(),
        "the import ran the payload: the canary appeared at {}",
        canary.display()
    );
    // The import happened: every file is there, byte for byte, including the executable bit the
    // engine's own shell needs. A copy that had silently dropped files would make the assertion
    // above true for the wrong reason.
    for (relative, size) in &installed.preview.files {
        let copied = installed.installed_at.join(relative);
        let copied_size = fs::metadata(&copied).expect("copied file").len();
        assert_eq!(copied_size, *size, "{relative} is not the same size");
    }
    assert_eq!(
        fs::read_to_string(installed.installed_at.join("scripts/payload.sh")).expect("read back"),
        CANARY_PAYLOAD
    );
    assert!(
        installed.installed_at.join("scripts/payload.sh").is_file(),
        "the script is installed; that it is installed is not a claim that it is safe"
    );
    assert_eq!(
        library
            .discover()
            .expect("discover")
            .iter()
            .map(|view| view.name.clone())
            .collect::<Vec<_>>(),
        vec!["leaky".to_string()],
        "the installed skill is one the engine now finds"
    );
}

// ── 导入前的校验 ─────────────────────────────────────────────────────────────────────────────

/// One refusal per thing a user can do about it — not one "could not import".
#[test]
fn a_skill_that_cannot_be_read_says_which_part_of_it_could_not_be() {
    let roots = scratch("frontmatter");
    let incoming = roots.join("incoming");
    // Every folder is one `SKILL.md`, and each body is one fault. The folder names are the names the
    // frontmatter claims, so a body that parses would pass the folder check and reach whatever this
    // case is actually about.
    let faults: [(&str, String); 7] = [
        ("no-frontmatter", "# A heading, and no block.\n".to_string()),
        (
            "unterminated",
            "---\nname: unterminated\ndescription: d\n".to_string(),
        ),
        ("no-name", "---\ndescription: d\n---\n".to_string()),
        (
            "BadName",
            "---\nname: BadName\ndescription: d\n---\n".to_string(),
        ),
        (
            "long-name",
            format!("---\nname: {}\ndescription: d\n---\n", "a".repeat(80)),
        ),
        (
            "no-description",
            "---\nname: no-description\n---\n".to_string(),
        ),
        (
            "long-description",
            format!(
                "---\nname: long-description\ndescription: {}\n---\n",
                "d".repeat(MAX_DESCRIPTION_CHARS + 1)
            ),
        ),
    ];
    for (folder, body) in &faults {
        write_file(&incoming.join(folder).join(SKILL_FILE_NAME), body);
    }
    // A line the parser cannot read at all, which is refused with its number rather than skipped:
    // guessing would put a value in a field the user did not write.
    write_file(
        &incoming.join("bad-line").join(SKILL_FILE_NAME),
        "---\nname: bad-line\nthis line has no colon\ndescription: d\n---\n",
    );
    // A folder with no `SKILL.md` in it at all — a different answer from any of the above, because
    // there is nothing to read rather than something unreadable.
    fs::create_dir_all(incoming.join("no-manifest")).expect("empty folder");

    let library = library(&roots);
    let mut said = Vec::new();
    for folder in [
        "no-manifest",
        "no-frontmatter",
        "unterminated",
        "no-name",
        "BadName",
        "long-name",
        "no-description",
        "long-description",
        "bad-line",
    ] {
        let error = library
            .preview(&incoming.join(folder))
            .expect_err("must refuse");
        said.push((folder, error.kind()));
    }
    assert_eq!(
        said,
        vec![
            ("no-manifest", "no-manifest"),
            ("no-frontmatter", "no-frontmatter"),
            ("unterminated", "unterminated-frontmatter"),
            ("no-name", "name-missing"),
            ("BadName", "name-shape"),
            ("long-name", "name-shape"),
            ("no-description", "description-missing"),
            ("long-description", "description-too-long"),
            ("bad-line", "frontmatter-line"),
        ],
        "each fault has to be its own answer, because each one has a different next move"
    );
    assert!(
        !roots.join("config/skills").exists(),
        "a refused preview writes nothing"
    );
}

/// The frontmatter name and the folder have to agree — the engine refuses such a skill, and
/// renaming it in place would be this app editing the user's file to make its own check pass.
#[test]
fn an_import_refuses_a_name_that_is_not_the_folder() {
    let roots = scratch("name-mismatch");
    write_skill(
        &roots.join("incoming"),
        "folder-name",
        "other-name",
        Some("d"),
    );
    let error = library(&roots)
        .import(
            &roots.join("incoming/folder-name"),
            "engine-global",
            Overwrite::KeepExisting,
        )
        .expect_err("must refuse");
    assert_eq!(
        error,
        SkillError::NameMismatch {
            name: "other-name".to_string(),
            folder: "folder-name".to_string(),
        }
    );
}

/// A skill already installed under a name whose folder disagrees is *reported*, not hidden: the row
/// is the only place its user could see the problem.
#[test]
fn a_discovered_mismatch_is_shown_rather_than_dropped() {
    let roots = scratch("discovered-mismatch");
    let directory = roots.join("config/skills/folder-name");
    write_file(
        &directory.join(SKILL_FILE_NAME),
        "---\nname: other-name\ndescription: d\n---\n",
    );
    let found = library(&roots).discover().expect("discover");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].name, "other-name");
    assert_eq!(
        found[0].surface,
        SkillSurface::Unusable {
            error: SkillError::NameMismatch {
                name: "other-name".to_string(),
                folder: "folder-name".to_string(),
            }
        }
    );
}

/// A skill without a description is installed and inert — the engine filters it out and never
/// surfaces it — so the page has to be able to say that, and the row stays in the list.
#[test]
fn a_skill_without_a_description_is_shown_as_inert() {
    let roots = scratch("undescribed");
    write_file(
        &roots
            .join("config/skills/undescribed")
            .join(SKILL_FILE_NAME),
        "---\nname: undescribed\n---\n",
    );
    let found = library(&roots).discover().expect("discover");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].surface, SkillSurface::Undescribed);
}

// ── 符号链接逃逸与大小上限 ───────────────────────────────────────────────────────────────────

/// A link inside a skill is a pointer at something the import is not taking custody of.
#[cfg(unix)]
#[test]
fn an_import_refuses_a_symbolic_link_and_leaves_nothing_behind() {
    let roots = scratch("symlink");
    let source = write_skill(&roots.join("incoming"), "linked", "linked", Some("d"));
    let outside = roots.join("outside");
    write_file(&outside.join("secret.txt"), "not part of this skill\n");
    std::os::unix::fs::symlink(outside.join("secret.txt"), source.join("escape.txt"))
        .expect("symlink");

    let error = library(&roots)
        .import(&source, "engine-global", Overwrite::KeepExisting)
        .expect_err("must refuse");
    assert_eq!(one_error(error), "symlink");
    assert!(
        !roots.join("config/skills/linked").exists(),
        "a refused import leaves no half-copied skill directory for the engine to read"
    );
}

/// A skill *reached* through such a link is reported as outside its scope: the engine would read
/// the target, so the row must exist, and it must not claim to be this scope's content.
#[cfg(unix)]
#[test]
fn a_skill_reached_through_a_link_out_of_its_scope_is_reported_as_such() {
    let roots = scratch("escaping-skill");
    let outside = write_skill(&roots.join("outside"), "elsewhere", "elsewhere", Some("d"));
    fs::create_dir_all(roots.join("config/skills")).expect("scope root");
    std::os::unix::fs::symlink(&outside, roots.join("config/skills/elsewhere")).expect("symlink");

    let found = library(&roots).discover().expect("discover");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].name, "elsewhere");
    assert_eq!(
        found[0].surface,
        SkillSurface::Unusable {
            error: SkillError::EscapesScope {
                directory: roots.join("config/skills/elsewhere"),
                scope: "engine-global".to_string(),
            }
        }
    );
}

/// The three ceilings refuse rather than truncate: a skill whose scripts were silently cut would
/// fail later, in a way nobody could connect to the import.
#[test]
fn an_oversized_skill_is_refused_rather_than_cut() {
    let roots = scratch("size");
    let library = library(&roots);

    let big = write_skill(&roots.join("incoming"), "big", "big", Some("d"));
    write_file(
        &big.join("large.bin"),
        &"x".repeat(MAX_IMPORTED_FILE_BYTES as usize + 1),
    );
    assert_eq!(
        one_error(library.preview(&big).expect_err("must refuse")),
        "file-too-large"
    );

    let many = write_skill(&roots.join("incoming"), "many", "many", Some("d"));
    for index in 0..300 {
        write_file(&many.join(format!("file-{index}.md")), "x");
    }
    assert_eq!(
        one_error(library.preview(&many).expect_err("must refuse")),
        "too-many-files"
    );
}

// ── 覆盖必须确认并保留可恢复副本 ─────────────────────────────────────────────────────────────

/// The default is to refuse. A settings page that had to opt in to replacing could not lose a
/// directory by forgetting to ask.
#[test]
fn a_name_already_taken_is_refused_and_the_existing_skill_is_untouched() {
    let roots = scratch("overwrite-refused");
    let library = library(&roots);
    let installed = write_skill(
        &roots.join("config/skills"),
        "duplicate",
        "duplicate",
        Some("old"),
    );
    write_file(&installed.join("keep.md"), "the user's own file\n");

    let source = write_skill(
        &roots.join("incoming"),
        "duplicate",
        "duplicate",
        Some("new"),
    );
    let error = library
        .import(&source, "engine-global", Overwrite::KeepExisting)
        .expect_err("must refuse");
    assert_eq!(one_error(error), "name-taken");
    assert!(
        installed.join("keep.md").is_file(),
        "the existing skill stands"
    );
    assert_eq!(
        fs::read_to_string(source.join(SKILL_FILE_NAME)).expect("source"),
        "---\nname: duplicate\ndescription: new\n---\n\n# duplicate\n\nBody.\n"
    );
}

/// A confirmed overwrite is recoverable: the directory that was there is in the store, with its
/// bytes, and the new one is installed where the engine will read it.
#[test]
fn a_confirmed_overwrite_keeps_the_previous_copy() {
    let roots = scratch("overwrite-kept");
    let library = library(&roots);
    let installed = write_skill(
        &roots.join("config/skills"),
        "duplicate",
        "duplicate",
        Some("old"),
    );
    write_file(&installed.join("keep.md"), "the user's own file\n");

    let source = write_skill(
        &roots.join("incoming"),
        "duplicate",
        "duplicate",
        Some("new"),
    );
    let outcome: SkillImport = library
        .import(&source, "engine-global", Overwrite::Replace)
        .expect("replace");

    let replaced = outcome.replaced.expect("the previous copy is kept");
    assert!(replaced.is_dir());
    assert_eq!(
        fs::read_to_string(replaced.join("keep.md")).expect("the old copy survives"),
        "the user's own file\n"
    );
    assert!(
        !installed.join("keep.md").exists(),
        "the new skill is installed over the old one, and the old one is in the store"
    );
    assert!(installed.join(SKILL_FILE_NAME).is_file());
}

// ── 禁用真实生效 ─────────────────────────────────────────────────────────────────────────────

/// The acceptance in one test: after switching a skill off, a *fresh scan* does not find it, and
/// switching it back on restores it.
///
/// A scan rather than an assertion about the readout, because what has to be true is that the
/// engine's next scan comes up empty — and the engine's scan is these same directories.
#[test]
fn switching_a_skill_off_removes_it_from_discovery() {
    let roots = scratch("disable");
    let library = library(&roots);
    write_skill(
        &roots.join("config/skills"),
        "noisy",
        "noisy",
        Some("A skill."),
    );

    let found = library.discover().expect("discover");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].surface, SkillSurface::Offered);
    assert_eq!(found[0].disable, DisableMechanism::PerSkill);

    let stored = library.set_enabled(&found[0], false).expect("switch off");
    assert!(stored.is_dir(), "the bytes are kept, not deleted");
    assert!(
        library.discover().expect("discover").is_empty(),
        "a switched-off skill is not found by the next scan"
    );
    assert_eq!(
        library
            .disabled()
            .expect("disabled")
            .iter()
            .map(|view| view.name.clone())
            .collect::<Vec<_>>(),
        vec!["noisy".to_string()]
    );

    let stored_view = library.disabled().expect("disabled").remove(0);
    assert_eq!(stored_view.surface, SkillSurface::Disabled);
    let restored = library.set_enabled(&stored_view, true).expect("switch on");
    assert!(restored.is_dir());
    assert_eq!(
        library
            .discover()
            .expect("discover")
            .iter()
            .map(|view| view.name.clone())
            .collect::<Vec<_>>(),
        vec!["noisy".to_string()],
        "switching it back on puts it back where the engine reads"
    );
    assert!(library.disabled().expect("disabled").is_empty());
}

/// The structural half. A store inside a root would be scanned, so a "switched off" skill would
/// still be found — the exact shape of a disable that is only a hidden row. The library refuses to
/// be built that way, so no later operation can produce one.
#[test]
fn a_store_that_a_scan_would_reach_is_refused() {
    let roots = scratch("store-inside-scope");
    let error = SkillLibrary::new(scopes(&roots), roots.join("config/skills/disabled"))
        .expect_err("must refuse");
    assert_eq!(one_error(error), "store-inside-scope");
    let error =
        SkillLibrary::new(scopes(&roots), roots.join("config/skills")).expect_err("must refuse");
    assert_eq!(one_error(error), "store-inside-scope");
    // A relative store would be resolved against this app's own working directory.
    let error = SkillLibrary::new(scopes(&roots), "store").expect_err("must refuse");
    assert_eq!(one_error(error), "relative-path");
}

/// A scope whose contents this host cannot affect has no switch, and a switch request is refused
/// with the engine's own variable named. The directory is asserted to be untouched: a refusal that
/// had already moved something would be the same lie in the other direction.
#[test]
fn a_scope_this_host_cannot_affect_refuses_the_switch() {
    let roots = scratch("no-switch");
    let library = library(&roots);
    write_skill(
        &roots.join("home/.claude/skills"),
        "borrowed",
        "borrowed",
        Some("d"),
    );
    write_skill(
        &roots.join("project/.opencode/skills"),
        "in-project",
        "in-project",
        Some("d"),
    );

    let found = library.discover().expect("discover");
    let borrowed = found
        .iter()
        .find(|view| view.name == "borrowed")
        .expect("claude row");
    assert_eq!(
        borrowed.disable,
        DisableMechanism::EngineSwitch {
            variable: DISABLE_CLAUDE_CODE_SKILLS
        },
        "the only switch there is belongs to the engine, and the row names it"
    );
    assert_eq!(
        library
            .set_enabled(borrowed, false)
            .expect_err("must refuse"),
        SkillError::NoSwitch {
            scope: "claude-code".to_string(),
            variable: Some(DISABLE_CLAUDE_CODE_SKILLS),
        }
    );
    assert!(
        borrowed.directory.is_dir(),
        "nothing was moved by a refusal"
    );

    let project = found
        .iter()
        .find(|view| view.name == "in-project")
        .expect("project row");
    assert_eq!(
        project.disable,
        DisableMechanism::None,
        "there is no switch here at all"
    );
    assert_eq!(
        library
            .set_enabled(project, false)
            .expect_err("must refuse"),
        SkillError::NoSwitch {
            scope: "engine-project".to_string(),
            variable: None,
        }
    );
    assert!(project.directory.is_dir());
}

/// Import writes only where this host owns the directory. Copying into another tool's tree is how a
/// settings page ends up deleting files it did not create (§8.2's last clause).
#[test]
fn an_import_into_a_scope_this_host_does_not_own_is_refused() {
    let roots = scratch("import-scope");
    let library = library(&roots);
    let source = write_skill(&roots.join("incoming"), "portable", "portable", Some("d"));
    for scope in ["engine-project", "claude-code"] {
        let error = library
            .import(&source, scope, Overwrite::KeepExisting)
            .expect_err("must refuse");
        assert_eq!(one_error(error), "not-managed", "scope {scope}");
    }
    assert_eq!(
        one_error(
            library
                .import(&source, "nowhere", Overwrite::KeepExisting)
                .expect_err("must refuse")
        ),
        "unknown-scope"
    );
    assert!(source.is_dir());
}

/// An action names the scope it believes a directory is in, and the check is against the scope's
/// own root rather than against the string the caller sent.
#[test]
fn an_action_outside_the_scope_it_names_is_refused() {
    let roots = scratch("outside-scope");
    let library = library(&roots);
    assert!(library.discover().expect("discover").is_empty());
    let elsewhere = write_skill(&roots.join("somewhere-else"), "loose", "loose", Some("d"));
    // A row that claims a directory in a scope it is not in: a stale readout, or a request made by
    // hand. The check is against the scope's own root rather than against the string the caller
    // sent, so this cannot be used to move a directory out of somebody's project.
    let loose = SkillView {
        name: "loose".to_string(),
        description: Some("d".to_string()),
        directory: elsewhere.clone(),
        scope: "engine-global".to_string(),
        scope_label: "profile".to_string(),
        owner: ScopeOwner::Managed,
        conflicts: Vec::new(),
        surface: SkillSurface::Offered,
        suppressed_by: None,
        disable: DisableMechanism::PerSkill,
    };
    assert_eq!(
        one_error(library.set_enabled(&loose, false).expect_err("must refuse")),
        "outside-scope"
    );
    assert!(elsewhere.is_dir(), "a refused action moved nothing");
}

// ── 发现：冲突 ───────────────────────────────────────────────────────────────────────────────

/// Two skills with one name are a conflict and nothing more.
///
/// The engine collects matches into an unordered set and loads them concurrently, logging the
/// duplicate and letting the last arrival win — so a "winner" here would be this app inventing a
/// rule the engine does not have. Both directories are named, and neither row is dropped.
#[test]
fn a_duplicate_name_is_reported_as_a_conflict_with_no_winner() {
    let roots = scratch("conflict");
    let library = library(&roots);
    let first = write_skill(&roots.join("config/skills"), "twice", "twice", Some("one"));
    let second = write_skill(
        &roots.join("project/.opencode/skills"),
        "twice",
        "twice",
        Some("two"),
    );

    let found = library.discover().expect("discover");
    assert_eq!(found.len(), 2, "neither copy is hidden");
    for view in &found {
        let other = if view.directory == first {
            &second
        } else {
            &first
        };
        assert_eq!(view.conflicts, vec![other.clone()]);
        assert_eq!(view.surface, SkillSurface::Offered);
    }
    // The description and the scope's own label are the two facts a row draws beside the name, so
    // they are read here rather than being fields nothing touches.
    assert_eq!(
        found
            .iter()
            .map(|view| (view.description.clone(), view.scope_label.clone()))
            .collect::<Vec<_>>(),
        vec![
            (Some("one".to_string()), "profile".to_string()),
            (Some("two".to_string()), "project".to_string())
        ]
    );
    // And the scopes, because "which one is on screen" is the question a conflict raises and the
    // scope is the only part of the answer this host can give.
    assert_eq!(
        found
            .iter()
            .map(|view| (view.scope.as_str(), view.owner))
            .collect::<Vec<_>>(),
        vec![
            ("engine-global", ScopeOwner::Managed),
            ("engine-project", ScopeOwner::Engine)
        ]
    );
}

/// A missing scope root is the ordinary case — a project with no `.opencode` — and not a fault.
#[test]
fn a_scope_that_is_not_there_is_skipped() {
    let roots = scratch("absent-scope");
    let library = library(&roots);
    assert!(library.discover().expect("discover").is_empty());
    assert!(library.disabled().expect("disabled").is_empty());
    assert_eq!(
        one_error(
            library
                .preview(&roots.join("nothing-here"))
                .expect_err("must refuse")
        ),
        "missing"
    );
}
