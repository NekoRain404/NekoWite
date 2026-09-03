use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use chrono::Local;
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
    resolve_within_rel(base, requested).map(|(resolved, _)| resolved)
}

/// Resolve `requested` against the vault `base` and prove the result stays
/// inside the vault, returning both the resolved absolute path and the
/// canonical vault-relative form.
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
///
/// The relative form is what history/trash keys are built from: it is
/// canonical (no `.`/`..` components, symlinks resolved away), so an absolute
/// spelling (what `list_dir` entries carry) and a relative spelling of the
/// same file always produce the same key.
pub fn resolve_within_rel(base: &str, requested: &str) -> Result<(PathBuf, String), String> {
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
    let relative = canonical
        .strip_prefix(&canonical_base)
        .map_err(|_| "path escapes vault".to_string())?
        .to_string_lossy()
        .to_string();
    Ok((canonical, relative))
}

/// Resolve `path` inside the vault and encode the canonical vault-relative
/// form as a history key. Every history caller goes through this so all
/// spellings of a file land on the same key. The vault root itself has no
/// meaningful relative form and is rejected.
fn encoded_history_key(vault_root: &str, path: &str) -> Result<String, String> {
    let (_, relative) = resolve_within_rel(vault_root, path)?;
    if relative.is_empty() {
        return Err("path is the vault root".into());
    }
    Ok(encode_rel_path(&relative))
}

/// Nanosecond clock reading used to make temp file names unique.
fn time_nonce() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
}

/// Snapshot cap used when the caller does not pass `max_history`.
const DEFAULT_MAX_HISTORY: usize = 10;

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
/// the target, and fsync the parent directory so the rename itself survives
/// power loss. On any failure the temp file is removed so no partial file is
/// left behind. Mirrors Memoir's `atomic.rs`.
pub fn atomic_write(resolved: &Path, content: &str) -> Result<(), String> {
    atomic_write_bytes(resolved, content.as_bytes())
}

/// Byte-level twin of [`atomic_write`] for binary attachment payloads; the
/// temp-sibling, fsync and rename pipeline is identical.
pub fn atomic_write_bytes(resolved: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = resolved
        .parent()
        .ok_or_else(|| "target path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let name = resolved
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp = parent.join(format!(".{name}.{}.tmp", time_nonce()));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("cannot create temp file {}: {e}", tmp.display()))?;
        f.write_all(bytes)
            .map_err(|e| format!("cannot write temp file {}: {e}", tmp.display()))?;
        f.sync_all()
            .map_err(|e| format!("cannot sync temp file {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, resolved).map_err(|e| e.to_string())?;
        sync_parent_dir(resolved)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// fsync the directory containing `path` so a completed rename/link is
/// durable across power loss. Opening a directory read-only and syncing it
/// is the portable unix way to flush its entry list; the extra `O_DIRECTORY`
/// flag is only a fail-fast hint and would need a libc dependency, so it is
/// not set. On other platforms there is nothing to do.
#[cfg(unix)]
fn sync_parent_dir(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "target path has no parent directory".to_string())?;
    let dir = std::fs::File::open(parent).map_err(|e| e.to_string())?;
    dir.sync_all().map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn sync_parent_dir(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Encode a vault-relative path into a single safe file name for use under
/// `.nekowite/history/` and `.nekowite-trash/`.
///
/// The mapping is injective, so two distinct paths can never share a history
/// directory or a trash key — the previous `__` scheme collapsed `docs/a.md`
/// and a literal `docs__a.md` (and `.a/b` with `a/b`) onto the same key.
/// `%`, `/`, `_` and a leading `.` are percent-escaped; every other character
/// passes through. Escaping `_` as well keeps the `__` marker out of new
/// keys, which is what lets [`decode_rel_path`] tell legacy keys apart
/// unambiguously. The result never contains `/`, never starts with `.`, and
/// is never `.`/`..`, so it is always exactly one safe filesystem component
/// (a `..` run that merely appears inside the name is harmless — it is part
/// of one component, not a traversal).
pub fn encode_rel_path(p: &str) -> String {
    if p.is_empty() {
        // Not a real path; keep a stable, safe placeholder.
        return "_".into();
    }
    let mut out = String::with_capacity(p.len());
    for (i, c) in p.chars().enumerate() {
        match c {
            '%' => out.push_str("%25"),
            '/' => out.push_str("%2F"),
            '_' => out.push_str("%5F"),
            // A leading dot would make the name hidden (or even `.`/`..`).
            '.' if i == 0 => out.push_str("%2E"),
            c => out.push(c),
        }
    }
    out
}

/// Undo [`encode_rel_path`], recovering the vault-relative path a trash key
/// stands for. Best-effort by design, because trash entries written by the
/// previous `__` encoder must keep working: a name carrying one of our known
/// escape sequences is percent-decoded, a name containing `__` (which the
/// current encoder never emits, since `_` is escaped) is treated as legacy
/// and its `__` markers become `/`, and anything else is itself. A legacy
/// file whose own name contains an uppercase escape sequence can still be
/// mis-decoded — the old scheme was lossy the same way.
fn decode_rel_path(encoded: &str) -> String {
    const KNOWN: [&str; 4] = ["%2F", "%25", "%5F", "%2E"];
    if KNOWN.iter().any(|seq| encoded.contains(seq)) {
        return percent_decode(encoded);
    }
    if encoded.contains("__") {
        // Legacy encoder: `/` became `__`.
        let legacy = encoded.replace("__", "/");
        if is_safe_rel(&legacy) {
            return legacy;
        }
    }
    encoded.to_string()
}

/// Unescape exactly the sequences [`encode_rel_path`] emits. `%25` must be
/// replaced last so an escaped `%` is never re-expanded into a fake escape
/// (e.g. the key `%252F` is a literal `%2F`, not a `/`).
fn percent_decode(encoded: &str) -> String {
    const ESCAPES: [(&str, &str); 4] = [
        ("%2F", "/"),
        ("%5F", "_"),
        ("%2E", "."),
        ("%25", "%"),
    ];
    let mut out = encoded.to_string();
    for (from, to) in ESCAPES {
        out = out.replace(from, to);
    }
    out
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
/// Empty `old_content` is skipped (nothing to preserve).
///
/// The content is written to a unique temp sibling and fsynced first, then
/// hard-linked into place under the timestamped name: the link fails with
/// `AlreadyExists` when another writer claimed the same millisecond, so the
/// `-<n>` suffix loop below never silently overwrites an existing snapshot
/// (a plain rename would), and the newest snapshot can never be observed
/// truncated — the name only exists once the content is complete and durable.
pub fn snapshot_history(vault_root: &str, path: &str, old_content: &str, max: usize) -> Result<(), String> {
    if old_content.is_empty() {
        return Ok(());
    }
    let (resolved, relative) = resolve_within_rel(vault_root, path)?;
    if relative.is_empty() {
        return Err("path is the vault root".into());
    }
    let encoded = encode_rel_path(&relative);
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
    let tmp = history_dir.join(format!(".{ms}.{}.tmp", time_nonce()));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("cannot create temp file {}: {e}", tmp.display()))?;
        f.write_all(old_content.as_bytes())
            .map_err(|e| format!("cannot write temp file {}: {e}", tmp.display()))?;
        f.sync_all()
            .map_err(|e| format!("cannot sync temp file {}: {e}", tmp.display()))?;
        let mut n = 0u64;
        loop {
            let candidate = if n == 0 {
                history_dir.join(format!("{ms}.{ext}"))
            } else {
                history_dir.join(format!("{ms}-{n}.{ext}"))
            };
            match std::fs::hard_link(&tmp, &candidate) {
                Ok(()) => return Ok(candidate),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => n += 1,
                Err(e) => return Err(e.to_string()),
            }
        }
    })();
    match result {
        Ok(candidate) => {
            let _ = std::fs::remove_file(&tmp);
            sync_parent_dir(&candidate)?;
            prune_history(&history_dir, max)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Keep only the `max` newest snapshot files (by modified time) in `dir`.
fn prune_history(dir: &Path, max: usize) -> Result<(), String> {
    let mut entries: Vec<(PathBuf, u128)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            // Never count temp litter from an interrupted snapshot write.
            if p.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .starts_with('.')
            {
                continue;
            }
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
        // Newest first. File mtimes are only jiffy-coarse, so snapshots
        // written in quick succession can share one timestamp; break ties by
        // name instead of read_dir order so same-millisecond suffixed
        // snapshots (`<ms>.md`, `<ms>-1.md`, ...) keep their creation order
        // deterministically.
        entries.sort_by(|a, b| {
            b.1.cmp(&a.1).then(a.0.file_name().cmp(&b.0.file_name()))
        });
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
        match std::fs::read_to_string(&resolved) {
            Ok(old) => Some(old),
            // A binary file has no text snapshot to take; refuse the
            // overwrite instead of destroying it untracked.
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                return Err("file is not valid UTF-8 text".into());
            }
            // Unreadable for another reason (permissions, ...): keep the old
            // best-effort behavior and write without a snapshot.
            Err(_) => None,
        }
    } else {
        None
    };
    if let Some(old_content) = old {
        if !old_content.is_empty() && old_content != content {
            let max = max_history.map_or(DEFAULT_MAX_HISTORY, |m| m as usize);
            snapshot_history(vault_root, path, &old_content, max)?;
        }
    }
    atomic_write(&resolved, content)
}

/// Move `path` into `.nekowite-trash/<encode(path)>`, appending `-<ts>` if a
/// same-named entry already sits in the trash. Returns the trash path.
///
/// The key is built from the CANONICAL vault-relative path, not the argument
/// as given: the frontend hands us absolute paths (as returned by
/// `list_dir`), and encoding those directly produced keys
/// [`decode_rel_path`] could never turn back into a usable vault path.
pub fn delete_file(vault_root: &str, path: &str) -> Result<String, String> {
    let (resolved, relative) = resolve_within_rel(vault_root, path)?;
    if relative.is_empty() {
        return Err("cannot delete the vault root".into());
    }
    let trash_root = Path::new(vault_root).join(".nekowite-trash");
    std::fs::create_dir_all(&trash_root).map_err(|e| e.to_string())?;
    let encoded = encode_rel_path(&relative);
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
        // Only surface a path that is a sane vault-relative form AND that we
        // could actually resolve inside the vault — the same rule
        // `restore_from_trash` applies, so the UI never offers a restore
        // that would be refused.
        let original_path = if is_safe_rel(&decoded)
            && resolve_within(vault_root, &decoded).is_ok()
        {
            decoded
        } else {
            String::new()
        };
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
    let encoded = encoded_history_key(vault_root, path)?;
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
        // Temp litter from an interrupted snapshot write is not a snapshot.
        if id.starts_with('.') {
            continue;
        }
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
    let encoded = encoded_history_key(vault_root, path)?;
    // The id is joined onto a directory path, so treat it as untrusted input:
    // it must be a plain single file name.
    let valid_id = !id.is_empty()
        && !id.starts_with('.')
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains(':')
        && !id.contains("..")
        && Path::new(id).file_name().and_then(|n| n.to_str()) == Some(id);
    if !valid_id {
        return Err("invalid history id".into());
    }
    let history_dir = Path::new(vault_root)
        .join(".nekowite")
        .join("history")
        .join(&encoded);
    let snapshot = history_dir.join(id);
    // Belt and braces: even if the lexical checks above missed something, the
    // resolved snapshot path must stay inside this history directory.
    let canonical_dir = history_dir
        .canonicalize()
        .map_err(|e| format!("cannot resolve history directory: {e}"))?;
    let canonical_snapshot = snapshot.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_snapshot.starts_with(&canonical_dir) {
        return Err("invalid history id".into());
    }
    std::fs::read_to_string(&canonical_snapshot).map_err(|e| e.to_string())
}

/// Restore a history snapshot onto the main file atomically; returns the
/// restored content. The content being replaced is snapshotted first (same
/// pipeline and pruning as `write_file`), so a restore can itself be undone
/// from the history panel.
pub fn restore_history(vault_root: &str, path: &str, id: &str) -> Result<String, String> {
    let content = read_history(vault_root, path, id)?;
    let resolved = resolve_within(vault_root, path)?;
    if resolved.exists() {
        match std::fs::read_to_string(&resolved) {
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                // Same guard as write_file: never clobber a binary file.
                return Err("file is not valid UTF-8 text".into());
            }
            Ok(old) if !old.is_empty() && old != content => {
                snapshot_history(vault_root, path, &old, DEFAULT_MAX_HISTORY)?;
            }
            _ => {}
        }
    }
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
        // Every non-hidden file is listed: the references library
        // (`.bib`/`.ris`) is discovered from this listing, so non-markdown
        // files must not be filtered out. The file tree decides what is
        // openable via the `is_mdx` flag.
        out.push(FileEntry {
            name,
            path: path_str,
            is_dir,
            is_mdx: !is_dir && is_mdx,
        });
    }
    out.sort_by(|a, b| {
        (b.is_dir as u8)
            .cmp(&(a.is_dir as u8))
            .then(a.name.cmp(&b.name))
    });
    Ok(out)
}

/// Recursively collect markdown files under the vault whose path matches
/// `query` (case-insensitive substring). Applies the same filtering as
/// listings ([`should_skip_entry`]) and is bounded so a huge vault cannot
/// produce an unbounded walk: `limit` results, at most 512 directories and a
/// recursion depth of 24. Returns entries ordered by path depth then name.
pub fn search_notes(vault_root: &str, query: &str, limit: usize) -> Result<Vec<FileEntry>, String> {
    let root = resolve_within(vault_root, ".")?;
    let q = query.trim().to_lowercase();
    let mut out = Vec::new();
    if q.is_empty() {
        return Ok(out);
    }
    let mut visited = 0usize;
    walk_search(&root, &q, &mut out, limit, &mut visited, 0);
    Ok(out)
}

const SEARCH_MAX_DIRS: usize = 512;
const SEARCH_MAX_DEPTH: usize = 24;

fn walk_search(dir: &Path, query: &str, out: &mut Vec<FileEntry>, limit: usize, visited: &mut usize, depth: usize) {
    if out.len() >= limit || *visited >= SEARCH_MAX_DIRS || depth > SEARCH_MAX_DEPTH {
        return;
    }
    *visited += 1;
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= limit {
            return;
        }
        let entry_path = entry.path();
        let name = entry_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let is_symlink = entry.file_type().map(|t| t.is_symlink()).unwrap_or(true);
        if should_skip_entry(&name, is_symlink) {
            continue;
        }
        let path_str = entry_path.to_string_lossy().to_string();
        if entry_path.is_dir() {
            walk_search(&entry_path, query, out, limit, visited, depth + 1);
            continue;
        }
        if !is_mdx_path(&path_str) {
            continue;
        }
        if path_str.to_lowercase().contains(query) {
            out.push(FileEntry {
                name,
                path: path_str.clone(),
                is_dir: false,
                is_mdx: true,
            });
        }
    }
}

/// Decode a standard-base64 attachment payload (frontend paste data).
pub fn decode_base64(data: &str) -> Result<Vec<u8>, String> {
    BASE64_STANDARD
        .decode(data.trim())
        .map_err(|e| format!("attachment data is not valid base64: {e}"))
}

/// Reduce a pasted/typed attachment name to a bare `stem.ext` file name.
/// Path separators, `..` runs and extension-less names are rejected, so the
/// name can never steer the write out of the attachments directory.
pub fn sanitize_attachment_name(name: &str) -> Result<String, String> {
    let invalid = || "invalid attachment file name".to_string();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(invalid());
    }
    let path = Path::new(name);
    if path.file_name().and_then(|n| n.to_str()) != Some(name) {
        return Err(invalid());
    }
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(invalid)?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .ok_or_else(invalid)?;
    Ok(format!("{stem}.{ext}"))
}

/// Local-calendar month folder for new attachments (`YYYY-MM`).
fn attachment_month_dir() -> String {
    Local::now().format("%Y-%m").to_string()
}

/// First free `stem.ext`, `stem-1.ext`, ... name inside `dir`; after 1000
/// collisions fall back to a `-overflow` suffix so the loop cannot spin
/// forever. Mirrors Memoir's `unique_file_name`.
fn unique_attachment_name(preferred: &str, dir: &Path) -> String {
    let path = Path::new(preferred);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("png");
    for n in 0..1000u32 {
        let candidate = if n == 0 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem}-{n}.{ext}")
        };
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{stem}-overflow.{ext}")
}

/// Decode and save a base64 image attachment under
/// `{vault}/attachments/{YYYY-MM}/`, deduplicating name collisions with
/// `-<n>` suffixes, and return the vault-relative path (forward slashes) for
/// embedding in markdown.
pub fn save_attachment(vault_root: &str, file_name: &str, base64: &str) -> Result<String, String> {
    let bytes = decode_base64(base64)?;
    let name = sanitize_attachment_name(file_name)?;
    let root = resolve_within(vault_root, ".")?;
    let month = attachment_month_dir();
    let month_dir = root.join("attachments").join(&month);
    std::fs::create_dir_all(&month_dir).map_err(|e| e.to_string())?;
    let unique = unique_attachment_name(&name, &month_dir);
    let relative = format!("attachments/{month}/{unique}");
    let target = resolve_within(vault_root, &relative)?;
    atomic_write_bytes(&target, &bytes)?;
    Ok(relative)
}

/// Resolve a media reference (e.g. from markdown) to an absolute path the
/// frontend can feed to `convertFileSrc`. Traversal and symlink escapes are
/// rejected by [`resolve_within`]; a missing file is an error.
pub fn resolve_media_path(vault_root: &str, rel_path: &str) -> Result<String, String> {
    let resolved = resolve_within(vault_root, rel_path)?;
    if !resolved.is_file() {
        return Err(format!("media file not found: {rel_path}"));
    }
    Ok(resolved.to_string_lossy().to_string())
}

/// Create a directory (and any missing parents) inside the vault. Returns the
/// canonical vault-relative path of the created directory.
pub fn create_dir(vault_root: &str, path: &str) -> Result<String, String> {
    let (resolved, relative) = resolve_within_rel(vault_root, path)?;
    if resolved.exists() {
        return Err(format!("already exists: {relative}"));
    }
    std::fs::create_dir_all(&resolved).map_err(|e| e.to_string())?;
    Ok(relative)
}

/// Rename (move) a file or directory within the vault. The target must not
/// exist. Returns the canonical vault-relative path of the moved entry.
pub fn rename_entry(vault_root: &str, from: &str, to: &str) -> Result<String, String> {
    let (resolved_from, relative_from) = resolve_within_rel(vault_root, from)?;
    if !resolved_from.exists() {
        return Err(format!("not found: {relative_from}"));
    }
    let (resolved_to, relative_to) = resolve_within_rel(vault_root, to)?;
    if resolved_to.exists() {
        return Err(format!("target already exists: {relative_to}"));
    }
    if let Some(parent) = resolved_to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&resolved_from, &resolved_to).map_err(|e| e.to_string())?;
    Ok(relative_to)
}
