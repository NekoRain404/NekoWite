//! Vault file store: reading, writing, listing, searching, history snapshots
//! and attachments.
//!
//! Every function takes a `vault_root` (the vault the user opened) as its first
//! argument and resolves the requested path through
//! [`crate::domain::path_policy`] before touching the disk, so every operation
//! is traceable to the vault root and confined inside it. The command layer
//! additionally proves the root was opened this session (see
//! [`crate::state::require_opened_vault`]) before calling in.

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use chrono::Local;
use serde::Serialize;
use std::io;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::domain::path_policy::{
    encode_rel_path, resolve_within, resolve_within_rel,
};
use crate::domain::vault::{is_mdx_path, should_skip_entry};
use crate::storage::trash_store::move_trash_key;

#[derive(Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_mdx: bool,
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

/// Nanosecond clock reading used to make temp file names unique.
fn time_nonce() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
}

/// Snapshot cap used when the caller does not pass `max_history`.
const DEFAULT_MAX_HISTORY: usize = 10;

/// Serializes the read-old -> snapshot -> atomic-write sequence inside a
/// single process so two concurrent `write_file`s on the same vault can never
/// interleave: one writer might capture a predecessor snapshot while the
/// other lands a newer write, dropping the newest snapshot from the chain.
/// A process-internal lock is enough — the atomic rename already guarantees
/// the file itself is never torn.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// How old a `.tmp` sibling must be before the next write in that directory
/// treats it as crash litter and cleans it up. Fresh temp files written by a
/// currently-running writer (unique nonce name, recent mtime) are never
/// touched, so cleaning cannot race a live write.
const STALE_TMP_MAX_AGE: Duration = Duration::from_secs(3600);

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

/// Remove `.tmp` siblings in `dir` whose modified time is older than
/// `max_age`, returning how many were removed. These are crash remnants of
/// [`atomic_write`]/[`snapshot_history`] (which write a `.<name>.<nonce>.tmp`
/// sibling then rename it into place); on a crash the temp file survives.
/// Cleaning is bounded to mtime so a temp file a live writer just created
/// (fresh mtime, unique nonce name) is never deleted mid-write.
pub fn cleanup_stale_tmp(dir: &Path, max_age: Duration) -> Result<usize, String> {
    let now = SystemTime::now();
    let rd = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    let mut removed = 0usize;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            continue;
        }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.ends_with(".tmp") {
            continue;
        }
        let stale = p
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|mt| now.duration_since(mt).ok())
            .map(|age| age > max_age)
            .unwrap_or(false);
        if stale && std::fs::remove_file(&p).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Write `content` to `path` under the vault, snapshotting the previous
/// content first (when it exists, differs, and is non-empty).
///
/// `max_history` caps how many snapshots are kept (default 10 when `None`).
/// `Option<u32>` keeps the command compatible with the current frontend, which
/// invokes `write_file` with only `{ vault_root, path, content }`; Tauri maps a
/// missing optional argument to `None`.
///
/// The read-old -> snapshot -> atomic-write sequence holds [`WRITE_LOCK`], so
/// concurrent saves on the same vault are serialized and cannot interleave a
/// stale snapshot with a newer write. The directory the file lives in is also
/// swept for stale `.tmp` crash litter before the write.
pub fn write_file(
    vault_root: &str,
    path: &str,
    content: &str,
    max_history: Option<u32>,
) -> Result<(), String> {
    // Serialize the whole read-snapshot-write sequence. `write_file` does no
    // `.await`, so the guard never crosses a yield point and cannot deadlock
    // the async executor; it just windows two concurrent saves apart.
    let _guard = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let resolved = resolve_within(vault_root, path)?;
    if let Some(parent) = resolved.parent() {
        let _ = cleanup_stale_tmp(parent, STALE_TMP_MAX_AGE);
    }
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
        let path_str = crate::domain::path_policy::ipc_path(&entry_path);
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
/// listings ([`should_skip_entry`]).
///
/// Bounded so a pathological vault cannot produce an unbounded walk, but the
/// bounds are deliberately GENEROUS so a large vault's search is never silently
/// capped (a 10k-file vault is far under them): `limit` results, at most
/// [`SEARCH_MAX_DIRS`] directories and a recursion depth of
/// [`SEARCH_MAX_DEPTH`]. Returns entries ordered by path depth then name.
pub fn search_notes(vault_root: &str, query: &str, limit: usize) -> Result<Vec<FileEntry>, String> {
    search_notes_with_max(vault_root, query, limit, None)
}

/// Like [`search_notes`] but lets the caller override the directory cap;
/// `None` uses the generous [`SEARCH_MAX_DIRS`] default. The frontend does not
/// pass an override today, so a large vault's search is not capped; the
/// override exists as an explicit guard for a future client that wants to bound
/// an unusually deep/hostile tree.
pub fn search_notes_with_max(
    vault_root: &str,
    query: &str,
    limit: usize,
    max_dirs: Option<usize>,
) -> Result<Vec<FileEntry>, String> {
    let root = resolve_within(vault_root, ".")?;
    let q = query.trim().to_lowercase();
    let mut out = Vec::new();
    if q.is_empty() {
        return Ok(out);
    }
    let max = max_dirs.unwrap_or(SEARCH_MAX_DIRS);
    let mut visited = 0usize;
    walk_search(&root, &q, &mut out, limit, &mut visited, 0, max);
    Ok(out)
}

// Search-bounds guard. Thresholds are set far above any realistic vault (a
// 10k-file vault is typically well under 1k directories), so they only trip on
// a genuinely pathological tree and are surfaced as a bounded result rather
// than silently dropping matches.
const SEARCH_MAX_DIRS: usize = 100_000;
const SEARCH_MAX_DEPTH: usize = 64;

fn walk_search(
    dir: &Path,
    query: &str,
    out: &mut Vec<FileEntry>,
    limit: usize,
    visited: &mut usize,
    depth: usize,
    max_dirs: usize,
) {
    if out.len() >= limit || *visited >= max_dirs || depth > SEARCH_MAX_DEPTH {
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
        let path_str = crate::domain::path_policy::ipc_path(&entry_path);
        if entry_path.is_dir() {
            walk_search(&entry_path, query, out, limit, visited, depth + 1, max_dirs);
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

/// Largest image the picker-based import accepts, mirroring the frontend's
/// `MAX_ATTACHMENT_BYTES` so both entry points agree on what "too large" means.
pub const MAX_IMPORT_BYTES: u64 = 10 * 1024 * 1024;

/// Image extensions the import path accepts. A native file picker is a user
/// gesture, but the picked path is still an arbitrary filesystem location, so
/// the set of things we are willing to copy into a vault stays closed: an
/// allowlist of image extensions, no executables, scripts or archives.
pub const IMPORT_IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "ico", "tiff", "tif",
];

/// True when `path`'s extension is on the import allowlist (case-insensitive).
pub fn is_importable_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| IMPORT_IMAGE_EXTENSIONS.contains(&e.as_str()))
}

/// Copy an image the user picked in the native dialog into the vault,
/// returning its vault-relative path.
///
/// Unlike [`save_attachment`] the bytes never round-trip through the frontend
/// as base64: the backend reads the source path directly and writes it into the
/// vault. That keeps a large photo from being encoded (≈4/3 the byte size),
/// shipped over IPC, decoded and written — and it means the file's real name
/// and extension are preserved instead of being re-derived from MIME type.
///
/// The source path is intentionally outside the vault (that is the point of a
/// file picker), so it is NOT passed through `resolve_within`. Instead the
/// destination is confined to the vault by [`resolve_within_rel`] exactly like
/// [`save_attachment`], the extension is allowlisted, and the size is capped.
pub fn import_attachment(vault_root: &str, source_path: &str, dir: &str) -> Result<String, String> {
    let source = Path::new(source_path);
    if !source.is_absolute() {
        return Err("picked file path must be absolute".into());
    }
    let metadata =
        std::fs::metadata(source).map_err(|e| format!("picked file not readable: {e}"))?;
    if !metadata.is_file() {
        return Err("picked path is not a file".into());
    }
    if !is_importable_image(source) {
        return Err("picked file is not a supported image".into());
    }
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err(format!(
            "image is larger than the {} MB import limit",
            MAX_IMPORT_BYTES / (1024 * 1024)
        ));
    }
    let file_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "picked file has no usable name".to_string())?;
    // Reuses the same name sanitizer as the paste path, so an odd source name
    // can never steer the destination out of the target directory.
    let name = sanitize_attachment_name(file_name)?;

    let _root = resolve_within(vault_root, ".")?;
    let dir = dir.trim();
    if Path::new(dir).is_absolute() {
        return Err("attachment dir must be vault-relative".into());
    }
    let dir = if dir.is_empty() || dir == "." { "" } else { dir.trim_matches('/') };
    let (dir_abs, dir_rel) = if dir.is_empty() {
        let month = attachment_month_dir();
        let rel = format!("attachments/{month}");
        let abs = resolve_within(vault_root, &rel)?;
        (abs, rel)
    } else {
        resolve_within_rel(vault_root, dir)?
    };
    std::fs::create_dir_all(&dir_abs).map_err(|e| e.to_string())?;
    let unique = unique_attachment_name(&name, &dir_abs);
    let relative = format!("{dir_rel}/{unique}");
    let target = resolve_within(vault_root, &relative)?;
    let bytes = std::fs::read(source).map_err(|e| format!("reading picked file failed: {e}"))?;
    atomic_write_bytes(&target, &bytes)?;
    Ok(relative)
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

/// Decode and save a base64 image attachment, deduplicating name collisions
/// with `-<n>` suffixes, and return the vault-relative path (forward slashes)
/// for embedding in markdown.
///
/// When `dir` is non-empty it is treated as a vault-relative target directory
/// (e.g. `notes/foo_assets` or `.tmp`) and the file is written there; when it
/// is empty the legacy `attachments/{YYYY-MM}` layout is used. Traversal and
/// symlink escapes in `dir` are rejected by [`resolve_within_rel`].
pub fn save_attachment(
    vault_root: &str,
    file_name: &str,
    base64: &str,
    dir: &str,
) -> Result<String, String> {
    // The frontend caps a paste at `MAX_ATTACHMENT_BYTES` before it ever
    // encodes, but that is a single caller: a plugin, the chat panel or a
    // future caller can reach this command directly, and the IPC boundary must
    // not trust any of them. Checking the encoded length BEFORE decoding also
    // means an oversized payload is rejected without allocating its bytes.
    //
    // Base64 is 4 characters per 3 bytes, so this bound is the decoded limit
    // rounded up to a whole group — slightly permissive by design, and the
    // exact check follows the decode.
    let encoded_limit = (MAX_IMPORT_BYTES as usize).div_ceil(3) * 4;
    if base64.len() > encoded_limit {
        return Err(format!(
            "attachment is larger than the {} MB limit",
            MAX_IMPORT_BYTES / (1024 * 1024)
        ));
    }
    let bytes = decode_base64(base64)?;
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err(format!(
            "attachment is larger than the {} MB limit",
            MAX_IMPORT_BYTES / (1024 * 1024)
        ));
    }
    let name = sanitize_attachment_name(file_name)?;
    // `sanitize_attachment_name` only constrains the SHAPE of the name, so a
    // rename to `notes.html` used to land an arbitrary file type in the vault.
    // The paste path is for images, so it shares the picker's allowlist.
    if !is_importable_image(Path::new(&name)) {
        return Err(format!(
            "attachment type is not an allowed image: {name}"
        ));
    }
    // Path-confinement guard: validates the vault base resolves inside the
    // vault; the binding is unused (the target dir is resolved below via dir_abs).
    let _root = resolve_within(vault_root, ".")?;
    let dir = dir.trim();
    if Path::new(dir).is_absolute() {
        return Err("attachment dir must be vault-relative".into());
    }
    let dir = if dir.is_empty() || dir == "." { "" } else { dir.trim_matches('/') };
    let (dir_abs, dir_rel) = if dir.is_empty() {
        let month = attachment_month_dir();
        let rel = format!("attachments/{month}");
        let abs = resolve_within(vault_root, &rel)?;
        (abs, rel)
    } else {
        resolve_within_rel(vault_root, dir)?
    };
    std::fs::create_dir_all(&dir_abs).map_err(|e| e.to_string())?;
    let unique = unique_attachment_name(&name, &dir_abs);
    let relative = format!("{dir_rel}/{unique}");
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
    Ok(crate::domain::path_policy::ipc_path(&resolved))
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
///
/// For a renamed *file*, the history snapshots and trash entry keyed by the
/// old vault-relative path are migrated to the new key too, so a rename doesn't
/// silently orphan (make unreachable) a file's history or a trash restore.
/// A renamed *directory* is a plain move for now: the file tree inside it
/// still carries old relative paths, so migrating the whole subtree's keys is
/// deliberately out of scope here (single-file renames are covered).
pub fn rename_entry(vault_root: &str, from: &str, to: &str) -> Result<String, String> {
    let (resolved_from, relative_from) = resolve_within_rel(vault_root, from)?;
    if !resolved_from.exists() {
        return Err(format!("not found: {relative_from}"));
    }
    let is_dir = resolved_from.is_dir();
    let (resolved_to, relative_to) = resolve_within_rel(vault_root, to)?;
    if resolved_to.exists() {
        return Err(format!("target already exists: {relative_to}"));
    }
    if let Some(parent) = resolved_to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&resolved_from, &resolved_to).map_err(|e| e.to_string())?;
    if !is_dir {
        move_history_key(vault_root, &relative_from, &relative_to);
        move_trash_key(vault_root, &relative_from, &relative_to);
    }
    Ok(relative_to)
}

/// Migrate a file's history snapshots from the key for `from_rel` to the key
/// for `to_rel`. Best-effort: a renamed entry must not fail because a side
/// table could not be moved, so every error is swallowed. When the target key
/// already holds snapshots (a file of that relative path was previously saved),
/// the two directories are merged file-by-file instead of clobbering.
fn move_history_key(vault_root: &str, from_rel: &str, to_rel: &str) {
    let history_root = Path::new(vault_root).join(".nekowite").join("history");
    let from_dir = history_root.join(encode_rel_path(from_rel));
    let to_dir = history_root.join(encode_rel_path(to_rel));
    if !from_dir.exists() {
        return;
    }
    if !to_dir.exists() {
        let _ = std::fs::rename(&from_dir, &to_dir);
        return;
    }
    let Ok(rd) = std::fs::read_dir(&from_dir) else { return };
    for entry in rd.flatten() {
        let src = entry.path();
        let name = src
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let mut target = to_dir.join(&name);
        if target.exists() {
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default();
            target = to_dir.join(format!("{name}-merged-{ts}"));
        }
        let _ = std::fs::rename(&src, &target);
    }
    let _ = std::fs::remove_dir(&from_dir);
}
