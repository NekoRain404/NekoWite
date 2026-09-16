//! Reading what is on disk: which directories hold a skill, what its `SKILL.md` declares, and what
//! the engine would therefore do with it.
//!
//! Nothing in this module writes. That is not a coincidence of what it happens to need — it is the
//! line between this module and [`super::import`], and it is what makes "reading a skill must not
//! run it" true here by construction rather than by care. A scan that cannot write cannot leave a
//! trace of what it read.
//!
//! Two rejections are deliberate and worth finding here rather than in a bug report. A skill whose
//! frontmatter cannot be used is *kept* in the list with the reason in its surface, because one that
//! vanished is one its user cannot repair. And the frontmatter parser refuses a line it cannot read
//! *with its number* rather than skipping it: guessing would put a value in a field the user did not
//! write, and the engine would then be indexing a skill by a name nobody typed.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::scope::{contains, resolve, DisableMechanism, ScopeOwner, SkillScope};
use super::{
    io_error, SkillError, SkillLibrary, MAX_DESCRIPTION_CHARS, MAX_NAME_BYTES,
    MAX_SCAN_ENTRIES, SKILL_FILE_NAME,
};

/// What a `SKILL.md` declares. Only the keys this app reads; `license`, `compatibility` and
/// `metadata` are the engine's business and are neither validated nor kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Declared {
    pub(super) name: String,
    pub(super) description: Option<String>,
}

/// What the engine will do with a discovered skill, as far as a scan and its frontmatter can say.
///
/// Every arm is something the page has to be able to draw, including the two that mean "found and
/// does nothing": a skill that vanished from the list because it could not be read is a skill its
/// user cannot repair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillSurface {
    /// Read, described, and offered to the model.
    Offered,
    /// No `description`, so the engine filters it out and never surfaces it (measured). The skill is
    /// installed and inert, which is a state worth saying out loud.
    Undescribed,
    /// The engine's own switch is set for this scope, so it is not reading the directory at all.
    Suppressed { variable: &'static str },
    /// Its frontmatter or its location cannot be used, and the error says which.
    Unusable { error: SkillError },
    /// This host moved it out of every scope root; the bytes are in the store until it is switched
    /// back on.
    Disabled,
}

/// One skill as a settings page reads it: facts, and no claim beyond what a scan proves.
#[derive(Debug, Clone)]
pub struct SkillView {
    /// The frontmatter name. The engine indexes by this, not by the folder — which is why the two
    /// are required to match and a mismatch is `Unusable`, never a silent rename.
    pub name: String,
    pub description: Option<String>,
    /// Where the `SKILL.md` is.
    pub directory: PathBuf,
    pub scope: String,
    pub scope_label: String,
    pub owner: ScopeOwner,
    /// Every other directory that defines this name. Never a "winner" — see the module comment
    /// for what was observed of this version.
    pub conflicts: Vec<PathBuf>,
    pub surface: SkillSurface,
    /// The engine's switch that is on for this row's scope, if one is: the **scope's** state,
    /// carried beside [`SkillSurface`] rather than read out of it.
    ///
    /// A page asks two questions a row answers differently — "would the engine use this skill" and
    /// "is this directory read at all" — and they come apart exactly where it matters: a skill
    /// whose frontmatter is broken is [`SkillSurface::Unusable`], which says nothing about whether
    /// the scope is read, and a page inferring suppression from the surface would then tell the
    /// user the launch does not set a switch that it does. Two facts, two fields.
    pub suppressed_by: Option<&'static str>,
    pub disable: DisableMechanism,
}

impl SkillLibrary {
    /// Every skill the engine would find, across every scope, sorted by name then directory.
    ///
    /// A scope root that is not there is skipped rather than reported: a project with no
    /// `.opencode` is the ordinary case, not a fault. A skill that cannot be read is *kept* in the
    /// list with the reason in its surface, because one that vanished is one its user cannot fix.
    pub fn discover(&self) -> Result<Vec<SkillView>, SkillError> {
        let mut found: Vec<SkillView> = Vec::new();
        let mut seen: Vec<(String, PathBuf)> = Vec::new();
        for scope in &self.scopes {
            for directory in walk_for_manifests(&scope.root)? {
                found.push(describe(scope, &directory, &mut seen));
            }
        }
        // Conflicts are filled in after every scope has been read, so a name defined in a scope
        // scanned first also sees the copies that come later.
        for view in &mut found {
            view.conflicts = seen
                .iter()
                .filter(|(name, directory)| name == &view.name && directory != &view.directory)
                .map(|(_, directory)| directory.clone())
                .collect();
        }
        found.sort_by(|left, right| {
            left.name
                .cmp(&right.name)
                .then_with(|| left.directory.cmp(&right.directory))
        });
        Ok(found)
    }

    /// Every skill this host has switched off, in the store, sorted by name.
    pub fn disabled(&self) -> Result<Vec<SkillView>, SkillError> {
        let mut found = Vec::new();
        for scope in &self.scopes {
            let root = self.disabled_root(&scope.id);
            for directory in walk_for_manifests(&root)? {
                let manifest = directory.join(SKILL_FILE_NAME);
                // The folder in the store carries the store's own suffix, so it is never compared
                // with the name: what the frontmatter says is the skill's identity.
                let (name, description) = match read_declared(&manifest) {
                    Ok(declared) => (declared.name, declared.description),
                    Err(_) => (folder_name(&directory), None),
                };
                found.push(SkillView {
                    name,
                    description,
                    directory,
                    scope: scope.id.clone(),
                    scope_label: scope.label.clone(),
                    owner: scope.owner,
                    conflicts: Vec::new(),
                    surface: SkillSurface::Disabled,
                    suppressed_by: scope.suppressed_by,
                    disable: scope.disable,
                });
            }
        }
        found.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(found)
    }

}

/// One discovered directory, as a view. `seen` accumulates the names found so the caller can fill
/// in conflicts once every scope has been read.
fn describe(scope: &SkillScope, directory: &Path, seen: &mut Vec<(String, PathBuf)>) -> SkillView {
    let folder = folder_name(directory);
    // The two ways a directory can be unusable before its frontmatter matters. A link whose target
    // leaves the scope is one: the engine would read the target, so the row has to exist for the
    // user to be able to move the link out — but nothing here will claim it is this scope's content.
    let located = if contains(&resolve(&scope.root), &resolve(directory)) {
        None
    } else {
        Some(SkillError::EscapesScope {
            directory: directory.to_path_buf(),
            scope: scope.id.clone(),
        })
    };
    let read = read_declared(&directory.join(SKILL_FILE_NAME));
    let (name, description, declared) = match read {
        Ok(declared) => {
            let problem = if declared.name == folder {
                None
            } else {
                Some(SkillError::NameMismatch {
                    name: declared.name.clone(),
                    folder: folder.clone(),
                })
            };
            (declared.name.clone(), declared.description.clone(), problem)
        }
        Err(error) => (folder, None, Some(error)),
    };
    let surface = match located.or(declared) {
        Some(error) => SkillSurface::Unusable { error },
        None => match scope.suppressed_by {
            Some(variable) => SkillSurface::Suppressed { variable },
            None if description.is_none() => SkillSurface::Undescribed,
            None => SkillSurface::Offered,
        },
    };
    seen.push((name.clone(), directory.to_path_buf()));
    SkillView {
        name,
        description,
        directory: directory.to_path_buf(),
        scope: scope.id.clone(),
        scope_label: scope.label.clone(),
        owner: scope.owner,
        conflicts: Vec::new(),
        surface,
        suppressed_by: scope.suppressed_by,
        disable: scope.disable,
    }
}

/// The name of the folder a skill is in. Used where a skill cannot be read — the row still has to
/// be called something its user recognises — and never as an identity when the frontmatter parses.
pub(super) fn folder_name(directory: &Path) -> String {
    directory
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Read and validate a `SKILL.md`, without asking whether its name matches its folder: that is the
/// caller's question, because a skill in the store is deliberately not in a folder of its own name.
pub(super) fn read_declared(path: &Path) -> Result<Declared, SkillError> {
    if !path.is_file() {
        return Err(SkillError::NoManifest {
            path: path.to_path_buf(),
        });
    }
    let text = fs::read_to_string(path).map_err(|error| io_error(path, error))?;
    let fields = parse_frontmatter(&text, path)?;
    let name = match fields.get("name") {
        Some(name) => name.clone(),
        None => {
            return Err(SkillError::NameMissing {
                path: path.to_path_buf(),
            })
        }
    };
    validate_name(&name)?;
    let description = fields.get("description").cloned();
    if let Some(description) = &description {
        if description.chars().count() > MAX_DESCRIPTION_CHARS {
            return Err(SkillError::DescriptionTooLong {
                chars: description.chars().count(),
            });
        }
    }
    Ok(Declared { name, description })
}

/// The engine's reading of a skill name: lowercase words joined by hyphens, no longer than its
/// limit. Stated as this app's reading of that rule rather than as the loader's own regex, which is
/// not a thing this host has seen.
fn validate_name(name: &str) -> Result<(), SkillError> {
    let shape = !name.is_empty()
        && name.len() <= MAX_NAME_BYTES
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        });
    if shape {
        Ok(())
    } else {
        Err(SkillError::NameShape {
            name: name.to_string(),
        })
    }
}

/// The frontmatter, as the subset the engine's own documentation specifies: one unindented
/// `key: value` per line between two `---` lines.
///
/// An indented line belongs to a nested block (`metadata` is a map) and is *skipped* rather than
/// refused, which is what keeps a nested `name:` from being read as the skill's own. A line that is
/// neither an unindented pair nor indented is refused with its number: guessing at it would put a
/// value in a field the user did not write.
fn parse_frontmatter(text: &str, path: &Path) -> Result<BTreeMap<String, String>, SkillError> {
    let mut lines = text.lines().enumerate();
    match lines.next() {
        Some((_, first)) if first.trim_end() == "---" => {}
        _ => {
            return Err(SkillError::NoFrontmatter {
                path: path.to_path_buf(),
            })
        }
    }
    let mut fields = BTreeMap::new();
    for (index, line) in lines {
        if line.trim_end() == "---" {
            return Ok(fields);
        }
        if line.starts_with(' ') || line.starts_with('\t') || line.trim_end().is_empty() {
            continue;
        }
        let trimmed = line.trim_end();
        let Some((key, value)) = trimmed.split_once(':') else {
            return Err(SkillError::FrontmatterLine {
                line: index + 1,
                message: "expected `key: value`".to_string(),
            });
        };
        let key = key.trim();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(SkillError::FrontmatterLine {
                line: index + 1,
                message: "the key is not a name this app can read".to_string(),
            });
        }
        let value = unquote(value.trim());
        if value.chars().any(char::is_control) {
            return Err(SkillError::FieldControl {
                key: key.to_string(),
            });
        }
        fields.insert(key.to_string(), value);
    }
    Err(SkillError::UnterminatedFrontmatter {
        path: path.to_path_buf(),
    })
}

/// One pair of surrounding quotes is a quoting style, not part of the value.
fn unquote(value: &str) -> String {
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

/// Every directory under `root` that contains a `SKILL.md`, sorted. The engine's globs are
/// recursive (`**\/SKILL.md`), so this is too.
fn walk_for_manifests(root: &Path) -> Result<Vec<PathBuf>, SkillError> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut found = Vec::new();
    // A link that points back up the tree would walk forever; the set of directories already
    // entered is what stops it. The scan follows links, as the engine does, and a skill that
    // resolves outside its scope is reported as such by `describe` rather than hidden.
    let mut seen: Vec<PathBuf> = vec![resolve(root)];
    let mut stack = vec![root.to_path_buf()];
    let mut visited = 0_usize;
    while let Some(directory) = stack.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_SCAN_ENTRIES {
                return Err(SkillError::ScanTooLarge {
                    root: root.to_path_buf(),
                });
            }
            if entry.file_name().to_string_lossy() == SKILL_FILE_NAME {
                found.push(directory.clone());
                continue;
            }
            let path = entry.path();
            if path.is_dir() && !seen.contains(&resolve(&path)) {
                seen.push(resolve(&path));
                stack.push(path);
            }
        }
    }
    found.sort();
    Ok(found)
}
