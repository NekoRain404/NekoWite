//! The eviction half of one note's history: which stored version is the oldest,
//! and dropping the ones past `max`.
//!
//! Split out of [`crate::storage::history_snapshot`], which is the other half of
//! the same lifecycle — writing a version durably and deciding what a failed
//! save does with one. The seam is the same one that module was born with, taken
//! one step further: `metadata_store` is the history KEY, `history_snapshot` is
//! the history FILE, and this is the FILE's retention rule. It belongs apart
//! because it is the only part with an ordering policy of its own, and because
//! that policy is where the bug was: a same-millisecond group sorted by name
//! keeps the WRONG version, which is a data-loss defect that has nothing to do
//! with how the bytes got there.
//!
//! A leaf: `std` only. Nothing here knows how a snapshot is written, staged or
//! settled.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Creation order within one shared mtime: a snapshot is written `{ms}.{ext}`
/// first, then `{ms}-1.{ext}`, `{ms}-2.{ext}`, … so the collision suffix IS the
/// age order, lower meaning older.
///
/// Sorting these names alphabetically gets that backwards — `-` sorts before
/// `.`, so `<ms>-1.md` compares LESS than `<ms>.md` even though it was written
/// later. That is what made the newest snapshot of a same-millisecond group
/// sort as the oldest and be pruned while an older sibling survived.
fn snapshot_collision_suffix(name: &str) -> u64 {
    let Some((stem, _ext)) = name.rsplit_once('.') else {
        return 0;
    };
    match stem.rsplit_once('-') {
        Some((_, n)) => n.parse().unwrap_or(0),
        None => 0,
    }
}

/// Keep only the `max` newest snapshot files (by modified time) in `dir`.
pub(crate) fn prune_history(dir: &Path, max: usize) -> Result<(), String> {
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
        // Newest first. File mtimes are only jiffy-coarse, so snapshots written
        // in quick succession can share one timestamp; break ties by the
        // COLLISION SUFFIX, not by name. Plain name order gets this backwards —
        // `-` sorts before `.`, so `<ms>-1.md` compares less than `<ms>.md`
        // even though it was written later — which made the newest snapshot of
        // a same-millisecond group sort as the oldest one and be deleted first
        // while an older sibling survived.
        entries.sort_by(|a, b| {
            let an = a.0.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let bn = b.0.file_name().and_then(|n| n.to_str()).unwrap_or("");
            b.1.cmp(&a.1)
                .then(snapshot_collision_suffix(bn).cmp(&snapshot_collision_suffix(an)))
                .then(an.cmp(bn))
        });
        for (p, _) in entries.into_iter().skip(max) {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(())
}

#[cfg(test)]
mod snapshot_pruning_tests {
    use super::{prune_history, snapshot_collision_suffix};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[test]
    fn the_collision_suffix_is_the_age_order() {
        assert_eq!(snapshot_collision_suffix("1700.md"), 0);
        assert_eq!(snapshot_collision_suffix("1700-1.md"), 1);
        assert_eq!(snapshot_collision_suffix("1700-12.markdown"), 12);
        // Anything that is not `<stem>-<n>.<ext>` belongs to no collision group.
        assert_eq!(snapshot_collision_suffix("notes.md"), 0);
        assert_eq!(snapshot_collision_suffix("no-extension"), 0);
    }

    #[test]
    fn pruning_a_same_millisecond_group_keeps_the_newest_snapshot() {
        let dir = std::env::temp_dir().join(format!(
            "nekowite-prune-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();

        // A snapshot is written `<ms>.md` first, then `-1`, then `-2`, so
        // `1700-2.md` is the NEWEST of the group.
        let names = ["1700.md", "1700-1.md", "1700-2.md"];
        for name in names {
            std::fs::write(dir.join(name), name).unwrap();
        }
        // Pin one shared mtime: that is what a jiffy-coarse clock produces for
        // snapshots written in quick succession, and without it the tie-break
        // this test is about never runs.
        let shared = SystemTime::now() - Duration::from_secs(60);
        for name in names {
            std::fs::OpenOptions::new()
                .write(true)
                .open(dir.join(name))
                .unwrap()
                .set_modified(shared)
                .unwrap();
        }

        prune_history(&dir, 1).unwrap();

        let kept: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            kept,
            vec!["1700-2.md".to_string()],
            "pruning must drop the OLDEST of the group, not the newest"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
