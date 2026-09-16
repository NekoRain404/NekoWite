//! Where a skill may be found, and which of those places this launch actually reads.
//!
//! This is `skills.rs`'s first responsibility split into its own target, as §13.1's 拆分依据是责任
//! asks: `skills/scope.rs` answers "where does the engine look, and what is this host allowed to do
//! there", while `skills/discover.rs` and `skills/import.rs` answer "what is on disk" and "what may
//! be written". `agent_skills_test.rs` carries the second and third; the first is here, because the
//! file that held both reached the 800-line budget for a test target and the two domains were
//! already named separately in the module tree.
//!
//! The distinction this file exists to hold is §8.2's, and it is the one a readout gets wrong by
//! the flattering direction: a scope the engine's rules name is **configured**, and a scope this
//! launch actually reads **contributes**. They came apart when `process.rs`'s `isolated_profile_env`
//! began setting `OPENCODE_DISABLE_EXTERNAL_SKILLS`, which stopped the engine scanning `.claude`
//! and `.agents` — and a scope list that kept describing those directories as sources of skills
//! would have told a user their own private skills were being read by an agent that had stopped
//! looking at them. So the switch list is *derived* from the launch environment here
//! ([`skills::launch_switches`]), and the tests below hold the derivation to the two facts the
//! pinned engine was measured on: the value decides (`=1` yes, `=0` no), and the wide
//! `OPENCODE_DISABLE_CLAUDE_CODE` stops the `.claude` scan on its own.
//!
//! Module inclusion follows `agent_skills_test.rs`: `skills.rs` reaches for nothing but `std`, so
//! it is declared by path and included alone, and this target tests exactly the tree the library
//! compiles rather than a copy of it.

// The re-exports `skills.rs` writes for the library are unused in a copy that reaches only part of
// it, which is what a `#[path]`-included module looks like from one target's side.
#[path = "../src/agent_runtime/skills.rs"]
#[allow(unused_imports)]
mod skills;

use std::fs;
use std::path::{Path, PathBuf};

use skills::{
    launch_switches, opencode_scopes, DisableMechanism, ScopeOwner, SkillLibrary, SkillSurface,
    DISABLE_CLAUDE_CODE, DISABLE_CLAUDE_CODE_SKILLS, DISABLE_EXTERNAL_SKILLS, SKILL_FILE_NAME,
};

/// A scratch tree inside the repository, removed on entry. §3.2 forbids a development profile from
/// being the developer's own, and `$HOME` is never read anywhere in this file.
fn scratch(label: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/agent-skills-scope-test")
        .join(format!("{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch directory");
    dir
}

/// A skill directory the way an author writes one: a folder, and a `SKILL.md` naming it.
fn write_skill(root: &Path, folder: &str, name: &str) -> PathBuf {
    let directory = root.join(folder);
    fs::create_dir_all(&directory).expect("skill directory");
    fs::write(
        directory.join(SKILL_FILE_NAME),
        format!("---\nname: {name}\ndescription: d\n---\n\n# {name}\n"),
    )
    .expect("skill file");
    directory
}

/// One engine variable, as a launch environment carries it — the shape
/// `process::isolated_profile_env` returns, written out here because this target includes
/// `skills.rs` alone and reaches no sibling module.
fn switch(variable: &str, value: &str) -> (String, String) {
    (variable.to_string(), value.to_string())
}

/// The scope list is the engine's own, and it is built from the roots a caller has rather than from
/// a hard-coded home. A `user-config` profile has no configuration root to point at, and `None`
/// says so rather than an empty path that would scan the filesystem's root.
#[test]
fn the_engine_scopes_are_built_from_the_roots_a_caller_has() {
    let roots = scratch("scopes");
    let home = roots.join("home");
    let project = roots.join("project");
    let declared = vec![roots.join("declared")];

    let owned = opencode_scopes(Some(&roots.join("config")), &home, &project, &declared, &[]);
    assert_eq!(
        owned.iter().map(|scope| scope.id.as_str()).collect::<Vec<_>>(),
        vec![
            "engine-global",
            "engine-project",
            "claude-code",
            "agents-directory",
            "declared-0"
        ]
    );
    assert_eq!(owned[0].root, roots.join("config/skills"));
    assert_eq!(owned[0].owner, ScopeOwner::Managed);
    assert_eq!(owned[1].root, project.join(".opencode/skills"));
    assert_eq!(owned[2].root, home.join(".claude/skills"));
    assert_eq!(owned[3].root, home.join(".agents/skills"));
    assert_eq!(owned[4].root, roots.join("declared"));
    // Nothing this host can throw for the two it does not own: no per-skill switch, and the two
    // foreign directories have only the engine's own.
    assert_eq!(owned[1].disable, DisableMechanism::None);
    assert_eq!(owned[4].disable, DisableMechanism::None);
    // A launch this host injects nothing into has nothing suppressed — that is a `user-config`
    // profile's environment, and it is how "this host sets no switch" is said.
    assert!(owned.iter().all(|scope| scope.suppressed_by.is_none()));

    // The library is built from exactly this list and keeps the store it was given, which is what
    // the IPC layer reads when it answers the page.
    let library = SkillLibrary::new(owned.clone(), roots.join("store")).expect("library");
    assert_eq!(library.scopes().len(), 5);
    assert_eq!(library.store(), roots.join("store"));

    let reused = opencode_scopes(None, &home, &project, &[], &[]);
    assert_eq!(
        reused.iter().map(|scope| scope.id.as_str()).collect::<Vec<_>>(),
        vec!["engine-project", "claude-code", "agents-directory"],
        "a profile reusing the user's configuration has no global directory this host may write in"
    );
}

/// The engine's own switches, as facts a row can carry: `OPENCODE_DISABLE_EXTERNAL_SKILLS` stops
/// both foreign directories being read, and either Claude-Code switch stops `.claude` alone.
#[test]
fn the_engine_switches_decide_which_foreign_directories_are_read() {
    let roots = scratch("suppressed");
    let home = roots.join("home");
    let project = roots.join("project");
    for name in ["from-claude", "from-agents"] {
        let root = if name == "from-claude" {
            home.join(".claude/skills")
        } else {
            home.join(".agents/skills")
        };
        write_skill(&root, name, name);
    }
    let scopes_for = |env: &[(String, String)]| {
        let library = SkillLibrary::new(
            opencode_scopes(None, &home, &project, &[], env),
            roots.join("store"),
        )
        .expect("library");
        library.discover().expect("discover")
    };
    let surface_of = |found: &[skills::SkillView], name: &str| {
        found
            .iter()
            .find(|view| view.name == name)
            .unwrap_or_else(|| panic!("{name} row"))
            .surface
            .clone()
    };

    let both = scopes_for(&[switch(DISABLE_EXTERNAL_SKILLS, "1")]);
    assert_eq!(both.len(), 2);
    for view in &both {
        assert_eq!(
            view.surface,
            SkillSurface::Suppressed {
                variable: DISABLE_EXTERNAL_SKILLS
            },
            "{}",
            view.name
        );
        // The scope's own state, carried beside the surface: a page asks "is this directory read
        // at all" of the scope, and a row answers it even when its own frontmatter is unusable.
        assert_eq!(view.suppressed_by, Some(DISABLE_EXTERNAL_SKILLS));
    }

    // The narrow switch, and the wide one the engine nests under it: both stop `.claude` while
    // `.agents` is still read.
    for variable in [DISABLE_CLAUDE_CODE_SKILLS, DISABLE_CLAUDE_CODE] {
        let found = scopes_for(&[switch(variable, "1")]);
        assert_eq!(
            surface_of(&found, "from-claude"),
            SkillSurface::Suppressed { variable },
            "{variable}"
        );
        assert_eq!(surface_of(&found, "from-agents"), SkillSurface::Offered, "{variable}");
    }

    // **Present and off is not on.** Measured end to end in `agent_profile_isolation_test.rs`'s
    // control launch, where `=0` brings the decoys back; here it is the same fact stated where the
    // readout is built, because a scope list that reported this directory as suppressed would tell
    // a user their skills are not being read when they are — the same error in the other direction.
    let off = scopes_for(&[switch(DISABLE_EXTERNAL_SKILLS, "0")]);
    assert_eq!(surface_of(&off, "from-claude"), SkillSurface::Offered);
    assert_eq!(surface_of(&off, "from-agents"), SkillSurface::Offered);
    assert_eq!(
        launch_switches(&[switch(DISABLE_EXTERNAL_SKILLS, "false")]),
        Vec::<&str>::new()
    );
    assert_eq!(
        launch_switches(&[switch(DISABLE_EXTERNAL_SKILLS, "1")]),
        vec![DISABLE_EXTERNAL_SKILLS]
    );
}
