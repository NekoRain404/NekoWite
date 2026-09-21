//! 发现：冲突 — a name found twice, and a scope that is not there.
//!
//! The engine collects duplicate matches into an unordered set, loads them concurrently and lets the
//! last arrival win — so a "winner" in this readout would be this app inventing a rule the engine
//! does not have: both directories are named and neither row is dropped. A scope root that is
//! missing is the ordinary case — a project with no `.opencode` — and is skipped rather than
//! reported as a fault.

use crate::skills::{ScopeOwner, SkillSurface};

use crate::support::{library, one_error, scratch, write_skill};

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
