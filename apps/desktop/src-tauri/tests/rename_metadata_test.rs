//! Consistency of the metadata side tables (trash, history) and of the
//! create-only writes that publish new files into a vault.
//!
//! Every test here is about the same shape: a check and the action that depends
//! on it must be ONE step. "Is this name free?" followed by a separate write,
//! "is the restore target occupied?" followed by a separate rename, and "is this
//! only a change of case?" answered by lowercasing two strings, all leave a gap
//! or a wrong answer that the second step then acts on — destroying an entry the
//! user never touched while telling its caller it succeeded. The tests drive
//! real races (threads released together, or two operations landing in the same
//! clock tick) rather than asserting on a helper.

use nekowite_lib::domain::path_policy::encode_rel_path;
use nekowite_lib::storage::file_store::{
    import_attachment, list_history, read_file, read_history, rename_entry, save_attachment,
    write_file,
};
use nekowite_lib::storage::trash_store::{delete_file, list_trash, restore_from_trash};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

fn temp_vault(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nekowite-meta-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The trash keys of two deletes of the same path are stamped with the clock,
/// so the deletes whose entries a test wants to keep apart are paced.
fn tick() {
    std::thread::sleep(std::time::Duration::from_millis(15));
}

fn vault_bytes(vault: &Path, rel: &str) -> Vec<u8> {
    std::fs::read(vault.join(rel)).unwrap_or_else(|e| panic!("reading {rel}: {e}"))
}

/// Whether this filesystem tells `note.md` and `Note.md` apart.
///
/// A case-only rename is a defect of a case-SENSITIVE filesystem: there the two
/// spellings are two files, and one of them can be destroyed. Where the
/// filesystem folds case they are one file, there is no second file to keep, and
/// a test that asserted on it would be asserting on a scenario that cannot
/// happen — so it says so instead.
fn fs_distinguishes_case(dir: &Path) -> bool {
    let lower = dir.join("case-probe.md");
    let upper = dir.join("CASE-PROBE.md");
    std::fs::write(&lower, "probe").unwrap();
    let distinct = !upper.exists();
    let _ = std::fs::remove_file(&lower);
    let _ = std::fs::remove_file(&upper);
    distinct
}

/// How many writers race for one attachment name, and how many times.
///
/// One run of two threads is a coin flip: on a fast filesystem the whole
/// save is shorter than the scheduler's wake-up skew, so the loser may well
/// start after the winner has finished. Repeated rounds released together make
/// a lost payload the only way the test can pass.
const RACERS: usize = 4;
const ROUNDS: usize = 25;

/// Rounds of `RACERS` pastes of the same file name, released together.
///
/// The name used to be chosen by a free-name scan and written by
/// `atomic_write_bytes` as two separate steps, so several writers saw `race.png`
/// free and all renamed their temp file onto it: every paste but the last was
/// destroyed, and all callers were handed the SAME path while only one payload
/// was ever readable. The name has to be claimed by the create itself, so the
/// losers of the race land on the next free name instead of overwriting the
/// winner.
#[test]
fn concurrent_pastes_of_one_name_keep_every_payload() {
    let vault = temp_vault("paste-race");
    let root = vault.to_str().unwrap().to_string();

    let barrier = Arc::new(Barrier::new(RACERS));
    let handles: Vec<_> = (0..RACERS as u8)
        .map(|i| {
            let root = root.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let payload = vec![b'A' + i; 256 * 1024];
                let encoded = b64(&payload);
                let mut written = Vec::new();
                for round in 0..ROUNDS {
                    barrier.wait();
                    let path = save_attachment(&root, &format!("race-{round}.png"), &encoded, "")
                        .expect("a concurrent paste must not fail");
                    written.push((path, payload.clone()));
                }
                written
            })
        })
        .collect();
    let per_thread: Vec<Vec<(String, Vec<u8>)>> = handles
        .into_iter()
        .map(|h| h.join().expect("paste thread panicked"))
        .collect();

    for round in 0..ROUNDS {
        let round_paths: Vec<&String> = per_thread.iter().map(|w| &w[round].0).collect();
        let mut unique = round_paths.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(
            unique.len(),
            round_paths.len(),
            "round {round}: two pastes claimed the same path ({round_paths:?}), so a payload is already gone"
        );
        for (path, payload) in per_thread.iter().map(|w| &w[round]) {
            assert_eq!(
                &vault_bytes(&vault, path),
                payload,
                "round {round}: the payload of {path} is not the one its own caller wrote"
            );
        }
    }
    let _ = std::fs::remove_dir_all(&vault);
}

/// The same race on the picker path: files with the same name picked from
/// different folders and imported together.
#[test]
fn concurrent_imports_of_one_name_keep_every_file() {
    let vault = temp_vault("import-race");
    let root = vault.to_str().unwrap().to_string();
    // Every source is named `race-<round>.png` in a folder of its own, so the
    // picks share one file name while never sharing a path.
    let source_dirs: Vec<PathBuf> = (0..RACERS)
        .map(|i| {
            let dir = std::env::temp_dir()
                .join(format!("nekowite-meta-import-{}-{i}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            for round in 0..ROUNDS {
                std::fs::write(
                    dir.join(format!("race-{round}.png")),
                    vec![b'a' + i as u8; 256 * 1024],
                )
                .unwrap();
            }
            dir
        })
        .collect();

    let barrier = Arc::new(Barrier::new(RACERS));
    let handles: Vec<_> = source_dirs
        .iter()
        .cloned()
        .enumerate()
        .map(|(i, dir)| {
            let root = root.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let body = vec![b'a' + i as u8; 256 * 1024];
                let mut imported = Vec::new();
                for round in 0..ROUNDS {
                    barrier.wait();
                    let picked = dir.join(format!("race-{round}.png"));
                    let path = import_attachment(&root, picked.to_str().unwrap(), "assets")
                        .expect("a concurrent import must not fail");
                    imported.push((path, body.clone()));
                }
                imported
            })
        })
        .collect();
    let per_thread: Vec<Vec<(String, Vec<u8>)>> = handles
        .into_iter()
        .map(|h| h.join().expect("import thread panicked"))
        .collect();

    for round in 0..ROUNDS {
        let round_paths: Vec<&String> = per_thread.iter().map(|w| &w[round].0).collect();
        let mut unique = round_paths.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(
            unique.len(),
            round_paths.len(),
            "round {round}: two imports claimed the same path ({round_paths:?}), so an image is already gone"
        );
        for (path, body) in per_thread.iter().map(|w| &w[round]) {
            assert_eq!(
                &vault_bytes(&vault, path),
                body,
                "round {round}: the bytes of {path} are not the ones that import copied"
            );
        }
    }
    for dir in &source_dirs {
        let _ = std::fs::remove_dir_all(dir);
    }
    let _ = std::fs::remove_dir_all(&vault);
}

/// Two restores of two trashed entries that share one original path.
///
/// Both see the original path occupied and compute a `-restored-<ms>` name from
/// the clock. Two restores run in the same millisecond therefore compute the
/// SAME destination, and `fs::rename` replaces what is already there: the entry
/// restored first was silently destroyed by the entry restored second, and both
/// callers were handed the same path. The destination has to be claimed by the
/// move itself, so a taken name pushes the second restore to the next stamp.
#[test]
fn restores_in_the_same_millisecond_keep_both_entries() {
    let vault = temp_vault("restore-collision");
    let root = vault.to_str().unwrap().to_string();

    // Repeated: the two restores only collide when both stamps land in the same
    // millisecond, so one round is a coin flip on a coarse clock while twenty
    // rounds make a lost entry the only way to pass.
    for round in 0..20u32 {
        let first = format!("first-{round}");
        let second = format!("second-{round}");
        write_file(&root, "docs/a.md", &first, None).unwrap();
        let entry_first = delete_file(&root, "docs/a.md").unwrap();
        // Distinct trash keys for the two entries: the collision this test is
        // about happens at RESTORE time, not at delete time.
        tick();
        write_file(&root, "docs/a.md", &second, None).unwrap();
        let entry_second = delete_file(&root, "docs/a.md").unwrap();
        write_file(&root, "docs/a.md", "occupant", None).unwrap();

        let restored_first = restore_from_trash(&root, &entry_first).unwrap();
        let restored_second = restore_from_trash(&root, &entry_second).unwrap();

        assert_ne!(
            restored_first, restored_second,
            "round {round}: two entries were restored onto one path"
        );
        assert_eq!(
            read_file(&root, &restored_first).unwrap(),
            first,
            "round {round}: the first restored entry was overwritten"
        );
        assert_eq!(
            read_file(&root, &restored_second).unwrap(),
            second,
            "round {round}: the second restored entry is not its own content"
        );
        assert!(
            list_trash(&root).unwrap().is_empty(),
            "round {round}: every entry must leave the trash"
        );
    }
    let _ = std::fs::remove_dir_all(&vault);
}

/// A trashed folder restored where a file now sits (and vice versa): the type
/// conflict must send the restore to a free name instead of letting `rename`
/// replace the entry that took the name, and the folder's contents come back.
#[test]
fn restoring_a_folder_never_replaces_the_entry_that_took_its_name() {
    let vault = temp_vault("restore-folder");
    let root = vault.to_str().unwrap().to_string();

    std::fs::create_dir_all(vault.join("docs")).unwrap();
    std::fs::write(vault.join("docs/a.md"), "trashed").unwrap();
    let entry = delete_file(&root, "docs").unwrap();
    std::fs::write(vault.join("docs"), "occupant").unwrap();

    let restored = restore_from_trash(&root, &entry).unwrap();
    assert!(
        restored.contains("-restored-"),
        "the occupant must not be replaced, got {restored}"
    );
    assert_eq!(vault_bytes(&vault, "docs"), b"occupant");
    assert_eq!(
        read_file(&root, &format!("{restored}/a.md")).unwrap(),
        "trashed"
    );
    let _ = std::fs::remove_dir_all(&vault);
}

/// A restore that finds its own original path free still lands exactly there —
/// the create-only move must not turn the ordinary case into a suffixed name.
#[test]
fn a_free_restore_target_is_used_as_is() {
    let vault = temp_vault("restore-free");
    let root = vault.to_str().unwrap().to_string();
    write_file(&root, "docs/a.md", "hello", None).unwrap();
    let entry = delete_file(&root, "docs/a.md").unwrap();

    let restored = restore_from_trash(&root, &entry).unwrap();
    assert!(restored.ends_with("docs/a.md"), "got {restored}");
    assert_eq!(read_file(&root, "docs/a.md").unwrap(), "hello");
    let _ = std::fs::remove_dir_all(&vault);
}

/// Renaming `note.md` onto `Note.md` must not replace the file that is already
/// there, even though the two names differ only in case.
///
/// The rename used to answer "is this only a change of case?" by lowercasing the
/// two requested spellings. That answer skipped the "target already exists"
/// refusal and went into the two-step `fs::rename` written for a case change,
/// and `rename` REPLACES whatever sits at the destination. On a case-sensitive
/// filesystem the destination is a DIFFERENT file — the user's other note — so
/// renaming the first one destroyed the second one's text, removed the source,
/// and returned `Ok("Note.md")` over a note nobody had touched. Casing is not
/// file identity; only the entry being its own target justifies skipping the
/// collision check.
#[test]
fn a_rename_onto_a_case_variant_name_never_replaces_the_other_file() {
    let vault = temp_vault("rename-case-clash");
    if !fs_distinguishes_case(&vault) {
        // One file, two spellings: this filesystem has no second file to keep.
        let _ = std::fs::remove_dir_all(&vault);
        return;
    }
    let root = vault.to_str().unwrap().to_string();
    std::fs::write(vault.join("note.md"), "SOURCE").unwrap();
    std::fs::write(vault.join("Note.md"), "TARGET").unwrap();

    let outcome = rename_entry(&root, "note.md", "Note.md");

    // The two bodies come first: THEY are what this test is about, and a run
    // that fails on the return value alone leaves the loss unstated.
    assert_eq!(
        std::fs::read_to_string(vault.join("Note.md")).unwrap(),
        "TARGET",
        "the file the user did not ask to touch must keep its own text \
         (the rename reported {outcome:?})"
    );
    assert_eq!(
        std::fs::read_to_string(vault.join("note.md")).unwrap(),
        "SOURCE",
        "a refused rename leaves its own source where it was"
    );
    assert!(
        outcome.is_err(),
        "another file holds that name, so the rename must be refused, got {outcome:?}"
    );

    // The refusal is about the OCCUPIED name and not about case: an ordinary
    // rename still moves the file, and so does a case change whose target name
    // is genuinely free.
    let renamed = rename_entry(&root, "note.md", "notes/kept.md").unwrap();
    assert_eq!(renamed, "notes/kept.md");
    assert_eq!(vault_bytes(&vault, "notes/kept.md"), b"SOURCE");

    let cased = rename_entry(&root, "notes/kept.md", "notes/KEPT.md").unwrap();
    assert_eq!(cased, "notes/KEPT.md");
    assert_eq!(vault_bytes(&vault, "notes/KEPT.md"), b"SOURCE");
    assert_eq!(
        std::fs::read_to_string(vault.join("Note.md")).unwrap(),
        "TARGET",
        "the untouched file is still untouched after the renames around it"
    );

    let _ = std::fs::remove_dir_all(&vault);
}

/// Renaming a folder carries the history of every note inside it.
///
/// History is keyed by the vault-relative path, so the snapshots of
/// `docs/sub/a.md` live under the key for `docs/sub/a.md`. The rename migrated
/// that key for a renamed FILE only, and a folder rename was a plain move: the
/// snapshots stayed under keys nothing looks up any more, the history panel of
/// every note in the renamed folder came up empty, and the versions were
/// unreachable rather than deleted — the worst of both, because the user has no
/// way to tell them apart from lost.
#[test]
fn a_renamed_folder_carries_its_notes_history() {
    let vault = temp_vault("rename-dir-history");
    let root = vault.to_str().unwrap().to_string();

    // Two levels down, three versions written so two snapshots exist.
    write_file(&root, "docs/sub/a.md", "v1", Some(10)).unwrap();
    tick();
    write_file(&root, "docs/sub/a.md", "v2", Some(10)).unwrap();
    tick();
    write_file(&root, "docs/sub/a.md", "v3", Some(10)).unwrap();
    let before = list_history(&root, "docs/sub/a.md").unwrap();
    assert_eq!(before.len(), 2, "two versions of history to carry");
    let oldest = before[1].id.clone();
    let newest = before[0].id.clone();
    assert_eq!(read_history(&root, "docs/sub/a.md", &oldest).unwrap(), "v1");
    assert_eq!(read_history(&root, "docs/sub/a.md", &newest).unwrap(), "v2");

    // A second note in the same folder, so the migration is not about one file.
    write_file(&root, "docs/other.md", "o1", Some(10)).unwrap();
    tick();
    write_file(&root, "docs/other.md", "o2", Some(10)).unwrap();
    assert_eq!(list_history(&root, "docs/other.md").unwrap().len(), 1);

    rename_entry(&root, "docs", "archive").unwrap();

    let after = list_history(&root, "archive/sub/a.md").unwrap();
    assert_eq!(
        after.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
        vec![newest.clone(), oldest.clone()],
        "every version followed the folder, newest first, under its own id"
    );
    assert_eq!(
        read_history(&root, "archive/sub/a.md", &oldest).unwrap(),
        "v1",
        "the oldest version still reads as the text it was"
    );
    assert_eq!(
        read_history(&root, "archive/sub/a.md", &newest).unwrap(),
        "v2"
    );
    assert_eq!(
        list_history(&root, "archive/other.md").unwrap().len(),
        1,
        "the other note in the folder kept its version too"
    );
    assert!(
        list_history(&root, "docs/sub/a.md").unwrap().is_empty(),
        "the history MOVED: a copy left at the old key would resurface if the \
         old folder were ever created again"
    );

    let _ = std::fs::remove_dir_all(&vault);
}

/// A folder rename merges into history the destination key already holds.
///
/// The destination key can be occupied without the destination folder existing:
/// a note that was saved at `archive/a.md` and then had its folder deleted
/// leaves `.nekowite/history/archive%2Fa.md` behind. Renaming `docs` onto
/// `archive` then has to merge the two version sets — both files of snapshots
/// are the user's, and one of them being renamed over the other is a silent
/// loss of history.
#[test]
fn a_renamed_folder_merges_the_history_the_target_already_has() {
    let vault = temp_vault("rename-dir-history-merge");
    let root = vault.to_str().unwrap().to_string();

    write_file(&root, "archive/a.md", "x1", Some(10)).unwrap();
    tick();
    write_file(&root, "archive/a.md", "x2", Some(10)).unwrap();
    // The folder goes away; its history key does not.
    std::fs::remove_dir_all(vault.join("archive")).unwrap();
    assert_eq!(
        list_history(&root, "archive/a.md").unwrap().len(),
        1,
        "the old key still holds the version the deleted folder left"
    );

    write_file(&root, "docs/a.md", "d1", Some(10)).unwrap();
    tick();
    write_file(&root, "docs/a.md", "d2", Some(10)).unwrap();

    rename_entry(&root, "docs", "archive").unwrap();

    // Newest first, and in the order they were written: `d1` was snapshotted
    // after `x1` was, so a merge that lost or re-stamped one of them shows up
    // here as the wrong order and not merely as a missing entry.
    let merged = list_history(&root, "archive/a.md").unwrap();
    let bodies: Vec<String> = merged
        .iter()
        .map(|e| read_history(&root, "archive/a.md", &e.id).unwrap())
        .collect();
    assert_eq!(
        bodies,
        vec!["d1".to_string(), "x1".to_string()],
        "the versions from both keys are all there, in time order: {merged:?}"
    );
    assert_eq!(
        list_history(&root, "docs/a.md").unwrap().len(),
        0,
        "and nothing is left behind at the old key"
    );

    let _ = std::fs::remove_dir_all(&vault);
}

/// Two keys can hold a version with the SAME id, and the merge must keep both.
///
/// A snapshot id is the millisecond it was written in, so two notes can share
/// one — and after a folder rename the two keys are in the same directory. The
/// name the second one wants is then taken by the first, and `fs::rename`
/// REPLACES what it finds there: the merge has to invent a second name, or one
/// of the two versions is destroyed by the very move meant to preserve it.
#[test]
fn a_folder_rename_merges_two_versions_that_share_one_id() {
    let vault = temp_vault("rename-dir-history-same-id");
    let root = vault.to_str().unwrap().to_string();

    write_file(&root, "docs/a.md", "d1", Some(10)).unwrap();
    tick();
    write_file(&root, "docs/a.md", "d2", Some(10)).unwrap();
    let moved = list_history(&root, "docs/a.md").unwrap();
    assert_eq!(moved.len(), 1);
    let shared_id = moved[0].id.clone();
    assert_eq!(read_history(&root, "docs/a.md", &shared_id).unwrap(), "d1");

    // The key the rename is about to merge into, already holding a DIFFERENT
    // version under that same id.
    let history_root = vault.join(".nekowite").join("history");
    let target_key = history_root.join(encode_rel_path("archive/a.md"));
    std::fs::create_dir_all(&target_key).unwrap();
    std::fs::write(target_key.join(&shared_id), "x1").unwrap();

    rename_entry(&root, "docs", "archive").unwrap();

    let merged = list_history(&root, "archive/a.md").unwrap();
    let mut bodies: Vec<String> = merged
        .iter()
        .map(|e| read_history(&root, "archive/a.md", &e.id).unwrap())
        .collect();
    bodies.sort();
    assert_eq!(
        bodies,
        vec!["d1".to_string(), "x1".to_string()],
        "both versions of the shared id survived the merge: {merged:?}"
    );

    let _ = std::fs::remove_dir_all(&vault);
}

/// A history key that cannot follow the folder loses nothing.
///
/// The migration is best-effort by design — a rename that has already happened
/// must not be reported as failed because a side table could not be moved — so
/// the one thing it may never do is destroy the snapshots it could not move.
/// Here the destination key is occupied by a FILE, which is what a permissions
/// problem, a full disk or a foreign object under `.nekowite/history` looks like
/// to the resolver: that note's history stays at its old key, complete, and the
/// keys that could move still do.
#[test]
fn a_history_key_that_cannot_follow_the_folder_keeps_every_version() {
    let vault = temp_vault("rename-dir-history-blocked");
    let root = vault.to_str().unwrap().to_string();

    write_file(&root, "docs/stuck.md", "s1", Some(10)).unwrap();
    tick();
    write_file(&root, "docs/stuck.md", "s2", Some(10)).unwrap();
    let stuck = list_history(&root, "docs/stuck.md").unwrap();
    assert_eq!(stuck.len(), 1);

    write_file(&root, "docs/other.md", "o1", Some(10)).unwrap();
    tick();
    write_file(&root, "docs/other.md", "o2", Some(10)).unwrap();

    // Occupy the destination key `archive/stuck.md` with a file.
    let history_root = vault.join(".nekowite").join("history");
    std::fs::create_dir_all(&history_root).unwrap();
    std::fs::write(
        history_root.join(encode_rel_path("archive/stuck.md")),
        "blocker",
    )
    .unwrap();

    let renamed = rename_entry(&root, "docs", "archive").unwrap();
    assert_eq!(renamed, "archive");

    // The key that could not move is untouched: same id, same text, still
    // readable — which is what makes the failure recoverable instead of final.
    let still = list_history(&root, "docs/stuck.md").unwrap();
    assert_eq!(still.len(), 1, "no version was dropped by the failed move");
    assert_eq!(still[0].id, stuck[0].id, "and it is the same version");
    assert_eq!(
        read_history(&root, "docs/stuck.md", &still[0].id).unwrap(),
        "s1"
    );
    assert!(
        list_history(&root, "archive/stuck.md").is_err(),
        "the blocked key holds a file: the panel has to report that as \
         unreadable rather than as 'this note has no versions'"
    );
    // The note whose key was free still followed its folder.
    assert_eq!(list_history(&root, "archive/other.md").unwrap().len(), 1);

    let _ = std::fs::remove_dir_all(&vault);
}
