use serde::Serialize;
use std::io;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_mdx: bool,
}

#[derive(Serialize, Clone)]
pub struct TrashEntry {
    pub name: String,
    pub trash_path: String,
    pub original_path: String,
}

#[derive(Serialize, Clone)]
pub struct HistoryEntry {
    pub id: String,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Serialize, Clone)]
pub struct FileStat {
    pub size: u64,
    pub mtime: u64,
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

/// Stat a vault-relative path: byte size plus modified time in unix
/// milliseconds. The path is resolved within the vault first, and a missing
/// file is an error (`resolve_within` permits a not-yet-existing tail, but
/// the metadata lookup then fails).
pub fn stat_file(vault_root: &str, path: &str) -> Result<FileStat, String> {
    let resolved = resolve_within(vault_root, path)?;
    let meta = std::fs::metadata(&resolved).map_err(|e| format!("cannot stat file: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileStat {
        size: meta.len(),
        mtime,
    })
}

/// Write `content` to `resolved` atomically: write a temp sibling
/// (`.<name>.<nonce>.tmp`) in the same directory, fsync it, then rename over
/// the target. On any failure the temp file is removed so no partial file is
/// left behind. Mirrors Memoir's `atomic.rs`.
pub fn atomic_write(resolved: &Path, content: &str) -> Result<(), String> {
    let parent = resolved
        .parent()
        .ok_or_else(|| "target path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let name = resolved
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp = parent.join(format!(".{name}.{nonce}.tmp"));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("cannot create temp file {}: {e}", tmp.display()))?;
        f.write_all(content.as_bytes())
            .map_err(|e| format!("cannot write temp file {}: {e}", tmp.display()))?;
        f.sync_all()
            .map_err(|e| format!("cannot sync temp file {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, resolved).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Encode a vault-relative path into a single safe file name for use under
/// `.nekowite/history/` and `.nekowite-trash/`: `/` becomes `__`, leading dots
/// are dropped (so hidden names and `..` parents cannot leak into the encoded
/// name), and any interior `..` run is collapsed to `_`. The result is pure
/// and testable: it can never contain `/`, `..`, or start with `.`.
pub fn encode_rel_path(p: &str) -> String {
    let mut out = String::new();
    for c in p.chars() {
        match c {
            '/' => out.push_str("__"),
            '.' => {
                if out.is_empty() {
                    // Drop leading dots: hidden-name / parent-dir protection.
                } else if out.ends_with('.') {
                    // Collapse a `..` run so no traversal marker survives.
                    out.pop();
                    out.push('_');
                } else {
                    out.push('.');
                }
            }
            c => out.push(c),
        }
    }
    // Trim a trailing dot-run that could look like a special `.`/`..` name.
    while out.ends_with('.') {
        out.pop();
    }
    if out.is_empty() {
        out.push('_');
    }
    out
}

/// Best-effort inverse of [`encode_rel_path`]: `__` back to `/`. Used by
/// trash listing/restore to recover the original path; collisions between a
/// literal `__` in a real file name and the encoding are accepted (the decode
/// is documented as best-effort).
fn decode_rel_path(encoded: &str) -> String {
    encoded.replace("__", "/")
}

/// A decoded relative path is usable only if it is non-empty, not absolute,
/// and has no `.`/`..` components (which the encoding must never produce).
fn is_safe_rel(p: &str) -> bool {
    !p.is_empty()
        && !p.starts_with('/')
        && !p.split('/').any(|c| c == "." || c == "..")
}

/// Snapshot `old_content` into `.nekowite/history/<encoded>/<unix_ms>.<ext>`
/// under `vault_root`, then prune the directory to the `max` newest snapshots.
/// Empty `old_content` is skipped (nothing to preserve). If two snapshots land
/// in the same millisecond a `-<n>` suffix keeps them distinct so no snapshot
/// is silently overwritten.
pub fn snapshot_history(vault_root: &str, path: &str, old_content: &str, max: usize) -> Result<(), String> {
    if old_content.is_empty() {
        return Ok(());
    }
    let resolved = resolve_within(vault_root, path)?;
    let encoded = encode_rel_path(path);
    let history_dir = Path::new(vault_root)
        .join(".nekowite")
        .join("history")
        .join(&encoded);
    std::fs::create_dir_all(&history_dir).map_err(|e| e.to_string())?;
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let ext = resolved
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("md");
    let mut snapshot = history_dir.join(format!("{ms}.{ext}"));
    let mut n = 1u64;
    while snapshot.exists() {
        snapshot = history_dir.join(format!("{ms}-{n}.{ext}"));
        n += 1;
    }
    std::fs::write(&snapshot, old_content).map_err(|e| e.to_string())?;
    prune_history(&history_dir, max)
}

/// Keep only the `max` newest snapshot files (by modified time) in `dir`.
fn prune_history(dir: &Path, max: usize) -> Result<(), String> {
    let mut entries: Vec<(PathBuf, u128)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if let Ok(meta) = p.metadata() {
                if meta.is_file() {
                    let mtime = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_nanos())
                        .unwrap_or(0);
                    entries.push((p, mtime));
                }
            }
        }
    }
    if entries.len() > max {
        entries.sort_by_key(|(_, mtime)| std::cmp::Reverse(*mtime));
        for (p, _) in entries.into_iter().skip(max) {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(())
}

/// Write `content` to `path` under the vault, snapshotting the previous
/// content first (when it exists, differs, and is non-empty).
///
/// `max_history` caps how many snapshots are kept (default 10 when `None`).
/// `Option<u32>` keeps the command compatible with the current frontend, which
/// invokes `write_file` with only `{ vault_root, path, content }`; Tauri maps a
/// missing optional argument to `None`.
pub fn write_file(
    vault_root: &str,
    path: &str,
    content: &str,
    max_history: Option<u32>,
) -> Result<(), String> {
    let resolved = resolve_within(vault_root, path)?;
    let old = if resolved.exists() {
        std::fs::read_to_string(&resolved).ok()
    } else {
        None
    };
    if let Some(old_content) = old {
        if !old_content.is_empty() && old_content != content {
            let max = max_history.unwrap_or(10) as usize;
            snapshot_history(vault_root, path, &old_content, max)?;
        }
    }
    atomic_write(&resolved, content)
}

/// Move `path` into `.nekowite-trash/<encode(path)>`, appending `-<ts>` if a
/// same-named entry already sits in the trash. Returns the trash path.
pub fn delete_file(vault_root: &str, path: &str) -> Result<String, String> {
    let resolved = resolve_within(vault_root, path)?;
    let trash_root = Path::new(vault_root).join(".nekowite-trash");
    std::fs::create_dir_all(&trash_root).map_err(|e| e.to_string())?;
    let encoded = encode_rel_path(path);
    let mut target = trash_root.join(&encoded);
    if target.exists() {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        target = trash_root.join(format!("{encoded}-{ts}"));
    }
    std::fs::rename(&resolved, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// List `.nekowite-trash/`, decoding each entry back to its original vault
/// path where the encoding permits.
pub fn list_trash(vault_root: &str) -> Result<Vec<TrashEntry>, String> {
    let trash_root = Path::new(vault_root).join(".nekowite-trash");
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(&trash_root) {
        Ok(rd) => rd,
        Err(_) => return Ok(out),
    };
    for entry in rd.flatten() {
        let p = entry.path();
        let Ok(meta) = p.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let decoded = decode_rel_path(&name);
        let original_path = if is_safe_rel(&decoded) { decoded } else { String::new() };
        out.push(TrashEntry {
            name,
            trash_path: p.to_string_lossy().to_string(),
            original_path,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Move a trash entry back to its original vault path. If that path is now
/// occupied, append `-restored-<ts>` and return the new path.
pub fn restore_from_trash(vault_root: &str, trash_path: &str) -> Result<String, String> {
    let resolved_trash = resolve_within(vault_root, trash_path)?;
    let trash_root = Path::new(vault_root).join(".nekowite-trash");
    let canonical_trash = trash_root
        .canonicalize()
        .map_err(|e| format!("cannot resolve trash directory: {e}"))?;
    if !resolved_trash.starts_with(&canonical_trash) {
        return Err("trash path outside .nekowite-trash".into());
    }
    let name = resolved_trash
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let original_rel = decode_rel_path(&name);
    if !is_safe_rel(&original_rel) {
        return Err("cannot restore: invalid trash entry name".into());
    }
    let original_abs = resolve_within(vault_root, &original_rel)?;
    let mut target = original_abs;
    if target.exists() {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        let parent = target
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_default();
        let fname = target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        target = parent.join(format!("{fname}-restored-{ts}"));
    }
    std::fs::rename(&resolved_trash, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// List the history snapshots for `path`, newest first.
pub fn list_history(vault_root: &str, path: &str) -> Result<Vec<HistoryEntry>, String> {
    // Validate the path resolves inside the vault (C-round sandbox) before we
    // trust it as a history key.
    resolve_within(vault_root, path)?;
    let encoded = encode_rel_path(path);
    let history_dir = Path::new(vault_root)
        .join(".nekowite")
        .join("history")
        .join(&encoded);
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(&history_dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(out),
    };
    for entry in rd.flatten() {
        let p = entry.path();
        let Ok(meta) = p.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let id = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(HistoryEntry {
            id,
            size: meta.len(),
            mtime,
        });
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime).then(b.id.cmp(&a.id)));
    Ok(out)
}

/// Read a single history snapshot by id.
pub fn read_history(vault_root: &str, path: &str, id: &str) -> Result<String, String> {
    resolve_within(vault_root, path)?;
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return Err("invalid history id".into());
    }
    let encoded = encode_rel_path(path);
    let snapshot = Path::new(vault_root)
        .join(".nekowite")
        .join("history")
        .join(&encoded)
        .join(id);
    std::fs::read_to_string(&snapshot).map_err(|e| e.to_string())
}

/// Restore a history snapshot onto the main file atomically; returns the
/// restored content.
pub fn restore_history(vault_root: &str, path: &str, id: &str) -> Result<String, String> {
    let content = read_history(vault_root, path, id)?;
    let resolved = resolve_within(vault_root, path)?;
    atomic_write(&resolved, &content)?;
    Ok(content)
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
