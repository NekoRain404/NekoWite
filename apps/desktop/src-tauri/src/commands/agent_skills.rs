//! The skills IPC surface: the four calls the settings page's Skills section makes.
//!
//! §8.2 is that section's brief and `agent_runtime::skills` is where its rules live — this file is
//! the other half of §6.1's boundary: the wire shapes, and the decisions a *request* may not make.
//!
//!  - **A window does not name a directory.** `agent_skills_set_enabled` takes a scope id and a
//!    name, never the path a row showed — the path is what an action would move, and a renderer
//!    that could name one is a renderer that could move anything anywhere. The library re-reads the
//!    disk instead (`SkillLibrary::view_of`) and refuses a name that is no longer there.
//!  - **A window does not name a profile root.** The roots the scope list is built from come off
//!    the profile this backend opened, and the engine switches that decide `suppressed_by` come
//!    from the very environment the launch is given (`process::isolated_profile_env`), never from a
//!    list somebody remembered to keep in step.
//!  - **The project scope is not in the list.** `opencode_scopes_without_project` says why: it
//!    needs a project, this dialog has none, and a page listing a project it does not know would be
//!    listing a directory nobody opened. The page states that scope and its reason in words
//!    instead (§5.2).
//!
//! Two failure channels, kept apart as everywhere else in this tree. A **refusal** is data: the
//! `SkillError` arm plus the facts its sentence carries, which the page renders through its own
//! copy tree. A **rejection** is the call not completing at all — the profile could not be opened
//! for this (engine, profile) pair — which the page answers with its unreadable state and a retry.
//! No refusal carries a sentence from here: `skills.rs` has no `Display` for exactly this reason,
//! and a second wording in Rust would be a second place for one refusal to be described
//! differently.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::State;

use crate::agent_runtime::isolated_profile_env;
use crate::agent_runtime::profile::{ConfigMode, Profile, ProfileStore};
use crate::agent_runtime::skills::{
    opencode_scopes_without_project, DisableMechanism, Overwrite, ScopeOwner, SkillError,
    SkillLibrary, SkillPreview, SkillScope, SkillSurface, SkillView, MANAGED_SCOPE_ID,
};
use crate::commands::agent_settings::{refusal_message, AgentSettingsState};

/// Where this host keeps the skills it has switched off, inside a profile root.
///
/// Beside the record rather than under any of the engine's own roots, and that placement is the
/// whole of what makes 「禁用真实生效」 true: every scope root this page has is built out of `HOME`
/// or `XDG_CONFIG_HOME` *inside this same profile root*, and [`SkillLibrary::new`] refuses a store
/// that lies inside any scope root. A store moved under `XDG_CONFIG_HOME` would be refused rather
/// than quietly scanned back as a skill — and in a profile that reuses the user's installation it
/// is the only directory in the set this host owns at all.
const SKILL_STORE: &str = "skills-store";

/// The roots and the environment one profile's engine is launched with: the two inputs the scope
/// list is built from.
///
/// Derived from the same call the launch itself is built from, the way `Profile::sources` derives
/// the injected roots for the page that lists them — a readout and a launch that spelled their
/// roots separately are two answers waiting to differ, and the difference would be a page telling a
/// user which directories the engine reads while it reads others.
struct Roots {
    /// The engine's global configuration root, or `None` for a profile reusing the user's own
    /// installation. `None` is how `opencode_scopes` is told "there is no directory this host may
    /// point at" rather than being smoothed into a path that happens to exist.
    config_root: Option<PathBuf>,
    home: PathBuf,
    /// What this host puts in the launch's environment, and nothing at all for a profile it does
    /// not isolate. `launch_switches` reads the engine's own variables out of this, which is what
    /// makes a scope's `suppressed_by` a fact about the launch rather than a guess from a
    /// directory.
    env: Vec<(String, String)>,
}

impl Roots {
    fn of(profile: &Profile) -> Self {
        match profile.mode() {
            ConfigMode::AppManaged => {
                let env = isolated_profile_env(profile.root());
                let at = |name: &str| {
                    env.iter()
                        .find(|(variable, _)| variable == name)
                        .map(|(_, value)| PathBuf::from(value))
                };
                Self {
                    config_root: at("XDG_CONFIG_HOME"),
                    home: at("HOME").unwrap_or_default(),
                    env,
                }
            }
            ConfigMode::UserConfig => Self {
                config_root: None,
                home: user_home(),
                env: Vec::new(),
            },
        }
    }
}

/// The machine's own home directory, for the profile mode that reads it.
///
/// An engine launched against a profile this host does not isolate resolves `.claude` and `.agents`
/// under its own `$HOME`, which is this process's. An unset `HOME` is left as the empty path rather
/// than smoothed into a directory this host invented: [`SkillLibrary::new`] refuses a root that is
/// not absolute, so that environment is answered with the refusal that says so.
fn user_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// Why a call could not reach a library, in the two channels the page keeps apart.
enum Unbuilt {
    /// The call did not complete: the profile could not be opened for this pair. The page's
    /// unreadable state is the answer to this — never "no skills are installed", which is a claim
    /// about the engine rather than about the connection.
    Rejected(String),
    /// The backend refused the arrangement itself: a store that lies inside a scope root, a root
    /// that is not absolute. Data, rendered by the page's copy tree.
    Refused(SkillError),
}

impl Unbuilt {
    /// A refusal is data; a rejection is an `Err`. Nothing here turns one into the other.
    fn answer(self) -> Result<Value, String> {
        match self {
            Unbuilt::Rejected(message) => Err(message),
            Unbuilt::Refused(error) => Ok(refusal_view(&error)),
        }
    }
}

/// The library every call in this file works on: the profile opened for this pair, the roots its
/// engine is launched with, and this host's store for the skills it has switched off.
///
/// No project is passed. This surface belongs to the settings dialog, which is not about a folder:
/// §5.2 is why the page states the project scope in words rather than this function inventing a
/// path for one.
fn library(
    store: &ProfileStore,
    agent_id: &str,
    profile_id: &str,
) -> Result<SkillLibrary, Unbuilt> {
    let profile = store
        .open(agent_id, profile_id)
        .map_err(|error| Unbuilt::Rejected(refusal_message(&error)))?;
    let roots = Roots::of(&profile);
    let scopes = opencode_scopes_without_project(
        roots.config_root.as_deref(),
        &roots.home,
        // The engine's `skills.paths`, which this host does not read: the document is JSONC and
        // belongs to `config_edit`, and a second parser here would be a second answer about the
        // same file. The page states that omission in words. See `agent_skills_read`'s page.
        &[],
        &roots.env,
    );
    SkillLibrary::new(scopes, profile.root().join(SKILL_STORE)).map_err(Unbuilt::Refused)
}

/// What the settings page reads: the scopes the engine's rules name, what it finds in them, what
/// this host has switched off, and the directory an import would land in.
pub fn read_skills(
    store: &ProfileStore,
    agent_id: &str,
    profile_id: &str,
) -> Result<Value, String> {
    let library = match library(store, agent_id, profile_id) {
        Ok(library) => library,
        Err(unbuilt) => return unbuilt.answer(),
    };
    match readout(&library) {
        Ok(readout) => Ok(readout),
        // A scan that gave up is a refusal and not a rejection: the backend answered, and what it
        // says is about a directory rather than about the connection.
        Err(error) => Ok(refusal_view(&error)),
    }
}

/// What an import would install — read from the folder, written nowhere, and run nowhere.
pub fn preview_skill(
    store: &ProfileStore,
    agent_id: &str,
    profile_id: &str,
    source: &str,
) -> Result<Value, String> {
    let library = match library(store, agent_id, profile_id) {
        Ok(library) => library,
        Err(unbuilt) => return unbuilt.answer(),
    };
    match library.preview(Path::new(source)) {
        Ok(preview) => Ok(preview_view(&preview)),
        Err(error) => Ok(refusal_view(&error)),
    }
}

/// Installs a folder into the one directory this host may write in.
///
/// `replace` is the caller's confirmation, and the safe arm is the default: without it an existing
/// skill of the same name is refused as `name-taken` and the page draws the conflict beside a
/// second, deliberate control. With it the existing directory is moved into this host's store
/// *first*, so a replacement is recoverable rather than final (§8.2's 「覆盖必须确认并保留可恢复
/// 副本」).
pub fn import_skill(
    store: &ProfileStore,
    agent_id: &str,
    profile_id: &str,
    source: &str,
    replace: bool,
) -> Result<Value, String> {
    let library = match library(store, agent_id, profile_id) {
        Ok(library) => library,
        Err(unbuilt) => return unbuilt.answer(),
    };
    let Some(target) = library.import_target() else {
        // No directory here is this host's to write in — the ordinary state of a profile reusing
        // the user's own installation. Refused rather than answered with a directory that was never
        // this app's.
        return Ok(refusal_view(&SkillError::NotManaged {
            scope: MANAGED_SCOPE_ID.to_string(),
        }));
    };
    let scope = target.id.clone();
    let overwrite = if replace {
        Overwrite::Replace
    } else {
        Overwrite::KeepExisting
    };
    match library.import(Path::new(source), &scope, overwrite) {
        // The page re-reads after an import, so there is nothing to hand back here: `null` is this
        // call's accepted arm, and what changed is the readout's to report.
        Ok(_) => Ok(Value::Null),
        Err(error) => Ok(refusal_view(&error)),
    }
}

/// Switches one skill off, or back on — as a move out of (or into) the directory the engine reads,
/// never as a row this page hides (§8.2's 「不能仅隐藏 UI 项目而声称已禁用」).
///
/// The subject is a (scope, name) pair rather than the directory a row showed. What that pair
/// resolves to is re-read here, and a name that is gone is refused as `no-such-skill`.
pub fn set_skill_enabled(
    store: &ProfileStore,
    agent_id: &str,
    profile_id: &str,
    name: &str,
    scope: &str,
    enabled: bool,
) -> Result<Value, String> {
    let library = match library(store, agent_id, profile_id) {
        Ok(library) => library,
        Err(unbuilt) => return unbuilt.answer(),
    };
    match library
        .view_of(scope, name)
        .and_then(|view| library.set_enabled(&view, enabled))
    {
        Ok(_) => Ok(Value::Null),
        Err(error) => Ok(refusal_view(&error)),
    }
}

/// The two lists and the scope table, as one answer.
///
/// One read rather than three commands, because the three are one question: a page that asked for
/// the scopes separately could draw headings for a configuration the rows were not scanned under.
fn readout(library: &SkillLibrary) -> Result<Value, SkillError> {
    let skills = library.discover()?;
    let disabled = library.disabled()?;
    Ok(json!({
        "scopes": library.scopes().iter().map(scope_view).collect::<Vec<_>>(),
        "skills": skills.iter().map(skill_view).collect::<Vec<_>>(),
        "disabled": disabled.iter().map(skill_view).collect::<Vec<_>>(),
        // Where an import would go, named as an id into the list above — or `null` when there is
        // nowhere, which is what tells the page to state the reason instead of drawing the form.
        "importScope": library.import_target().map(|scope| scope.id.as_str()),
    }))
}

/// One scope, as the page's headings and its per-scope empty sentences read it.
fn scope_view(scope: &SkillScope) -> Value {
    json!({
        "id": scope.id,
        "label": scope.label,
        "root": scope.root.to_string_lossy(),
        // The scope's own state, beside its contents: "no skills in this directory" and "this
        // launch is not reading it" are two different answers, and only one of them is about the
        // skills.
        "suppressedBy": scope.suppressed_by,
    })
}

/// One skill, as a row.
fn skill_view(view: &SkillView) -> Value {
    json!({
        "name": view.name,
        "description": view.description,
        "directory": view.directory.to_string_lossy(),
        "scope": view.scope,
        "scopeLabel": view.scope_label,
        "owner": owner_id(view.owner),
        "conflicts": view
            .conflicts
            .iter()
            .map(|directory| directory.to_string_lossy())
            .collect::<Vec<_>>(),
        "surface": surface_view(&view.surface),
        "suppressedBy": view.suppressed_by,
        "disable": disable_view(view.disable),
    })
}

/// What the engine will do with a skill, in the page's own five arms.
fn surface_view(surface: &SkillSurface) -> Value {
    match surface {
        SkillSurface::Offered => json!({ "kind": "offered" }),
        SkillSurface::Undescribed => json!({ "kind": "undescribed" }),
        SkillSurface::Suppressed { variable } => {
            json!({ "kind": "suppressed", "variable": variable })
        }
        // The row's own refusal, nested: the page renders it through the same sentence table,
        // because "this skill cannot be used" and "this action was refused" are the same vocabulary
        // and lead to the same next moves.
        SkillSurface::Unusable { error } => {
            json!({ "kind": "unusable", "error": refusal_view(error) })
        }
        SkillSurface::Disabled => json!({ "kind": "disabled" }),
    }
}

/// How a directory's contents can be switched off, as `skills.rs` reports it.
fn disable_view(disable: DisableMechanism) -> Value {
    match disable {
        DisableMechanism::PerSkill => json!({ "kind": "per-skill" }),
        DisableMechanism::EngineSwitch { variable } => {
            json!({ "kind": "engine-switch", "variable": variable })
        }
        DisableMechanism::None => json!({ "kind": "none" }),
    }
}

fn owner_id(owner: ScopeOwner) -> &'static str {
    match owner {
        ScopeOwner::Managed => "managed",
        ScopeOwner::Engine => "engine",
        ScopeOwner::Foreign => "foreign",
    }
}

/// What an import would install, as the confirmation step reads it.
fn preview_view(preview: &SkillPreview) -> Value {
    let files = |list: &[(String, u64)]| {
        list.iter()
            .map(|(path, bytes)| json!({ "path": path, "bytes": bytes }))
            .collect::<Vec<_>>()
    };
    json!({
        "name": preview.name,
        "description": preview.description,
        "files": files(&preview.files),
        // The subset the engine may later run. Nothing was executed to produce it — it is a walk —
        // and the page says so where it lists them.
        "scripts": files(&preview.scripts),
        "totalBytes": preview.total_bytes,
    })
}

/// One refusal, as the page's copy tree reads it: the kind, plus the facts its sentence carries.
///
/// Written out per arm rather than derived from the Rust enum, for the reason `profile_view` gives
/// one module over — the shape a renderer sees is one somebody chose. The key names below are the
/// slot names the catalogue's sentences interpolate (`{path}`, `{name}`, `{message}`, `{folder}`,
/// `{directory}`), and the page fills them from these values, so a key that drifted would render
/// its sentence with a hole in it. An arm added to `SkillError` fails to compile here until
/// somebody decides what the page is told about it.
pub fn refusal_view(error: &SkillError) -> Value {
    let kind = error.kind();
    match error {
        SkillError::RelativePath { path } => json!({ "kind": kind, "path": path }),
        SkillError::StoreInsideScope { path, scope } => {
            json!({ "kind": kind, "path": path, "scope": scope })
        }
        SkillError::UnknownScope { scope } => json!({ "kind": kind, "scope": scope }),
        SkillError::NotManaged { scope } => json!({ "kind": kind, "scope": scope }),
        SkillError::NoSwitch { scope, variable } => {
            json!({ "kind": kind, "scope": scope, "variable": variable })
        }
        SkillError::OutsideScope { directory, scope } => {
            json!({ "kind": kind, "directory": directory, "scope": scope })
        }
        SkillError::EscapesScope { directory, scope } => {
            json!({ "kind": kind, "directory": directory, "scope": scope })
        }
        SkillError::Missing { path } => json!({ "kind": kind, "path": path }),
        SkillError::NoManifest { path } => json!({ "kind": kind, "path": path }),
        SkillError::Symlink { path } => json!({ "kind": kind, "path": path }),
        SkillError::NotAFile { path } => json!({ "kind": kind, "path": path }),
        SkillError::TooManyFiles { count } => json!({ "kind": kind, "count": count }),
        SkillError::FileTooLarge { path, bytes } => {
            json!({ "kind": kind, "path": path, "bytes": bytes })
        }
        SkillError::SkillTooLarge { bytes } => json!({ "kind": kind, "bytes": bytes }),
        SkillError::NoFrontmatter { path } => json!({ "kind": kind, "path": path }),
        SkillError::UnterminatedFrontmatter { path } => json!({ "kind": kind, "path": path }),
        SkillError::FrontmatterLine { line, message } => {
            json!({ "kind": kind, "line": line, "message": message })
        }
        SkillError::NameMissing { path } => json!({ "kind": kind, "path": path }),
        SkillError::NameShape { name } => json!({ "kind": kind, "name": name }),
        SkillError::NameMismatch { name, folder } => {
            json!({ "kind": kind, "name": name, "folder": folder })
        }
        SkillError::DescriptionMissing { path } => json!({ "kind": kind, "path": path }),
        SkillError::DescriptionTooLong { chars } => json!({ "kind": kind, "chars": chars }),
        SkillError::FieldControl { key } => json!({ "kind": kind, "key": key }),
        SkillError::NameTaken { name, directory } => {
            json!({ "kind": kind, "name": name, "directory": directory })
        }
        SkillError::NoSuchSkill { name, scope } => {
            json!({ "kind": kind, "name": name, "scope": scope })
        }
        SkillError::StoreOccupied { path } => json!({ "kind": kind, "path": path }),
        SkillError::SameDirectory { path } => json!({ "kind": kind, "path": path }),
        SkillError::ScanTooLarge { root } => json!({ "kind": kind, "root": root }),
        SkillError::Io { path, message } => {
            json!({ "kind": kind, "path": path, "message": message })
        }
    }
}

// ---------------------------------------------------------------------------
// The four commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn agent_skills_read(
    state: State<'_, AgentSettingsState>,
    agent_id: String,
    profile_id: String,
) -> Result<Value, String> {
    read_skills(&state.store, &agent_id, &profile_id)
}

#[tauri::command]
pub fn agent_skills_preview(
    state: State<'_, AgentSettingsState>,
    agent_id: String,
    profile_id: String,
    source: String,
) -> Result<Value, String> {
    preview_skill(&state.store, &agent_id, &profile_id, &source)
}

#[tauri::command]
pub fn agent_skills_import(
    state: State<'_, AgentSettingsState>,
    agent_id: String,
    profile_id: String,
    source: String,
    replace: bool,
) -> Result<Value, String> {
    import_skill(&state.store, &agent_id, &profile_id, &source, replace)
}

#[tauri::command]
pub fn agent_skills_set_enabled(
    state: State<'_, AgentSettingsState>,
    agent_id: String,
    profile_id: String,
    name: String,
    scope: String,
    enabled: bool,
) -> Result<Value, String> {
    set_skill_enabled(&state.store, &agent_id, &profile_id, &name, &scope, enabled)
}
