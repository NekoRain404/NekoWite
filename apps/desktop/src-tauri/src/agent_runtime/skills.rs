//! Skills: which ones the engine finds, what each one declares, and the two operations a settings
//! page may perform on one — import it, or switch it off.
//!
//! §8.2 is the whole of this tree's brief, and almost all of it is negative:
//!
//! - 「导入前预览 SKILL.md 与所带脚本；安装不执行脚本，不自动启动 MCP，不自动放开权限。」
//! - 「目录/压缩包导入检查路径穿越、符号链接逃逸、重名覆盖和大小上限；覆盖必须确认并保留可恢复副本。」
//! - 「启用/禁用只有在能影响引擎发现或权限时才提供；不能仅隐藏 UI 项目而声称已禁用。」
//! - 「项目 Skills 和应用受管 Skills 分开；删除按钮只删除用户明确选中的受管内容。」
//!
//! Each of those is a property of the code below rather than a promise in a comment, because a
//! promise is exactly what the next person to edit this file cannot check:
//!
//! - **Nothing here executes anything.** There is no process, no shell and no `Command` anywhere in
//!   this tree: an import reads bytes and writes bytes. `agent_skills_test.rs` shows that instead of
//!   asserting it — the fixture skill carries an executable payload whose side effect is a canary
//!   file, the canary is first proved able to fire, and it is then absent after an import.
//! - **A disable is a move, and it cannot be a lie.** [`SkillLibrary::new`] refuses a store that
//!   lies inside any scope root, so a switched-off skill is not found by the next scan *by
//!   construction*: there is no code path in which a skill is stored away and still discovered.
//! - **A scope with no honest switch gets no switch.** [`DisableMechanism`] has an arm for "nothing
//!   this host does changes what the engine reads", and [`SkillLibrary::set_enabled`] refuses on it,
//!   so a page that drew a control there would be contradicted by the backend.
//! - **The importer writes only into a scope this host owns.** [`ScopeOwner`] decides that, not the
//!   caller's choice of directory, because the alternative is a settings page that copies into
//!   another tool's tree.
//!
//! ## How the tree is laid out
//!
//! §13.1 sets a 500-line stop for a business file and asks for 拆分依据是责任, so the three
//! responsibilities §9 gives this module live in three modules:
//!
//! - [`scope`] — where a skill may be found at all, and what this host may do about each place:
//!   [`SkillScope`], [`ScopeOwner`], [`DisableMechanism`] and [`opencode_scopes`], which is the one
//!   function here that knows an engine *by identity*.
//! - [`discover`] — reading what is on disk: the frontmatter rules, the manifest walk, and the
//!   [`SkillView`] a settings page renders. It never writes.
//! - [`import`] — taking a folder in and putting one away: the size and symlink checks, the copy,
//!   and the store a switched-off skill is kept in. It is the only module in the tree that writes.
//!
//! What is left in this file is the vocabulary the three share and the [`SkillLibrary`] that binds
//! them: a caller builds one from a scope list and a store, and every operation is a method on it,
//! so a scan and the action taken on its result cannot be looking at two different configurations.
//!
//! ## What is the engine's rule and what is this host's
//!
//! Everything marked *measured* below was read out of the pinned artifact
//! (`docs/audits/2026-09-16-opencode-acp-p0.md` §1, OpenCode 1.18.29): its embedded documentation
//! and its loader, not a website and not another engine's conventions. §2.3's P1 note is why the
//! distinction is drawn here — 「不同引擎的目录、优先级、禁用语义由各自适配器定义，不套用 Zed 内置 Skills
//! 规则」.
//!
//! - **Directories (measured).** For every configuration root the engine knows — its global config
//!   directory and the project's `.opencode` — it scans `{skill,skills}/**\/SKILL.md`; under the
//!   home directory and the project's ancestors it scans `skills/**\/SKILL.md` beneath `.claude`
//!   and `.agents`. A `skills.paths` entry declared in the engine's own configuration is scanned as
//!   `**\/SKILL.md`. [`opencode_scopes`] builds exactly that list.
//! - **Frontmatter (measured).** The file is `SKILL.md` exactly, in its own folder. `name` is
//!   required, lowercase hyphen-separated, at most 64 characters, and matches the folder name;
//!   `description` is required in effect, since the loader drops skills without one and never
//!   surfaces them; `license`, `compatibility` and `metadata` are optional.
//! - **Duplicate names (observed, and not a rule).** In the pinned 1.18.29 the loader collects
//!   matches into an unordered set and loads them with unbounded concurrency, logging
//!   `duplicate skill name` and letting the *last* arrival win. **That is an observation of one
//!   version, not a precedence this host may state**: nothing in the loader promises which one wins,
//!   and a rule stated here would become confidently wrong the day the engine grows one. So
//!   [`SkillView::conflicts`] names every other directory and nominates no winner.
//! - **Switching off (measured).** The engine reads `OPENCODE_DISABLE_EXTERNAL_SKILLS` and
//!   `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` from its own environment; with either on it does not
//!   scan the corresponding directories at all. Those are the only whole-scope switches that exist,
//!   they belong to the engine, and all this host may do is put one in a launch environment. Its
//!   `RuntimeFlags` also nests the wide `OPENCODE_DISABLE_CLAUDE_CODE` under the `.claude` scan,
//!   and it reads each of them as a *boolean*, so a variable that is set to something off leaves
//!   the scan on — which is why [`launch_switches`] reads values rather than presence.
//! - **Everything else is this host's**, and is labelled as such: the import limits
//!   ([`MAX_IMPORTED_FILE_BYTES`] and friends) are ours, because the engine's own limits are not
//!   documented and "no limit we could find" is not a limit to import under.
//!
//! ## Where this tree stops
//!
//! It knows nothing about engines *by identity* beyond [`opencode_scopes`], which is named for the
//! engine whose behaviour it encodes. Wiring that list into `adapters/opencode.rs` — so a second
//! engine's directories arrive through its own adapter, as §3.4's closing line requires — is a
//! change to a file this task does not own, and is reported rather than made.

use std::path::{Path, PathBuf};

/// The file a skill directory is identified by. The exact name, with no alternatives: the engine's
/// loader matches this string.
pub const SKILL_FILE_NAME: &str = "SKILL.md";

/// The engine's own switch for the `.claude` and `.agents` directories (measured). Set in an
/// engine's environment, it stops that engine reading them at all.
pub const DISABLE_EXTERNAL_SKILLS: &str = "OPENCODE_DISABLE_EXTERNAL_SKILLS";

/// The narrower of the two: set it and `.claude` is skipped while `.agents` is still read.
pub const DISABLE_CLAUDE_CODE_SKILLS: &str = "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS";

/// The widest of the three, and not a skill switch of its own: the pinned bundle's `RuntimeFlags`
/// computes `disableClaudeCodeSkills` as `OPENCODE_DISABLE_CLAUDE_CODE ||
/// OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`, so this one stops the `.claude` scan by covering the whole
/// Claude Code compatibility. Named here because [`launch_switches`] reads a launch's environment
/// and has to recognize it; no caller sets it.
pub const DISABLE_CLAUDE_CODE: &str = "OPENCODE_DISABLE_CLAUDE_CODE";

/// The engine's own limit on a skill's `name` (measured).
pub const MAX_NAME_BYTES: usize = 64;

/// The engine's own limit on a skill's `description` (measured).
pub const MAX_DESCRIPTION_CHARS: usize = 1024;

/// This host's import limit for one file — ours, not the engine's (see the module comment).
pub const MAX_IMPORTED_FILE_BYTES: u64 = 256 * 1024;

/// This host's import limit for a whole skill, and for how many files it may consist of.
pub const MAX_IMPORTED_SKILL_BYTES: u64 = 1024 * 1024;
pub const MAX_IMPORTED_FILES: usize = 256;

/// How many directory entries a scan may visit before it gives up. A scope root is a directory the
/// user pointed at, and a scan that walked a runaway tree would hang the settings page instead of
/// refusing.
pub const MAX_SCAN_ENTRIES: usize = 20_000;

/// Everything this module refuses, one variant per thing a user can do about it.
///
/// The vocabulary is deliberately not a summary: "the importer could not finish" tells a user
/// nothing, while "there is no file at *that* path" and "the name in the frontmatter is not the
/// folder's" are two different next moves. A settings page renders these arm for arm, as it does
/// the registry's refusals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillError {
    /// A scope root, or the store, is a relative path: it would be resolved against this app's own
    /// working directory, which is not where the user meant.
    RelativePath {
        path: PathBuf,
    },
    /// The store lies inside a scope root, so a switched-off skill would still be found. Refused
    /// when the library is built, so no later operation can be a disable that is not one.
    StoreInsideScope {
        path: PathBuf,
        scope: String,
    },
    /// No scope answers to this id.
    UnknownScope {
        scope: String,
    },
    /// The scope is not this host's to write in.
    NotManaged {
        scope: String,
    },
    /// The scope has no per-skill switch; the engine's own variable is the only one there is, when
    /// there is one at all.
    NoSwitch {
        scope: String,
        variable: Option<&'static str>,
    },
    /// The directory an action names is not inside the scope it claims to be in. A stale readout, or
    /// a hand-made request, would otherwise move anything anywhere.
    OutsideScope {
        directory: PathBuf,
        scope: String,
    },
    /// A skill reached through a link that leaves its scope root. The engine would read the target,
    /// so the row exists — as unusable — rather than being quietly dropped.
    EscapesScope {
        directory: PathBuf,
        scope: String,
    },
    /// No such file or directory.
    Missing {
        path: PathBuf,
    },
    /// There is no `SKILL.md` here, so there is nothing the engine would read.
    NoManifest {
        path: PathBuf,
    },
    /// The entry is a symbolic link. Refused on import, where this host is taking custody of a
    /// tree: a link points somewhere that is not part of what is being copied.
    Symlink {
        path: PathBuf,
    },
    /// Something that is neither a file nor a directory.
    NotAFile {
        path: PathBuf,
    },
    /// More files than this host will import at once.
    TooManyFiles {
        count: usize,
    },
    FileTooLarge {
        path: PathBuf,
        bytes: u64,
    },
    SkillTooLarge {
        bytes: u64,
    },
    /// The frontmatter is not there at all, or never closes.
    NoFrontmatter {
        path: PathBuf,
    },
    UnterminatedFrontmatter {
        path: PathBuf,
    },
    /// A line the parser cannot read, named by its line number inside the file.
    FrontmatterLine {
        line: usize,
        message: String,
    },
    /// `name` is absent.
    NameMissing {
        path: PathBuf,
    },
    /// `name` is not lowercase-and-hyphens, or is longer than the engine allows.
    NameShape {
        name: String,
    },
    /// `name` and the folder name disagree. The engine refuses such a skill, so it is reported
    /// rather than renamed in place.
    NameMismatch {
        name: String,
        folder: String,
    },
    /// `description` is absent. The engine drops such a skill silently; this host says so.
    DescriptionMissing {
        path: PathBuf,
    },
    DescriptionTooLong {
        chars: usize,
    },
    /// A field value carries a control character, which no page and no log line can hold.
    FieldControl {
        key: String,
    },
    /// The name is already taken in the target scope, and the import was not told to replace it.
    NameTaken {
        name: String,
        directory: PathBuf,
    },
    /// A copy with this name is already in the store, so moving another in would overwrite the only
    /// recoverable one.
    StoreOccupied {
        path: PathBuf,
    },
    /// The source is already where it would be installed.
    SameDirectory {
        path: PathBuf,
    },
    /// The scan gave up before it finished, so its answer would be a partial one.
    ScanTooLarge {
        root: PathBuf,
    },
    Io {
        path: PathBuf,
        message: String,
    },
}

impl SkillError {
    /// The arm's name, for a boundary that has to carry it as data. Kept beside the enum so an arm
    /// added later without one is a missing `match` arm rather than a silent `unknown`.
    ///
    /// There is deliberately no `Display` impl and no sentence here. The wording belongs to the
    /// settings page, whose copy is keyed by these kinds (T13a's refusal tree), and a second wording
    /// in Rust is a second place for the same refusal to be described differently — which is the
    /// drift `agent-settings-policy.ts` and `agent-registry-policy.ts` each avoid the same way. The
    /// sibling errors in this tree (`ProfileError`, `ConfigError`) have no `Display` for it either;
    /// a message is built where the boundary is, as `commands/agent_settings.rs`'s
    /// `refusal_message` does.
    pub fn kind(&self) -> &'static str {
        match self {
            SkillError::RelativePath { .. } => "relative-path",
            SkillError::StoreInsideScope { .. } => "store-inside-scope",
            SkillError::UnknownScope { .. } => "unknown-scope",
            SkillError::NotManaged { .. } => "not-managed",
            SkillError::NoSwitch { .. } => "no-switch",
            SkillError::OutsideScope { .. } => "outside-scope",
            SkillError::EscapesScope { .. } => "escapes-scope",
            SkillError::Missing { .. } => "missing",
            SkillError::NoManifest { .. } => "no-manifest",
            SkillError::Symlink { .. } => "symlink",
            SkillError::NotAFile { .. } => "not-a-file",
            SkillError::TooManyFiles { .. } => "too-many-files",
            SkillError::FileTooLarge { .. } => "file-too-large",
            SkillError::SkillTooLarge { .. } => "skill-too-large",
            SkillError::NoFrontmatter { .. } => "no-frontmatter",
            SkillError::UnterminatedFrontmatter { .. } => "unterminated-frontmatter",
            SkillError::FrontmatterLine { .. } => "frontmatter-line",
            SkillError::NameMissing { .. } => "name-missing",
            SkillError::NameShape { .. } => "name-shape",
            SkillError::NameMismatch { .. } => "name-mismatch",
            SkillError::DescriptionMissing { .. } => "description-missing",
            SkillError::DescriptionTooLong { .. } => "description-too-long",
            SkillError::FieldControl { .. } => "field-control",
            SkillError::NameTaken { .. } => "name-taken",
            SkillError::StoreOccupied { .. } => "store-occupied",
            SkillError::SameDirectory { .. } => "same-directory",
            SkillError::ScanTooLarge { .. } => "scan-too-large",
            SkillError::Io { .. } => "io",
        }
    }
}

/// The directories this host scans, the store it keeps switched-off skills in, and the operations
/// over both.
///
/// Built once and then read: every operation takes `&self`, so a scan and the action taken on its
/// result cannot be looking at two different configurations. The three modules under this one each
/// add their own `impl` block to it, which is why every method is reachable by one name and none of
/// them can be handed a different scope list than the scan used.
#[derive(Debug)]
pub struct SkillLibrary {
    scopes: Vec<SkillScope>,
    store: PathBuf,
}

impl SkillLibrary {
    /// Build a library, refusing any arrangement in which this host's own store would be scanned.
    ///
    /// That single check is what makes 「禁用真实生效」 structural. The alternative — checking after
    /// each move that the skill is really gone — is a check a later edit can drop, and its failure
    /// mode is a feature that looks switched off and still runs.
    pub fn new(scopes: Vec<SkillScope>, store: impl Into<PathBuf>) -> Result<Self, SkillError> {
        let store = store.into();
        if !store.is_absolute() {
            return Err(SkillError::RelativePath { path: store });
        }
        let resolved_store = resolve(&store);
        for scope in &scopes {
            if !scope.root.is_absolute() {
                return Err(SkillError::RelativePath {
                    path: scope.root.clone(),
                });
            }
            let root = resolve(&scope.root);
            // Both directions: a store inside a root would be scanned, and a root inside the store
            // would put a scope's contents among the switched-off ones.
            if contains(&root, &resolved_store) || contains(&resolved_store, &root) {
                return Err(SkillError::StoreInsideScope {
                    path: store.clone(),
                    scope: scope.id.clone(),
                });
            }
        }
        Ok(Self { scopes, store })
    }

    pub fn scopes(&self) -> &[SkillScope] {
        &self.scopes
    }

    pub fn store(&self) -> &Path {
        &self.store
    }

    fn scope(&self, id: &str) -> Result<&SkillScope, SkillError> {
        self.scopes
            .iter()
            .find(|scope| scope.id == id)
            .ok_or_else(|| SkillError::UnknownScope {
                scope: id.to_string(),
            })
    }

    /// Where the switched-off skills for one scope are kept. Its own parent is created by `stow`.
    fn disabled_root(&self, scope_id: &str) -> PathBuf {
        self.store.join("disabled").join(scope_id)
    }
}
// Declared by path rather than by name, because the same file is reached two ways: normally from
// `agent_runtime/mod.rs`, and by `agent_tests_skills`'s `#[path]` include while this module is not
// in the crate tree yet. A `#[path]`-included file looks for its children in its *own* directory
// rather than in a subdirectory named after it, and an explicit path resolves to the same file under
// both — which is what keeps the test compiled against exactly the tree the library will compile.
#[path = "skills/discover.rs"]
mod discover;
#[path = "skills/import.rs"]
mod import;
#[path = "skills/scope.rs"]
mod scope;

pub use discover::{SkillSurface, SkillView};
pub use import::{Overwrite, SkillImport, SkillPreview};
pub use scope::{launch_switches, opencode_scopes, DisableMechanism, ScopeOwner, SkillScope};

use scope::{contains, resolve};
/// The one place a filesystem error becomes this module's own, so every refusal carries the path it
/// happened at rather than a message that has to be read to find out.
fn io_error(path: &Path, error: std::io::Error) -> SkillError {
    SkillError::Io {
        path: path.to_path_buf(),
        message: error.to_string(),
    }
}
