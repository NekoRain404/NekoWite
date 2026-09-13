//! Consistency of the metadata side tables (trash) and of the create-only
//! writes that publish new files into a vault.
//!
//! Every test here is about the same shape: a check and the action that depends
//! on it must be ONE step. "Is this name free?" followed by a separate write,
//! and "is the restore target occupied?" followed by a separate rename, both
//! leave a gap in which another writer claims the entry — which the second step
//! then destroys while telling its caller it succeeded. The tests drive real
//! races (threads released together, or two operations landing in the same
//! clock tick) rather than asserting on a helper.

use nekowite_lib::storage::file_store::{
    import_attachment, read_file, save_attachment, write_file,
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
