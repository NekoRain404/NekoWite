//! The temp-file lifecycle: what a staged write is named ([`temp_sibling`]),
//! how an existing temp file is told apart from a user's own `*.tmp`
//! ([`is_our_temp_file`]), and when a leftover one is swept
//! ([`cleanup_stale_tmp`]).
//!
//! Those three are one rule seen from three sides — the name a writer stages
//! under IS the name the sweeper has to recognise, and it is recognised by the
//! shape the nonce gives it — so they are defined together here. Keeping the
//! shape in one place is also what stops a future change to the nonce from
//! quietly turning every temp file into either litter the sweeper never
//! collects, or a file the sweeper deletes while a writer is still using it.
//!
//! This is a leaf: it knows about paths, clocks and filesystems, and nothing
//! about vaults, history keys or attachment names.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::errors::fs_error;

/// Sequence that keeps every [`unique_nonce`] distinct.
static NONCE_SEQ: AtomicU32 = AtomicU32::new(0);

/// Nonce for the `.{name}.{nonce}.tmp` siblings the write pipelines stage
/// through: no two callers can pick the same one, so `create_new` on the temp
/// file can never be refused by a concurrent writer.
///
/// `create_new` is what keeps concurrent writers out of each other's temp file,
/// so the NAME has to be unique — and a clock reading alone does not deliver
/// that. Four pastes of one file name released together read the same
/// nanosecond often enough to break ~40% of runs of the paste race, and the
/// damage was not confined to the loser: its cleanup removed the WINNER's
/// staged bytes, so the writer that had already staged its file failed on the
/// publish as well (`os error 17` followed by `os error 2` — one paste lost
/// twice over). `fetch_add` cannot hand out a value twice, so distinctness is a
/// property of the sequence rather than of the clock's resolution. The clock
/// stays because a restarted process must not reuse names its own crash litter
/// still holds, and the pid separates live processes, whose sequences both
/// restart at 0. Packed [clock 96][pid 32][seq 32] so the fields cannot overlap.
pub(crate) fn unique_nonce() -> u128 {
    let seq = NONCE_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    (((nanos << 32) | u128::from(std::process::id())) << 32) | u128::from(seq)
}

/// The temp sibling a writer stages `name` through, in the SAME directory as
/// the target so the publish is a same-filesystem rename or hard link and a
/// reader never sees a half-written file under the real name.
pub(crate) fn temp_sibling(parent: &Path, name: &str) -> PathBuf {
    parent.join(format!(".{name}.{}.tmp", unique_nonce()))
}

/// Whether `name` matches the temp-file shape this crate writes:
/// `.<original name>.<numeric nonce>.tmp`.
///
/// The leading dot keeps these out of the file tree and the numeric nonce
/// distinguishes them from a file a user or another tool named `*.tmp`. Both
/// parts matter: the dot alone would still claim `.gitignore.tmp`-style names
/// that are not ours, and the suffix alone (what this used to check) claimed
/// every `.tmp` file in the vault — a user's `draft.tmp` was deleted by the
/// next save in that folder, permanently, with no trash entry and no history
/// snapshot to restore from.
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

/// How old a `.tmp` sibling must be before the next write in that directory
/// treats it as crash litter and cleans it up. Fresh temp files written by a
/// currently-running writer (unique nonce name, recent mtime) are never
/// touched, so cleaning cannot race a live write.
pub(crate) const STALE_TMP_MAX_AGE: Duration = Duration::from_secs(3600);

/// Remove `.tmp` siblings in `dir` whose modified time is older than
/// `max_age`, returning how many were removed. These are crash remnants of
/// [`crate::storage::atomic_write::atomic_write`] and
/// [`crate::storage::metadata_store::snapshot_history`] (which stage a
/// [`temp_sibling`] then rename or link it into place); on a crash the temp
/// file survives. Cleaning is bounded to mtime as well as to the name shape, so
/// a temp file a live writer just created is never deleted mid-write.
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

#[cfg(test)]
mod temp_name_tests {
    use super::*;
    use std::collections::HashSet;

    /// The invariant every temp name rests on, and the one a clock reading
    /// cannot give: concurrent callers never share a nonce.
    ///
    /// The sampling is deliberately dense — the paste race reaches this same
    /// property by accident, through four threads and a filesystem, and only
    /// when the schedule lines up. Sampling 8 x 1000 nonces across threads
    /// instead makes a clock-only version (the bug this replaced) duplicate in
    /// 20 of 20 measured runs, while the sequence never does, so a change back
    /// to "the clock is unique enough" cannot land quietly.
    #[test]
    fn concurrent_nonces_never_repeat() {
        const CALLS: usize = 1000;
        let seen: HashSet<u128> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..8)
                .map(|_| s.spawn(|| (0..CALLS).map(|_| unique_nonce()).collect::<Vec<_>>()))
                .collect();
            handles
                .into_iter()
                .flat_map(|h| h.join().unwrap())
                .collect()
        });
        assert_eq!(seen.len(), 8 * CALLS, "the same nonce was handed out twice");
    }

    /// The shape the writer stages under has to be the shape the sweeper
    /// recognises, or crash litter is never collected.
    #[test]
    fn the_names_written_are_the_names_recognised() {
        let dir = Path::new("/vault/notes");
        let first = temp_sibling(dir, "note.md");
        assert_ne!(first, temp_sibling(dir, "note.md"));
        for name in ["note.md", ".hidden", "no-extension", "a.b.c.png"] {
            let temp = temp_sibling(dir, name);
            let file = temp.file_name().unwrap().to_str().unwrap();
            assert!(
                is_our_temp_file(file),
                "{file} would never be swept as crash litter"
            );
        }
    }
}
