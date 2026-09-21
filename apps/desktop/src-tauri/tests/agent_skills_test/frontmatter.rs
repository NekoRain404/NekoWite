//! 导入前的校验 — the frontmatter rules, and one refusal per way of failing them.
//!
//! One refusal per fault rather than one "could not import", because each fault has a different
//! next move for whoever has to fix it. The last two cases read those rules from the other side: a
//! skill already on disk that carries a fault is *reported* as a row rather than dropped, since the
//! row is the only place its user could see the problem.

use std::fs;

use crate::skills::{Overwrite, SkillError, SkillSurface, MAX_DESCRIPTION_CHARS, SKILL_FILE_NAME};

use crate::support::{library, scratch, write_file, write_skill};

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
