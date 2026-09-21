//! 覆盖必须确认并保留可恢复副本 — replacing a skill is asked for, and what it replaced is kept.
//!
//! The default refuses, so a settings page that forgot to ask cannot lose a directory. A confirmed
//! overwrite is a move into the store rather than a delete, and the case below reads the previous
//! copy back byte for byte — a "recoverable" nobody read back would not be evidence of one.

use std::fs;

use crate::skills::{Overwrite, SkillImport, SKILL_FILE_NAME};

use crate::support::{library, one_error, scratch, write_file, write_skill};

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
