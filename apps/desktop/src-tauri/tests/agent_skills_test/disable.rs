//! 禁用真实生效 — a switch that moves a skill out of the engine's scan, or refuses rather than
//! pretending.
//!
//! `SkillLibrary::new` refuses a store that a scan would reach, so a switched-off skill is out of
//! discovery by construction rather than by convention, and the cases below read the scan before,
//! between and after the two moves. The rest are the refusals — a switch on a scope this host
//! cannot affect, an import into a scope it does not own, and an action naming a scope the directory
//! is not in — each asserted to have moved nothing, because a refusal that had already
//! half-happened would be the same lie in the other direction.

use crate::skills::{
    DisableMechanism, Overwrite, ScopeOwner, SkillError, SkillLibrary, SkillSurface, SkillView,
    DISABLE_CLAUDE_CODE_SKILLS,
};

use crate::support::{library, one_error, scopes, scratch, write_skill};

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
