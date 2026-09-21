//! The fixtures every domain here builds its tree with: the scratch root, the two writers, the
//! scope list, the library over it, and the error-kind shorthand.
//!
//! `CANARY_PAYLOAD` is deliberately not here: only the execution domain needs it, and a fixture one
//! domain needs belongs beside that domain — `fs_test/support.rs` states the same rule.

use std::fs;
use std::path::{Path, PathBuf};

use crate::skills::{
    DisableMechanism, ScopeOwner, SkillError, SkillLibrary, SkillScope, DISABLE_CLAUDE_CODE_SKILLS,
    SKILL_FILE_NAME,
};

/// A scratch tree inside the repository. Removed on entry, so a previous run's leftovers cannot be
/// what a test passes on.
pub fn scratch(label: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/agent-skills-test")
        .join(format!("{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch directory");
    dir
}

pub fn write_file(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("parent directory");
    }
    fs::write(path, contents).expect("write file");
}

/// A skill directory the way an author writes one: a folder, and a `SKILL.md` naming it.
pub fn write_skill(root: &Path, folder: &str, name: &str, description: Option<&str>) -> PathBuf {
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
pub fn scopes(roots: &Path) -> Vec<SkillScope> {
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
pub fn library(roots: &Path) -> SkillLibrary {
    SkillLibrary::new(scopes(roots), roots.join("store")).expect("library")
}

pub fn one_error(error: SkillError) -> &'static str {
    error.kind()
}
