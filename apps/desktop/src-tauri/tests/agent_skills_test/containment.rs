//! 符号链接逃逸与大小上限 — what an import may not take custody of.
//!
//! A link is a pointer at something the import is not taking custody of, so a skill carrying one is
//! refused and nothing is left behind — while a skill *reached* through a link out of its scope is
//! a row, because the engine would read the target and the row is the only place that is visible.
//! The ceilings are the same shape: a skill whose scripts were silently cut would fail later in a
//! way nobody could connect to the import, so the importer refuses rather than truncates.

use std::fs;

use crate::skills::{Overwrite, SkillError, SkillSurface, MAX_IMPORTED_FILE_BYTES};

use crate::support::{library, one_error, scratch, write_file, write_skill};

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
