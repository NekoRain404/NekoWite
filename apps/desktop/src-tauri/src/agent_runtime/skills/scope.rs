//! Where a skill may be found, and what this host may do about each place.
//!
//! §3.4's closing line forbids an engine's differences from being scattered through the code, so
//! the *only* thing in this tree that knows an engine by name is [`opencode_scopes`] — and it is
//! named for the engine whose measured behaviour it encodes rather than being called something
//! general. Everything else here takes a scope list as data, which is what makes a second engine a
//! different `Vec<SkillScope>` rather than a second branch.
//!
//! The distinction this module exists to keep is between what a directory *is* and what this host
//! may do inside it. [`ScopeOwner`] answers "whose directory is this" — which is a question about
//! other programs, not about this app — and [`DisableMechanism`] answers "what could switching this
//! off even mean", with an arm for the case where the honest answer is nothing. §8.2's
//! 「不能仅隐藏 UI 项目而声称已禁用」 is enforced by that arm existing, because a page rendering a
//! control for a scope in it is a page the backend refuses.

use std::fs;
use std::path::{Path, PathBuf};

use super::{DISABLE_CLAUDE_CODE_SKILLS, DISABLE_EXTERNAL_SKILLS};

/// What kind of place a scope is, and therefore what this host may do inside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeOwner {
    /// A directory this host created and owns — §8.1's app-managed profile root. The only kind this
    /// module will import into, or switch off one skill at a time.
    Managed,
    /// The engine's own discovery. Its global directory is managed when this host isolated the
    /// profile for it; the project's `.opencode` is the user's vault and never is.
    Engine,
    /// Another tool's directory that this engine happens to read. §8.2: 「不删除兼容扫描到的其他工具
    /// 目录」, so nothing here ever writes into one.
    Foreign,
}

/// What this host can do about switching a scope's skills off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisableMechanism {
    /// Move one skill's directory out of the scope root and keep it in this host's store. Real
    /// because [`SkillLibrary::new`] guarantees the store lies outside every scope root.
    PerSkill,
    /// The only switch is the engine's own: with `variable` set in the engine's environment the
    /// engine does not read this scope at all. Per-skill is refused, because there is no per-skill
    /// thing that could be done.
    EngineSwitch { variable: &'static str },
    /// Nothing this host does changes what the engine reads here. §8.2: 「不能仅隐藏 UI 项目而声称
    /// 已禁用」 — so the page must draw no control, and this module refuses one that arrives anyway.
    None,
}

/// One directory the engine scans, and what may be done about its contents.
#[derive(Debug, Clone)]
pub struct SkillScope {
    /// Stable id, stored and sent back with every action.
    pub id: String,
    /// What a settings page calls this place (§8.2's 来源目录 / 作用范围).
    pub label: String,
    pub root: PathBuf,
    pub owner: ScopeOwner,
    /// The engine's variable that is currently *set* and stops it reading this root, if one is.
    /// `None` means the engine is reading it. A fact about the launch environment, supplied by the
    /// caller that built it rather than guessed from the directory.
    pub suppressed_by: Option<&'static str>,
    pub disable: DisableMechanism,
}

/// The scopes the pinned engine reads, built from the roots a caller actually has.
///
/// The list, the globs and the switches are measured from that artifact, which is why this function
/// is named for the engine rather than being a general rule (§2.3 P1). `config_root` is [`Option`]
/// because the honest answer differs by configuration mode: a profile this host isolated has a
/// global configuration directory to point at, while a profile reusing the user's own configuration
/// has a directory this app must not write in, and `None` is how that is said rather than being
/// smoothed into a path that happens to exist.
///
/// `home` is where `.claude` and `.agents` live; `project` is the working directory a session runs
/// in. The engine also walks *up* from the project for those two; this list names the project
/// directory itself, and a caller wanting the ancestors adds them — the worktree root is a fact
/// about the engine's session that this module cannot see. `switches` are the engine variables
/// currently set in its launch environment, which is what decides `suppressed_by`.
pub fn opencode_scopes(
    config_root: Option<&Path>,
    home: &Path,
    project: &Path,
    declared: &[PathBuf],
    switches: &[&'static str],
) -> Vec<SkillScope> {
    let mut scopes = Vec::new();
    if let Some(config_root) = config_root {
        // The engine's own global directory. `Managed` because §8.1's app-managed profile puts it
        // inside a root this host owns — which is what makes a per-skill switch possible here and
        // nowhere else.
        scopes.push(SkillScope {
            id: "engine-global".to_string(),
            label: "This app's profile, read by the engine".to_string(),
            root: config_root.join("skills"),
            owner: ScopeOwner::Managed,
            suppressed_by: None,
            disable: DisableMechanism::PerSkill,
        });
    }
    scopes.push(SkillScope {
        id: "engine-project".to_string(),
        label: "The open project".to_string(),
        root: project.join(".opencode").join("skills"),
        owner: ScopeOwner::Engine,
        suppressed_by: None,
        // The user's vault is theirs. §8.2 keeps 项目 Skills and 应用受管 Skills apart, and moving a
        // directory out of somebody's project is not a settings page's business.
        disable: DisableMechanism::None,
    });
    for (id, directory, variable, also) in [
        (
            "claude-code",
            ".claude",
            DISABLE_CLAUDE_CODE_SKILLS,
            DISABLE_EXTERNAL_SKILLS,
        ),
        ("agents-directory", ".agents", DISABLE_EXTERNAL_SKILLS, ""),
    ] {
        scopes.push(SkillScope {
            id: id.to_string(),
            label: format!("Another tool's directory ({directory})"),
            root: home.join(directory).join("skills"),
            owner: ScopeOwner::Foreign,
            // The engine skips both directories when the external switch is set, and `.claude`
            // alone under the narrower one — its own nesting, not two independent flags.
            suppressed_by: [variable, also]
                .into_iter()
                .filter(|candidate| !candidate.is_empty())
                .find(|candidate| switches.contains(candidate)),
            disable: DisableMechanism::EngineSwitch { variable },
        });
    }
    for (index, path) in declared.iter().enumerate() {
        // A path the engine's own configuration declares. This host does not know what the user
        // meant by it, has no switch for it, and must not write in it.
        scopes.push(SkillScope {
            id: format!("declared-{index}"),
            label: format!("Declared in the engine's configuration ({})", path.display()),
            root: path.clone(),
            owner: ScopeOwner::Foreign,
            suppressed_by: None,
            disable: DisableMechanism::None,
        });
    }
    scopes
}

/// A path with its symbolic links resolved where that is possible, and itself where it is not.
/// Used for containment only: the answer never reaches a readout, because a resolved path is a fact
/// about this filesystem rather than about what the user asked for.
pub(super) fn resolve(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Whether `candidate` is `root` or lies under it, by path components rather than by string prefix
/// — `/a/bc` must not count as being under `/a/b`.
pub(super) fn contains(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}
