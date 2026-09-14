//! The publish's treatment of the file it replaces.
//!
//! `atomic_write` publishes by renaming a staged temp sibling over the target,
//! and a rename needs write permission on the DIRECTORY and none at all on the
//! file. Two things followed from that:
//!
//!   * the file that appeared under the name carried the TEMP file's mode, so a
//!     note the user had set to `0600`, `0640` or `0604` came back as the
//!     process default;
//!   * a file the user had made read-only was replaced anyway, and nothing told
//!     them.
//!
//! Both are pinned here against a real filesystem, because the defect is in what
//! the two syscalls leave behind and no in-memory test can see it. Only unix can
//! express either — and only unix is where `chmod 444` is the act the audit
//! demonstrated — so the file is compiled only there. The `readonly` attribute
//! Windows has instead reaches the same code with a one-bit mode.
#![cfg(unix)]

use nekowite_lib::storage::destination_file::READ_ONLY_PREFIX;
use nekowite_lib::storage::file_store::{atomic_write, list_history, restore_history, write_file};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

fn temp_vault(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nekowite-publish-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn set_mode(path: &Path, mode: u32) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// The permission bits alone: `mode()` carries the file-type bits too, and
/// comparing those would make the assertion about something else.
fn mode_of(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o7777
}

/// Staged siblings this crate's write pipeline names `.<name>.<nonce>.tmp`.
fn tmp_leftovers(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with('.') && name.ends_with(".tmp"))
        .collect()
}

/// The mode of the file under the destination's name must survive the publish.
///
/// Two modes are asserted on purpose: a single one could equal whatever the
/// test process's umask hands the staged temp file, which would let the
/// un-fixed pipeline pass by accident.
#[test]
fn publishing_keeps_the_destination_mode() {
    let vault = temp_vault("mode");
    let note = vault.join("note.md");

    for mode in [0o604, 0o640] {
        atomic_write(&note, "v1").unwrap();
        set_mode(&note, mode);
        atomic_write(&note, "v2").unwrap();

        assert_eq!(std::fs::read_to_string(&note).unwrap(), "v2");
        assert_eq!(
            mode_of(&note),
            mode,
            "the publish replaced mode {mode:o} with the staged temp file's: \
             the mode the user set belongs to the file, not to the name"
        );
    }

    let _ = std::fs::remove_dir_all(&vault);
}

/// The same through the user-facing save, which is the path the audit hit.
#[test]
fn saving_a_note_keeps_its_mode() {
    let vault = temp_vault("save-mode");
    let root = vault.to_str().unwrap().to_string();
    std::fs::write(vault.join("note.md"), "v1").unwrap();
    set_mode(&vault.join("note.md"), 0o600);

    write_file(&root, "note.md", "v2", Some(5)).unwrap();

    assert_eq!(
        std::fs::read_to_string(vault.join("note.md")).unwrap(),
        "v2"
    );
    assert_eq!(
        mode_of(&vault.join("note.md")),
        0o600,
        "an edit must not widen the permissions the user chose for the note"
    );
    let _ = std::fs::remove_dir_all(&vault);
}

/// A destination that does not exist yet has no mode to carry over: the new
/// file gets exactly what any new file gets, and nothing is invented.
#[test]
fn a_new_file_gets_the_process_default_mode() {
    let vault = temp_vault("new-file");
    let note = vault.join("new.md");

    atomic_write(&note, "first").unwrap();
    drop(std::fs::File::create(vault.join("control")).unwrap());

    assert_eq!(std::fs::read_to_string(&note).unwrap(), "first");
    assert_eq!(
        mode_of(&note),
        mode_of(&vault.join("control")),
        "a free name gets the default mode, the same one a plain create gives"
    );
    let _ = std::fs::remove_dir_all(&vault);
}

/// A read-only file is not replaced. `rename` replaces it anyway because the
/// permission it needs is the directory's, so without this the save succeeds
/// against the user's stated intent and says nothing about it.
#[test]
fn a_read_only_note_is_not_replaced() {
    let vault = temp_vault("readonly");
    let root = vault.to_str().unwrap().to_string();
    let note = vault.join("ro.md");

    for mode in [0o444, 0o400] {
        std::fs::write(&note, "protected").unwrap();
        set_mode(&note, mode);

        let error = write_file(&root, "ro.md", "overwritten", Some(5))
            .expect_err("a save over a read-only note must be refused, not silently done");

        assert!(error.contains("ro.md"), "names the file: {error}");
        assert!(error.contains("read-only"), "names the reason: {error}");
        assert!(
            error.contains("left untouched"),
            "says the file is still there: {error}"
        );
        // The frontend answers a refusal differently from a failure — one is a
        // decision no retry changes, the other is an error worth repeating — and
        // it reads the TOKEN to tell them apart, never the sentence above, which
        // is copy and free to change. The literal is the mirror of
        // `READ_ONLY_PREFIX` in `apps/desktop/src/stores/write-refusal.ts`; the
        // pair is the whole contract, so both sides pin it.
        assert!(
            error.starts_with(READ_ONLY_PREFIX),
            "the refusal must lead with the token the frontend classifies on: {error}"
        );
        assert_eq!(
            READ_ONLY_PREFIX, "EREADONLY: ",
            "the token moved: update the mirror in stores/write-refusal.ts"
        );

        // Nothing may be lost: same bytes, same mode, and the refusal staged
        // nothing — not even a temp file the sweeper would have to collect.
        assert_eq!(
            std::fs::read_to_string(&note).unwrap(),
            "protected",
            "the refused save changed the content"
        );
        assert_eq!(mode_of(&note), mode, "the refused save changed the mode");
        assert!(
            tmp_leftovers(&vault).is_empty(),
            "the refusal left staged litter: {:?}",
            tmp_leftovers(&vault)
        );

        // The refusal was about the bit, not about the file: clearing it is
        // what the message asks for, and the save then goes through.
        set_mode(&note, 0o644);
        write_file(&root, "ro.md", "now writable", Some(5)).unwrap();
        assert_eq!(std::fs::read_to_string(&note).unwrap(), "now writable");
    }

    let _ = std::fs::remove_dir_all(&vault);
}

/// `0000` denies reading as well as writing, and the app must not answer that
/// by replacing a file it could not even show: the content it would destroy is
/// one it never saw. (The mode is restored before the content is read back,
/// which is what proves the bytes are still the ones that were there.)
#[test]
fn an_unreadable_note_is_not_replaced() {
    let vault = temp_vault("locked");
    let root = vault.to_str().unwrap().to_string();
    let note = vault.join("locked.md");
    std::fs::write(&note, "unreadable secret").unwrap();
    set_mode(&note, 0o000);

    let error = write_file(&root, "locked.md", "overwritten", Some(5))
        .expect_err("a file that cannot be read must not be replaced");

    assert!(error.contains("read-only"), "names the reason: {error}");
    assert_eq!(mode_of(&note), 0o000, "the refused save changed the mode");

    set_mode(&note, 0o600);
    assert_eq!(
        std::fs::read_to_string(&note).unwrap(),
        "unreadable secret",
        "the refused save changed the content"
    );
    let _ = std::fs::remove_dir_all(&vault);
}

/// A refused save must not spend a history slot.
///
/// `write_file` snapshots the previous content BEFORE the publish, and content
/// that differs from the file is exactly what a save of a read-only note always
/// has: a user typing into one would otherwise fill the ten-slot history with
/// duplicates of a version that never changed, and evict the older ones the
/// panel exists to offer.
#[test]
fn a_refused_save_keeps_the_history_it_would_have_evicted() {
    let vault = temp_vault("readonly-history");
    let root = vault.to_str().unwrap().to_string();

    for content in ["v1", "v2", "v3"] {
        write_file(&root, "note.md", content, Some(10)).unwrap();
    }
    set_mode(&vault.join("note.md"), 0o444);
    // Each save snapshotted its predecessor, so v1 and v2 are in history and
    // the note itself is v3, read-only.
    let before: Vec<String> = list_history(&root, "note.md")
        .unwrap()
        .into_iter()
        .map(|e| e.id)
        .collect();
    assert_eq!(before.len(), 2, "the setup needs two snapshots: {before:?}");

    for _ in 0..5 {
        assert!(write_file(&root, "note.md", "typed", Some(10)).is_err());
    }

    let after: Vec<String> = list_history(&root, "note.md")
        .unwrap()
        .into_iter()
        .map(|e| e.id)
        .collect();
    assert_eq!(
        after, before,
        "five refused saves rewrote the history of a note that never changed"
    );
    let _ = std::fs::remove_dir_all(&vault);
}

/// Restoring a version is a replace too, so it is refused on the same terms —
/// and the note the user protected is still the one they protected.
#[test]
fn restoring_a_version_onto_a_read_only_note_is_refused() {
    let vault = temp_vault("readonly-restore");
    let root = vault.to_str().unwrap().to_string();
    let note = vault.join("note.md");

    write_file(&root, "note.md", "v1", Some(10)).unwrap();
    write_file(&root, "note.md", "v2", Some(10)).unwrap();
    let id = list_history(&root, "note.md").unwrap()[0].id.clone();
    set_mode(&note, 0o444);

    let error = restore_history(&root, "note.md", &id)
        .expect_err("restoring over a read-only note must be refused");

    assert!(error.contains("read-only"), "names the reason: {error}");
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "v2");
    assert_eq!(mode_of(&note), 0o444);

    // The version is still there to restore once the bit is cleared.
    set_mode(&note, 0o644);
    assert_eq!(restore_history(&root, "note.md", &id).unwrap(), "v1");
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "v1");
    let _ = std::fs::remove_dir_all(&vault);
}

/// Where a user meets the refusal without having chmod-ed anything just now:
/// the trash move keeps the file's inode, and with it the bit, so a read-only
/// note that was deleted and restored comes back read-only and refuses the next
/// save. The app itself never sets the bit (nothing in the storage layer does),
/// which is exactly why this route is worth pinning: it is the one the app can
/// hand a user who never touched `chmod`.
#[test]
fn a_note_restored_from_the_trash_carries_the_bit_that_refuses_the_save() {
    use nekowite_lib::storage::trash_store::{delete_file, list_trash, restore_from_trash};

    let vault = temp_vault("readonly-trash");
    let root = vault.to_str().unwrap().to_string();
    let note = vault.join("note.md");

    write_file(&root, "note.md", "v1", Some(10)).unwrap();
    set_mode(&note, 0o444);
    delete_file(&root, "note.md").unwrap();
    let trashed = list_trash(&root).unwrap().remove(0);
    restore_from_trash(&root, &trashed.trash_path).unwrap();

    assert_eq!(
        mode_of(&note),
        0o444,
        "the trash move is a rename of the same file: the bit travels with it"
    );
    let error = write_file(&root, "note.md", "v2", Some(10)).unwrap_err();
    assert!(error.contains("read-only"), "names the reason: {error}");
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "v1");
    let _ = std::fs::remove_dir_all(&vault);
}
