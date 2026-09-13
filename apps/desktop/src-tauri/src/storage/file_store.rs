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

use crate::domain::path_policy::{encode_rel_path, resolve_within, resolve_within_rel};
use crate::domain::vault::{is_mdx_path, should_skip_entry};
use crate::errors::{file_exists_error, fs_error};
use crate::storage::trash_store::move_trash_key;

#[derive(Serialize, Clone, Debug)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_mdx: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct HistoryEntry {
    pub id: String,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Serialize, Clone, Debug)]
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

/// Serializes the read-old -> snapshot -> atomic-write sequence for every
/// `write_file`/`create_new_file` call in THIS PROCESS - across all vaults.
///
/// The guarantee it actually provides: while one save holds it, no other save
/// can be between its read-old and its atomic rename, so no writer can
/// snapshot a predecessor that another writer is in the middle of replacing.
/// Two things about the scope are easy to get wrong and are stated here on
/// purpose:
///
///   * It is process-wide, not per-vault, and stays that way until a narrower
///     scheme is proven safe. Vaults can nest (a folder inside another opened
///     folder is addressable through both roots), so two writes that look
///     like different vaults can target the same file; and a per-vault map
///     would need canonical key normalisation to agree on case and separator
///     spellings across platforms. Getting that wrong loses snapshot-chain
///     ordering - a silent data-loss failure - while cross-vault waiting is
///     unobservable (saves are user-paced and the critical section is a few
///     file operations).
///   * It covers `write_file`/`create_new_file`/`restore_history`.
///     `rename_entry` and direct `snapshot_history` calls do not hold it, so
///     the snapshot chain is not protected against those paths; do not read
///     this as more than it is.
///
/// `write_lock_scope_tests` pins the process-wide scope, so narrowing it means
/// deliberately updating that test and the reasoning above.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// How old a `.tmp` sibling must be before the next write in that directory
/// treats it as crash litter and cleans it up. Fresh temp files written by a
/// currently-running writer (unique nonce name, recent mtime) are never
/// touched, so cleaning cannot race a live write.
const STALE_TMP_MAX_AGE: Duration = Duration::from_secs(3600);

pub fn read_file(vault_root: &str, path: &str) -> Result<String, String> {
    let resolved = resolve_within(vault_root, path)?;
    std::fs::read_to_string(&resolved).map_err(|e| fs_error("read", &resolved, e))
}

/// Stat a vault-relative path: byte size plus modified time in unix
/// milliseconds. The path is resolved within the vault first, and a missing
/// file is an error (`resolve_within` permits a not-yet-existing tail, but
/// the metadata lookup then fails).
pub fn stat_file(vault_root: &str, path: &str) -> Result<FileStat, String> {
    let resolved = resolve_within(vault_root, path)?;
    let meta = std::fs::metadata(&resolved).map_err(|e| fs_error("stat", &resolved, e))?;
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
    std::fs::create_dir_all(parent)
        .map_err(|e| fs_error("create the folder containing", parent, e))?;
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
            .map_err(|e| fs_error("create the temporary file", &tmp, e))?;
        f.write_all(bytes)
            .map_err(|e| fs_error("write the temporary file", &tmp, e))?;
        f.sync_all()
            .map_err(|e| fs_error("flush the temporary file", &tmp, e))?;
        std::fs::rename(&tmp, resolved).map_err(|e| fs_error("replace", resolved, e))?;
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
    let dir = std::fs::File::open(parent)
        .map_err(|e| fs_error("open the folder containing", parent, e))?;
    dir.sync_all()
        .map_err(|e| fs_error("flush the folder containing", parent, e))
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
pub fn snapshot_history(
    vault_root: &str,
    path: &str,
    old_content: &str,
    max: usize,
) -> Result<(), String> {
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
    std::fs::create_dir_all(&history_dir)
        .map_err(|e| fs_error("create the history folder", &history_dir, e))?;
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
            .map_err(|e| fs_error("create the temporary file", &tmp, e))?;
        f.write_all(old_content.as_bytes())
            .map_err(|e| fs_error("write the temporary file", &tmp, e))?;
        f.sync_all()
            .map_err(|e| fs_error("flush the temporary file", &tmp, e))?;
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
                // Not every filesystem can hard-link: FAT32 and exFAT (USB
                // sticks, SD cards) return ERROR_INVALID_FUNCTION, and a vault on
                // such a volume would otherwise never be able to save an existing
                // note — the snapshot is what this link was for, not the write
                // itself. Copy the staged bytes to the same name instead: the
                // staging file already holds the complete snapshot, so the copy
                // only needs to land atomically, which `create_new` gives us.
                Err(e) if is_link_unsupported(&e) => match copy_new(&tmp, &candidate) {
                    Ok(()) => return Ok(candidate),
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => n += 1,
                    Err(e) => return Err(fs_error("save the history version", &candidate, e)),
                },
                Err(e) => return Err(fs_error("save the history version", &candidate, e)),
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

/// True when the error means "this filesystem cannot do that", the shape
/// Windows reports for `CreateHardLinkW` on FAT/exFAT (`ERROR_INVALID_FUNCTION`)
/// and the one Linux reports for filesystems that do not implement links.
fn is_link_unsupported(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::Unsupported | io::ErrorKind::InvalidInput
    ) || e.raw_os_error() == Some(1) // EPERM on some network shares
}

/// Copy `from` to `to`, refusing an existing `to` and never exposing a partial
/// file under the destination name.
fn copy_new(from: &Path, to: &Path) -> io::Result<()> {
    let mut src = std::fs::File::open(from)?;
    let mut dst = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)?;
    io::copy(&mut src, &mut dst)?;
    dst.sync_all()?;
    Ok(())
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
        entries.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.file_name().cmp(&b.0.file_name())));
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
/// Whether `name` matches the temp-file shape this crate writes:
/// `.<original name>.<nanosecond nonce>.tmp`.
///
/// The leading dot keeps these out of the file tree and the numeric nonce
/// distinguishes them from a file a user or another tool named `*.tmp`. Both
/// parts matter: the dot alone would still claim `.gitignore.tmp`-style names
/// that are not ours, and the suffix alone (what this used to check) claimed
/// every `.tmp` file in the vault.
fn is_our_temp_file(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('.') else {
        return false;
    };
    let Some(rest) = rest.strip_suffix(".tmp") else {
        return false;
    };
    // `.<nonce>.tmp` (happens for a nameless source) or `.<name>.<nonce>.tmp`.
    match rest.rsplit_once('.') {
        Some((_, nonce)) => !nonce.is_empty() && nonce.bytes().all(|b| b.is_ascii_digit()),
        None => !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()),
    }
}

pub fn cleanup_stale_tmp(dir: &Path, max_age: Duration) -> Result<usize, String> {
    let now = SystemTime::now();
    let rd = std::fs::read_dir(dir).map_err(|e| fs_error("read the folder", dir, e))?;
    let mut removed = 0usize;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            continue;
        }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        // Only OUR temp files: `atomic_write` and `snapshot_history` stage
        // `.<original>.<nanosecond-nonce>.tmp` — hidden, with a numeric nonce as
        // the final stem segment. Matching any `.tmp` suffix instead deleted
        // whatever the user (or another program) happened to leave in the vault
        // with that extension: a `draft.tmp` in a note's folder was removed by
        // the next save in that folder, permanently — not to the trash, and with
        // no history snapshot to recover from. Vaults routinely hold project
        // files (that is why `node_modules`/`dist` are skipped), so this is a
        // real document, not litter.
        if !is_our_temp_file(name) {
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
/// Returns `Ok(None)` when everything succeeded and `Ok(Some(warning))` when the
/// text was written but the history snapshot was not — never an error for a
/// failure of the optional part.
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
) -> Result<Option<String>, String> {
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
    // The snapshot is best-effort: it is a convenience the user asked for
    // implicitly, while the write is the thing they explicitly asked for. A
    // history failure (unwritable history dir, full disk, quota) used to abort
    // the save with a bare OS error, which meant an existing note could not be
    // edited at all until the unrelated problem was fixed. Report it instead, and
    // report it in a form the caller can show: `Ok(Some(warning))` means "your
    // text was written, and this other thing failed".
    let mut warning = None;
    if let Some(old_content) = old {
        if !old_content.is_empty() && old_content != content {
            let max = max_history.map_or(DEFAULT_MAX_HISTORY, |m| m as usize);
            if let Err(e) = snapshot_history(vault_root, path, &old_content, max) {
                warning = Some(format!(
                    "Saved, but the previous version could not be kept in history: {e}"
                ));
            }
        }
    }
    atomic_write(&resolved, content)?;
    Ok(warning)
}

/// Creates `path` with `content`, refusing to replace anything already there.
///
/// The difference from [`write_file`] is the whole point: saving REPLACES the
/// file it finds (that is what saving means), while a note born from a template
/// or a daily note must never land on top of a file that appeared between "is
/// this name free?" and "write it" - another instance of the app, a sync
/// client, or the user in Explorer can all win that race, and the loser used to
/// be whoever's file was already there.
///
/// The bytes are staged first and then published with a hard link, which either
/// creates the name or fails with `AlreadyExists`: the check and the creation
/// are one step, a reader never sees a half-written note, and the "taken" case
/// is reported through [`crate::errors::ALREADY_EXISTS_PREFIX`] so the caller
/// can try the next name instead of showing the user an OS error.
pub fn create_new_file(vault_root: &str, path: &str, content: &str) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let resolved = resolve_within(vault_root, path)?;
    let parent = resolved
        .parent()
        .ok_or_else(|| format!("cannot create {path}: it has no parent folder"))?;
    std::fs::create_dir_all(parent).map_err(|e| fs_error("create the folder", parent, e))?;
    let _ = cleanup_stale_tmp(parent, STALE_TMP_MAX_AGE);

    let name = resolved
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp = parent.join(format!(".{name}.{}.tmp", time_nonce()));
    let staged = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| fs_error("create the temporary file", &tmp, e))?;
        f.write_all(content.as_bytes())
            .map_err(|e| fs_error("write the temporary file", &tmp, e))?;
        f.sync_all()
            .map_err(|e| fs_error("flush the temporary file", &tmp, e))
    })();
    if let Err(e) = staged {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    let published = match std::fs::hard_link(&tmp, &resolved) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(file_exists_error(path)),
        // Not every filesystem can hard-link: FAT32 and exFAT (USB sticks, SD
        // cards) return ERROR_INVALID_FUNCTION. `copy_new` refuses an existing
        // destination itself, so the exclusivity guarantee survives.
        Err(e) if is_link_unsupported(&e) => copy_new(&tmp, &resolved).map_err(|e| {
            if e.kind() == io::ErrorKind::AlreadyExists {
                file_exists_error(path)
            } else {
                fs_error("create", &resolved, e)
            }
        }),
        Err(e) => Err(fs_error("create", &resolved, e)),
    };
    let _ = std::fs::remove_file(&tmp);
    published?;
    sync_parent_dir(&resolved)
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
        // `NotFound` is the ordinary "this note has no history yet" — an empty
        // list is the truth. Any OTHER failure (permissions, a file where the
        // directory should be) is a hole, and reporting it as "no history" tells
        // the user their versions are gone when they are merely unreadable.
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(fs_error("read the history of", Path::new(path), e)),
    };
    for entry in rd {
        // A single unreadable entry is a hole too: skipping it silently turned
        // a partially readable history into a shorter list, which the panel
        // cannot tell apart from "this is all there is". Name the entry and
        // fail instead - the caller already shows an unreadable history as an
        // error, and an error is at least the truth.
        let entry = entry.map_err(|e| fs_error("read the history of", Path::new(path), e))?;
        let p = entry.path();
        let id = entry.file_name().to_string_lossy().to_string();
        // Temp litter from an interrupted snapshot write is not a snapshot, and
        // stat-ing the litter of a crashed write is exactly what could fail.
        if id.starts_with('.') {
            continue;
        }
        let meta = p
            .metadata()
            .map_err(|e| fs_error("read the history entry", &p, e))?;
        if !meta.is_file() {
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
        .map_err(|e| fs_error("open the history folder", &history_dir, e))?;
    let canonical_snapshot = snapshot
        .canonicalize()
        .map_err(|e| fs_error("find the history version", &snapshot, e))?;
    if !canonical_snapshot.starts_with(&canonical_dir) {
        return Err("invalid history id".into());
    }
    std::fs::read_to_string(&canonical_snapshot)
        .map_err(|e| fs_error("read the history version", &canonical_snapshot, e))
}

/// Restore a history snapshot onto the main file atomically; returns the
/// restored content. The content being replaced is snapshotted first (same
/// pipeline and pruning as `write_file`), so a restore can itself be undone
/// from the history panel.
pub fn restore_history(vault_root: &str, path: &str, id: &str) -> Result<String, String> {
    let content = read_history(vault_root, path, id)?;
    let _guard = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
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
    let entries = std::fs::read_dir(dir).map_err(|e| fs_error("list the folder", dir, e))?;
    for entry in entries.flatten() {
        let entry_path = entry.path();
        let name = entry_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let is_symlink = entry
            .file_type()
            .map_err(|e| fs_error("inspect", &entry_path, e))?
            .is_symlink();
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
        std::fs::metadata(source).map_err(|e| fs_error("read the picked file", source, e))?;
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
    let dir = if dir.is_empty() || dir == "." {
        ""
    } else {
        dir.trim_matches('/')
    };
    let (dir_abs, dir_rel) = if dir.is_empty() {
        let month = attachment_month_dir();
        let rel = format!("attachments/{month}");
        let abs = resolve_within(vault_root, &rel)?;
        (abs, rel)
    } else {
        resolve_within_rel(vault_root, dir)?
    };
    std::fs::create_dir_all(&dir_abs).map_err(|e| fs_error("create the folder", &dir_abs, e))?;
    let unique = unique_attachment_name(&name, &dir_abs);
    let relative = format!("{dir_rel}/{unique}");
    let target = resolve_within(vault_root, &relative)?;
    let bytes = std::fs::read(source).map_err(|e| fs_error("read the picked file", source, e))?;
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
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
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
    for n in 0..1000u32 {
        let candidate = if n == 0 {
            format!("{stem}-overflow.{ext}")
        } else {
            format!("{stem}-overflow-{n}.{ext}")
        };
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{stem}-overflow-{}.{ext}", time_nonce())
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
        return Err(format!("attachment type is not an allowed image: {name}"));
    }
    // Path-confinement guard: validates the vault base resolves inside the
    // vault; the binding is unused (the target dir is resolved below via dir_abs).
    let _root = resolve_within(vault_root, ".")?;
    let dir = dir.trim();
    if Path::new(dir).is_absolute() {
        return Err("attachment dir must be vault-relative".into());
    }
    let dir = if dir.is_empty() || dir == "." {
        ""
    } else {
        dir.trim_matches('/')
    };
    let (dir_abs, dir_rel) = if dir.is_empty() {
        let month = attachment_month_dir();
        let rel = format!("attachments/{month}");
        let abs = resolve_within(vault_root, &rel)?;
        (abs, rel)
    } else {
        resolve_within_rel(vault_root, dir)?
    };
    std::fs::create_dir_all(&dir_abs).map_err(|e| fs_error("create the folder", &dir_abs, e))?;
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
    std::fs::create_dir_all(&resolved).map_err(|e| fs_error("create the folder", &resolved, e))?;
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
    // `exists()` follows the filesystem's CASING rules, so on Windows a case-only
    // rename (`note.md` -> `Note.md`) hits the file itself and was rejected with
    // "target already exists: Note.md" — a message naming the very name the user
    // just asked for, which reads as nonsense.
    //
    // The comparison uses the REQUESTED spellings, not the resolved paths:
    // resolution canonicalizes, and canonicalization reports the ON-DISK casing,
    // so a request for `archive/B.md` resolves to `archive/b.md` and would look
    // identical to its own source.
    let normalize = |s: &str| s.replace('\\', "/").to_lowercase();
    let case_only_rename = from != to && normalize(from) == normalize(to);
    if resolved_to.exists() && !case_only_rename {
        return Err(format!("target already exists: {relative_to}"));
    }
    if let Some(parent) = resolved_to.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| fs_error("create the folder containing", parent, e))?;
    }
    if case_only_rename {
        // Two things have to be right here, and the first attempt got both wrong
        // (measured: the rename reported success and the file kept its old name).
        //
        // 1. `resolved_to` is USELESS as the destination. Resolution canonicalizes
        //    before the move, so for `keep.md` -> `KEEP.md` it holds the OLD
        //    spelling — renaming to it is exactly what "does nothing". The
        //    destination is therefore rebuilt from the requested name (that is
        //    where the user's casing lives) on the resolved parent.
        // 2. A direct rename will not change an existing entry's case, so it goes
        //    through a temporary sibling name first. That name wears our staging
        //    shape, so a process death between the two steps leaves something the
        //    vault's temp sweeper recognises rather than an orphan — and the file
        //    is put back under its original name if the second step fails.
        let parent = resolved_to.parent().unwrap_or(Path::new("."));
        let requested_name = to
            .rsplit(['/', '\\'])
            .next()
            .filter(|n| !n.is_empty())
            .unwrap_or("renamed");
        let target = parent.join(requested_name);
        let temp = parent.join(format!(".{requested_name}.{}.tmp", time_nonce()));
        std::fs::rename(&resolved_from, &temp)
            .map_err(|e| fs_error("rename", &resolved_from, e))?;
        if let Err(e) = std::fs::rename(&temp, &target) {
            let _ = std::fs::rename(&temp, &resolved_from);
            return Err(fs_error("rename to", &target, e));
        }
    } else {
        std::fs::rename(&resolved_from, &resolved_to)
            .map_err(|e| fs_error("rename", &resolved_from, e))?;
    }
    // The relative path was canonicalized BEFORE the move, so for a case-only
    // rename it still holds the old spelling. Re-resolve to report what is
    // actually on disk now: the caller stores this string as the tab's path and
    // shows it as the note's name, so `archive/b.md` after a rename to
    // `archive/B.md` would leave the title looking as if nothing happened.
    let relative_to = resolve_within_rel(vault_root, to)
        .map(|(_, rel)| rel)
        .unwrap_or(relative_to);
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
    let Ok(rd) = std::fs::read_dir(&from_dir) else {
        return;
    };
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

#[cfg(test)]
mod write_lock_scope_tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn temp_root(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nekowite-lock-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The write lock is PROCESS-WIDE, not per vault: a save in one vault waits
    /// for a save in another. That is the guarantee the comment on `WRITE_LOCK`
    /// claims, and this test exists so narrowing the lock to a per-vault map has
    /// to be a deliberate act with updated reasoning, not a silent refactor.
    #[test]
    fn the_write_lock_is_process_wide_across_vaults() {
        let vault_a = temp_root("scope-a");
        let vault_b = temp_root("scope-b");
        let b_root = vault_b.to_str().unwrap().to_string();

        let guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (tx, rx) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            let ok = write_file(&b_root, "b.md", "content", None).is_ok();
            let _ = tx.send(ok);
        });

        assert!(
            rx.recv_timeout(Duration::from_millis(250)).is_err(),
            "a write in vault B ran while vault A held the write lock: the lock is no longer process-wide"
        );

        drop(guard);
        assert!(
            rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            "the blocked write must finish once the lock is released"
        );
        handle.join().unwrap();
        let _ = std::fs::remove_dir_all(&vault_a);
        let _ = std::fs::remove_dir_all(&vault_b);
    }

    #[test]
    fn restore_history_waits_on_the_write_lock() {
        let vault = temp_root("restore-lock");
        let root = vault.to_str().unwrap().to_string();
        std::fs::write(vault.join("note.md"), "v1").unwrap();
        write_file(&root, "note.md", "v2", Some(5)).unwrap();
        let id = list_history(&root, "note.md").unwrap()[0].id.clone();

        let guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (tx, rx) = mpsc::channel();
        let root_clone = root.clone();
        let handle = std::thread::spawn(move || {
            let ok = restore_history(&root_clone, "note.md", &id).is_ok();
            let _ = tx.send(ok);
        });

        assert!(
            rx.recv_timeout(Duration::from_millis(250)).is_err(),
            "restore_history ran while the write lock was held"
        );
        drop(guard);
        assert!(
            rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            "restore_history must finish once the lock is released"
        );
        handle.join().unwrap();
        let _ = std::fs::remove_dir_all(&vault);
    }
}

#[cfg(test)]
mod unique_attachment_name_tests {
    use super::*;

    #[test]
    fn overflow_name_is_skipped_when_it_already_exists() {
        let dir = std::env::temp_dir().join(format!(
            "nekowite-attach-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        for n in 0..1000u32 {
            let name = if n == 0 {
                "pic.png".to_string()
            } else {
                format!("pic-{n}.png")
            };
            std::fs::write(dir.join(&name), b"x").unwrap();
        }
        std::fs::write(dir.join("pic-overflow.png"), b"x").unwrap();
        let unique = unique_attachment_name("pic.png", &dir);
        assert_eq!(unique, "pic-overflow-1.png");
        assert!(!dir.join(&unique).exists() || unique != "pic-overflow.png");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
