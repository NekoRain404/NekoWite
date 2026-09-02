use serde::Serialize;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_mdx: bool,
}

pub fn is_mdx_path(p: &str) -> bool {
    let path = Path::new(p);
    let has_node_modules = path
        .components()
        .any(|c| c.as_os_str() == "node_modules");
    if has_node_modules {
        return false;
    }
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("mdx") | Some("md") | Some("markdown")
    )
}

/// Decide whether an entry should be hidden from listings: hidden files and
/// dirs (name starts with `.`), build output directories (exact dir name),
/// and symlinks. Files whose name merely carries a build-dir prefix (e.g.
/// `dist.md`) are kept — only the exact directory name matches.
pub fn should_skip_entry(name: &str, is_symlink: bool) -> bool {
    if is_symlink {
        return true;
    }
    if name.starts_with('.') {
        return true;
    }
    matches!(name, "node_modules" | "dist" | "build" | "target" | "out")
}

/// Legacy relative-only guard, kept for callers that work purely on
/// vault-relative names. Absolute paths are handled by [`resolve_within`].
pub fn sanitize_path(p: &str) -> Result<PathBuf, String> {
    let path = Path::new(p);
    if path.is_absolute() || path.components().any(|c| c.as_os_str() == "..") {
        return Err("path escapes workspace".into());
    }
    Ok(path.to_path_buf())
}

/// Resolve `requested` against the vault `base` and prove the result stays
/// inside the vault.
///
/// Both the absolute vault root (as returned by the folder dialog) and
/// vault-relative paths (e.g. `"."` or `"docs/hello.mdx"`) are accepted;
/// anything that canonicalizes outside `base`, or traverses with `..`, is
/// rejected. Live symlinks that resolve back inside `base` are allowed
/// (their canonical target still lies within the vault); any symlink that
/// still appears as a component between `base` and the result — including a
/// dangling symlink whose target is currently absent — is rejected, because
/// its target could be materialized later and redirect the read/write
/// outside the vault at use time.
pub fn resolve_within(base: &str, requested: &str) -> Result<PathBuf, String> {
    let base_path = Path::new(base);
    if !base_path.is_absolute() {
        return Err("vault root must be an absolute path".into());
    }
    let canonical_base = base_path
        .canonicalize()
        .map_err(|e| format!("vault root not accessible: {e}"))?;

    let requested_path = Path::new(requested);
    let combined = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        canonical_base.join(requested_path)
    };

    let mut normalized = PathBuf::new();
    for component in combined.components() {
        match component {
            Component::ParentDir => return Err("path escapes vault".into()),
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }

    let canonical = canonicalize_loose(&normalized)
        .map_err(|e| format!("cannot resolve path: {e}"))?;
    if !canonical.starts_with(&canonical_base) {
        return Err("path escapes vault".into());
    }
    reject_symlink_components(&canonical_base, &canonical)?;
    Ok(canonical)
}

/// Reject the resolved path if any component between `base` and `path` is a
/// symlink (lstat — non-following). `canonicalize_loose` resolves *live*
/// symlinks away, so only *dangling* symlinks survive as literal components
/// in its missing-tail re-append; those cannot be proven to stay inside the
/// vault, so they are rejected outright.
fn reject_symlink_components(base: &Path, path: &Path) -> Result<(), String> {
    let Some(relative) = path.strip_prefix(base).ok() else {
        return Err("path escapes vault".into());
    };
    let mut probe = base.to_path_buf();
    for component in relative.components() {
        probe.push(component);
        let is_symlink = probe
            .symlink_metadata()
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false);
        if is_symlink {
            return Err("path escapes vault".into());
        }
    }
    Ok(())
}

/// Canonicalize `path` even when its final segment does not exist yet (e.g.
/// a file about to be written): canonicalize the nearest existing ancestor
/// and re-append the missing tail so symlinks can still be resolved.
fn canonicalize_loose(path: &Path) -> io::Result<PathBuf> {
    if let Ok(canonical) = path.canonicalize() {
        return Ok(canonical);
    }
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        match current.canonicalize() {
            Ok(canonical) => {
                let mut out = canonical;
                for segment in missing.iter().rev() {
                    out.push(segment);
                }
                return Ok(out);
            }
            Err(_) => match current.file_name() {
                Some(name) => {
                    missing.push(name.to_os_string());
                    match current.parent() {
                        Some(parent) => current = parent.to_path_buf(),
                        None => return path.canonicalize(),
                    }
                }
                None => return path.canonicalize(),
            },
        }
    }
}

pub fn read_file(vault_root: &str, path: &str) -> Result<String, String> {
    let resolved = resolve_within(vault_root, path)?;
    std::fs::read_to_string(&resolved).map_err(|e| e.to_string())
}

pub fn write_file(vault_root: &str, path: &str, content: &str) -> Result<(), String> {
    let resolved = resolve_within(vault_root, path)?;
    std::fs::write(&resolved, content).map_err(|e| e.to_string())
}

pub fn list_dir(vault_root: &str, path: Option<&str>) -> Result<Vec<FileEntry>, String> {
    let requested = path.unwrap_or(".");
    let resolved = resolve_within(vault_root, requested)?;
    list_dir_entries(&resolved)
}

/// Pure single-level listing of `dir` with [`should_skip_entry`] filtering
/// applied. Shared by the `list_dir` command (after path resolution) and by
/// tests that exercise filtering directly against a real temp directory.
pub fn list_dir_entries(dir: &Path) -> Result<Vec<FileEntry>, String> {
    let mut out = vec![];
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let entry_path = entry.path();
        let name = entry_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let is_symlink = entry.file_type().map_err(|e| e.to_string())?.is_symlink();
        if should_skip_entry(&name, is_symlink) {
            continue;
        }
        let is_dir = entry_path.is_dir();
        let path_str = entry_path.to_string_lossy().to_string();
        let is_mdx = is_mdx_path(&path_str);
        if is_dir || is_mdx {
            out.push(FileEntry {
                name,
                path: path_str,
                is_dir,
                is_mdx: !is_dir && is_mdx,
            });
        }
    }
    out.sort_by(|a, b| {
        (b.is_dir as u8)
            .cmp(&(a.is_dir as u8))
            .then(a.name.cmp(&b.name))
    });
    Ok(out)
}
