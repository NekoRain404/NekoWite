//! Taking a folder in, and putting one away.
//!
//! This is the only module in the tree that writes, and §8.2's hard half is here: an import takes
//! content from outside the app and makes it available to something that will execute it. So the
//! two rules that carry the risk are properties of these functions rather than advice beside them:
//!
//! - **Nothing here runs anything.** There is no process, no shell and no `Command` in this file; a
//!   preview is a walk and an import is `fs::copy`. `agent_skills_test.rs` shows that with a payload
//!   that would leave a canary, fired on purpose first so that its absence afterwards means
//!   something.
//! - **A switch is a move.** [`SkillLibrary::set_enabled`] renames a directory out of a scope root
//!   and back into it, and [`stow`] is the only way into the store — which is what lets
//!   `SkillLibrary::new` guarantee that the store lies outside every root, and therefore that a
//!   switched-off skill cannot be found by the next scan. A "disabled" skill that was still
//!   discovered would be worse than one that had never existed, because the user would have been
//!   told it was off.
//!
//! Everything refused here is refused *before* anything is written — the walk is the check — and a
//! failure part-way through a copy removes what it made, so a refused import leaves no half-copied
//! skill directory for the engine to read on its next scan.

use std::fs;
use std::path::{Path, PathBuf};

use super::discover::{folder_name, read_declared, SkillView};
use super::scope::{contains, resolve, DisableMechanism, SkillScope};
use super::{
    io_error, SkillError, SkillLibrary, MAX_IMPORTED_FILES, MAX_IMPORTED_FILE_BYTES,
    MAX_IMPORTED_SKILL_BYTES, SKILL_FILE_NAME,
};

/// What an import would install. Read from the source; written nowhere until the import runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillPreview {
    pub name: String,
    pub description: String,
    /// Every file that would be copied, relative to the skill directory, sorted, with its size.
    pub files: Vec<(String, u64)>,
    /// The subset that is not `SKILL.md` — the scripts and data the engine may later run. §8.2:
    /// 「导入前预览 SKILL.md 与所带脚本」. Nothing was run to produce this list; it is a walk.
    pub scripts: Vec<(String, u64)>,
    pub total_bytes: u64,
}

/// What one import did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillImport {
    pub preview: SkillPreview,
    /// The directory copied into, for the caller to re-read.
    pub installed_at: PathBuf,
    /// Where the skill that was there before this one is kept, when an overwrite was confirmed
    /// (§8.2: 「覆盖必须确认并保留可恢复副本」). `None` is the ordinary first install.
    pub replaced: Option<PathBuf>,
}

/// Whether an existing skill of the same name may be moved aside.
///
/// Not a boolean, because the safe arm has to be the one a caller writes by default: an import that
/// silently replaced a directory the user wrote would be the destructive default §8.2 forbids.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Overwrite {
    /// Refuse with [`SkillError::NameTaken`]. The caller shows the conflict and asks.
    KeepExisting,
    /// Move the existing directory into this host's store first, then install. The copy is kept, so
    /// "replace" is recoverable rather than final.
    Replace,
}

impl SkillLibrary {
    /// The directory an import would install into, when this profile has one.
    ///
    /// The same predicate [`SkillLibrary::import`] refuses on ([`SkillScope::accepts_import`]),
    /// asked as a question rather than as a check — because a settings page has to answer it
    /// *before* a user types a path: the import control is drawn where there is somewhere to
    /// install, and the reason is stated in words where there is not (§5.2). Two spellings of the
    /// rule would come apart in the direction that matters, with a page offering an import the
    /// backend refuses.
    ///
    /// `None` is the ordinary state of a profile reusing the user's own installation: this host
    /// owns no directory in that engine's scope list, so an import there would be a copy into
    /// somebody else's tree.
    pub fn import_target(&self) -> Option<&SkillScope> {
        self.scopes.iter().find(|scope| scope.accepts_import())
    }

    /// Read what an import would install — the frontmatter, every file, and which of them are the
    /// scripts the engine may later run. Nothing is written and nothing runs (see the module
    /// comment); the caller shows this before it asks for a confirmation.
    pub fn preview(&self, source: &Path) -> Result<SkillPreview, SkillError> {
        read_source(source)
    }

    /// Install a skill directory into a managed scope.
    ///
    /// `overwrite` is what makes 「覆盖必须确认」 a decision the caller has to take rather than a
    /// default: [`Overwrite::KeepExisting`] refuses, and [`Overwrite::Replace`] moves the existing
    /// directory into the store before installing, so a replacement is recoverable.
    pub fn import(
        &self,
        source: &Path,
        scope_id: &str,
        overwrite: Overwrite,
    ) -> Result<SkillImport, SkillError> {
        let scope = self.scope(scope_id)?;
        // The rule itself lives on the scope, so the readout that offers an import and this refusal
        // cannot disagree about which directories one may land in.
        if !scope.accepts_import() {
            return Err(SkillError::NotManaged {
                scope: scope_id.to_string(),
            });
        }
        let preview = read_source(source)?;
        let target = scope.root.join(&preview.name);
        if resolve(source) == resolve(&target) {
            return Err(SkillError::SameDirectory {
                path: source.to_path_buf(),
            });
        }
        let mut replaced = None;
        if target.exists() {
            if overwrite == Overwrite::KeepExisting {
                return Err(SkillError::NameTaken {
                    name: preview.name.clone(),
                    directory: target,
                });
            }
            replaced = Some(self.stow(scope_id, "replaced", &target)?);
        }
        fs::create_dir_all(&scope.root).map_err(|error| io_error(&scope.root, error))?;
        if let Err(error) = copy_tree(source, &target, &preview.files) {
            // A half-copied skill is a skill directory the engine would read. Undone here rather
            // than left for a later scan to find.
            let _ = fs::remove_dir_all(&target);
            return Err(error);
        }
        Ok(SkillImport {
            preview,
            installed_at: target,
            replaced,
        })
    }

    /// Switch one skill off, or back on.
    ///
    /// Off is a move out of the scope root into the store; on is the move back. Both directions
    /// refuse a scope whose only switch is the engine's own, because a control that does nothing is
    /// worse than no control at all (§8.2).
    pub fn set_enabled(&self, view: &SkillView, enabled: bool) -> Result<PathBuf, SkillError> {
        let scope = self.scope(&view.scope)?;
        if scope.disable != DisableMechanism::PerSkill {
            return Err(SkillError::NoSwitch {
                scope: view.scope.clone(),
                variable: match scope.disable {
                    DisableMechanism::EngineSwitch { variable } => Some(variable),
                    _ => None,
                },
            });
        }
        // Each direction names the root the directory has to be in *now*, so a view that was read
        // before something else moved the files cannot be used to move a directory out of a scope
        // it was never in.
        let from = if enabled {
            self.disabled_root(&scope.id)
        } else {
            scope.root.clone()
        };
        if !contains(&resolve(&from), &view.directory) {
            return Err(SkillError::OutsideScope {
                directory: view.directory.clone(),
                scope: view.scope.clone(),
            });
        }
        if enabled {
            let target = scope.root.join(&view.name);
            if target.exists() {
                return Err(SkillError::NameTaken {
                    name: view.name.clone(),
                    directory: target,
                });
            }
            fs::create_dir_all(&scope.root).map_err(|error| io_error(&scope.root, error))?;
            fs::rename(&view.directory, &target)
                .map_err(|error| io_error(&view.directory, error))?;
            Ok(target)
        } else {
            self.stow(&scope.id, "disabled", &view.directory)
        }
    }

    /// Move one directory into the store under `bucket`.
    ///
    /// The name is suffixed with the first free number rather than reused: the store holds the only
    /// recoverable copy of whatever is moved in, so a collision must never become an overwrite.
    /// The only way into the store; see this module's comment.
    fn stow(&self, scope_id: &str, bucket: &str, directory: &Path) -> Result<PathBuf, SkillError> {
        let parent = self.store.join(bucket).join(scope_id);
        fs::create_dir_all(&parent).map_err(|error| io_error(&parent, error))?;
        let name = folder_name(directory);
        for attempt in 0..1000 {
            let candidate = parent.join(format!("{name}-{attempt}"));
            if candidate.exists() {
                continue;
            }
            fs::rename(directory, &candidate).map_err(|error| io_error(directory, error))?;
            return Ok(candidate);
        }
        Err(SkillError::StoreOccupied { path: parent })
    }
}

/// Read a source directory into a preview: the checks and the file list an import would write.
///
/// Every refusal here is one §8.2 names — a link that leaves the tree, a size ceiling, a name that
/// is not the folder's. The walk *is* the check: nothing is resolved lazily at copy time, because a
/// path that was safe when it was listed and is not when it is read is the race this closes.
fn read_source(source: &Path) -> Result<SkillPreview, SkillError> {
    let metadata = fs::symlink_metadata(source).map_err(|_| SkillError::Missing {
        path: source.to_path_buf(),
    })?;
    if metadata.is_symlink() {
        return Err(SkillError::Symlink {
            path: source.to_path_buf(),
        });
    }
    if !metadata.is_dir() {
        return Err(SkillError::NoManifest {
            path: source.to_path_buf(),
        });
    }
    let manifest = source.join(SKILL_FILE_NAME);
    if !manifest.is_file() {
        return Err(SkillError::NoManifest {
            path: source.to_path_buf(),
        });
    }
    let declared = read_declared(&manifest)?;
    let folder = folder_name(source);
    if declared.name != folder {
        return Err(SkillError::NameMismatch {
            name: declared.name,
            folder,
        });
    }
    let description = match declared.description {
        Some(description) => description,
        // An import is the wrong moment to install something the engine will never surface: the
        // user would be told it was added and never see it work.
        None => {
            return Err(SkillError::DescriptionMissing { path: manifest });
        }
    };
    let mut files = Vec::new();
    let mut scripts = Vec::new();
    let mut total_bytes = 0_u64;
    for relative in walk_files(source)? {
        let full = source.join(&relative);
        let size = fs::symlink_metadata(&full)
            .map_err(|error| io_error(&full, error))?
            .len();
        if size > MAX_IMPORTED_FILE_BYTES {
            return Err(SkillError::FileTooLarge {
                path: full,
                bytes: size,
            });
        }
        if files.len() >= MAX_IMPORTED_FILES {
            return Err(SkillError::TooManyFiles {
                count: files.len() + 1,
            });
        }
        total_bytes += size;
        if total_bytes > MAX_IMPORTED_SKILL_BYTES {
            return Err(SkillError::SkillTooLarge { bytes: total_bytes });
        }
        if relative != SKILL_FILE_NAME {
            scripts.push((relative.clone(), size));
        }
        files.push((relative, size));
    }
    Ok(SkillPreview {
        name: declared.name,
        description,
        files,
        scripts,
        total_bytes,
    })
}

/// Every file under `root`, relative to it, sorted.
///
/// A symbolic link is refused rather than followed: an import takes custody of a tree, and a link is
/// a pointer at something outside it. That is §8.2's 符号链接逃逸 check, and it is deliberately
/// stricter than the engine's own scan — the engine is reading, this host is writing a copy.
fn walk_files(root: &Path) -> Result<Vec<String>, SkillError> {
    let mut files = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((directory, prefix)) = stack.pop() {
        let entries = fs::read_dir(&directory).map_err(|error| io_error(&directory, error))?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let relative = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let metadata = fs::symlink_metadata(&path).map_err(|error| io_error(&path, error))?;
            if metadata.is_symlink() {
                return Err(SkillError::Symlink { path });
            }
            if metadata.is_dir() {
                stack.push((path, relative));
            } else if metadata.is_file() {
                files.push(relative);
            } else {
                return Err(SkillError::NotAFile { path });
            }
        }
    }
    files.sort();
    Ok(files)
}

/// Copy a listed set of files, creating directories as needed.
///
/// Permissions are copied with the bytes (`fs::copy` does that), deliberately. Clearing an
/// executable bit would not make anything safer — a shell runs a script whether or not it is marked
/// executable — and a settings page that appeared to harden a skill by copying it would be §3.4.4's
/// 「注册不等于沙箱」 told backwards.
fn copy_tree(source: &Path, target: &Path, files: &[(String, u64)]) -> Result<(), SkillError> {
    for (relative, _) in files {
        let from = source.join(relative);
        let to = target.join(relative);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
        }
        fs::copy(&from, &to).map_err(|error| io_error(&from, error))?;
    }
    Ok(())
}
