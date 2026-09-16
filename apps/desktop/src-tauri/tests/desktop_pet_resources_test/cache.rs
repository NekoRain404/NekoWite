//! The invalidation rule, and the cases that prove a changed source is seen.
//!
//! A managed copy is a cache of something the user brought in, and a cache that can disagree with
//! its source without either being wrong is a bug generator. So the rule is stated once and tested
//! from both sides:
//!
//! > The manifest records what the character *should* be. The directory is what it *is*. A
//! > disagreement is a state the library reports — `incomplete`, `resized` — and is never resolved
//! > by preferring one side. `list()` compares presence and size, which is what a settings page can
//! > afford; `verify()` compares digests, which is what "is it the same" actually means.
//!
//! The two halves are deliberately different answers and the tests keep them apart: a same-size
//! edit is invisible to the listing *on purpose*, and the case below proves the deep check catches
//! exactly that. Neither claims the other's answer, which is why a listing is not a verification.
//!
//! There is no index file anywhere in the library, and the case that says so is the one that adds
//! a directory by hand: what is installed is what is on disk, so a character cannot be invisible
//! and a listing cannot invent one.

use crate::desktop_pet::resources::{EntryState, LibraryEntry, ResourceRefusal, INSTALLED_MANIFEST};
use crate::support::{install_request, library, listing, pack_dir, png, write};

/// Install one character of two files so the cases below have something to damage.
fn installed(label: &str) -> (crate::desktop_pet::resources::CharacterLibrary, std::path::PathBuf) {
    let (library, data) = library(label);
    let source = pack_dir(label);
    write(&source, "sheet.png", &png(64, 64));
    write(&source, "meow.ogg", b"OggS a sound");
    library
        .install(&install_request("cat", &source))
        .expect("a pack of two files");
    (library, data)
}

fn only(entries: &[LibraryEntry]) -> &LibraryEntry {
    assert_eq!(entries.len(), 1, "the fixture installs exactly one character");
    &entries[0]
}

#[test]
fn an_untouched_character_is_reported_intact_and_verifies_clean() {
    let (library, _data) = installed("cache-intact");
    let entries = library.list().expect("readable");
    assert_eq!(only(&entries).state, EntryState::Intact);
    assert_eq!(
        only(&entries).character_id,
        "cat",
        "the directory's name is the id"
    );
    assert!(library.verify("cat").expect("readable").is_empty());
}

#[test]
fn a_larger_file_than_the_manifest_recorded_is_seen_and_named() {
    let (library, _data) = installed("cache-resized");
    // Appending to the sheet is the ordinary shape of this: an editor saved over it, a sync client
    // replaced it, a half-written copy landed. The size is what a listing can afford to check.
    let sheet = library.root().join("cat/sheet.png");
    let mut grown = std::fs::read(&sheet).expect("readable");
    grown.extend_from_slice(b"and then something else");
    std::fs::write(&sheet, &grown).expect("writable");

    let entries = library.list().expect("readable");
    assert_eq!(
        only(&entries).state,
        EntryState::Resized {
            changed: vec!["sheet.png".to_string()]
        }
    );
    // Reported, not repaired: the file the user has now is still the file the user has.
    assert_eq!(std::fs::read(&sheet).expect("readable").len(), grown.len());
}

#[test]
fn a_file_the_manifest_lists_and_the_directory_does_not_have_is_incomplete() {
    let (library, _data) = installed("cache-missing");
    std::fs::remove_file(library.root().join("cat/meow.ogg")).expect("removable");

    let entries = library.list().expect("readable");
    assert_eq!(
        only(&entries).state,
        EntryState::Incomplete {
            missing: vec!["meow.ogg".to_string()]
        }
    );
    // The manifest is still there and still says what the character is. A listing that rewrote it
    // to match the directory would be a record that can no longer disagree with anything — which
    // is also a record that can no longer tell the user anything.
    assert!(library.root().join("cat").join(INSTALLED_MANIFEST).is_file());
}

#[test]
fn a_same_size_edit_is_invisible_to_a_listing_and_caught_by_the_digest_check() {
    let (library, _data) = installed("cache-digest");
    let sheet = library.root().join("cat/sheet.png");
    let original = std::fs::read(&sheet).expect("readable");
    let mut forged = original.clone();
    // One byte of the header changed, nothing else: same length, so the cheap check cannot see it,
    // and that is exactly why the two checks are named differently.
    forged[0] = b'\x8a';
    std::fs::write(&sheet, &forged).expect("writable");

    assert_eq!(only(&library.list().expect("readable")).state, EntryState::Intact);

    let mismatches = library.verify("cat").expect("readable");
    assert_eq!(mismatches.len(), 1);
    assert_eq!(mismatches[0].name, "sheet.png");
    assert_ne!(mismatches[0].recorded, mismatches[0].found);
    // The other file is untouched and is not reported: a verification names what changed rather
    // than declaring the whole character suspect.
    assert!(mismatches.iter().all(|mismatch| mismatch.name == "sheet.png"));
}

#[test]
fn a_directory_with_no_manifest_is_reported_and_neither_adopted_nor_removed() {
    let (library, _data) = installed("cache-unmanaged");
    // Something the user put there, or the debris of a build that wrote another format. Either way
    // it is not this module's to describe and not this module's to delete.
    let stranger = library.root().join("someone-elses");
    std::fs::create_dir_all(&stranger).expect("creatable");
    std::fs::write(stranger.join("art.png"), png(8, 8)).expect("writable");

    let entries = library.list().expect("readable");
    assert_eq!(entries.len(), 2);
    let unmanaged = entries
        .iter()
        .find(|entry| entry.character_id == "someone-elses")
        .expect("listed");
    assert_eq!(unmanaged.state, EntryState::Unmanaged);
    assert_eq!(unmanaged.manifest, None, "there is no character to describe");
    assert!(stranger.join("art.png").is_file(), "nothing was deleted");
    // And no operation will address it: the only way it leaves is the user removing the folder.
    assert_eq!(
        library.remove("someone-elses").expect_err("the directory is there and has no record"),
        ResourceRefusal::Unmanaged { character_id: "someone-elses".into() }
    );
}

#[test]
fn an_unreadable_manifest_is_reported_and_a_reading_never_repairs_it() {
    let (library, _data) = installed("cache-unreadable");
    let path = library.root().join("cat").join(INSTALLED_MANIFEST);
    std::fs::write(&path, b"{ this is not json").expect("writable");
    let before = std::fs::read(&path).expect("readable");

    let entries = library.list().expect("a library with one bad manifest still lists");
    let entry = only(&entries);
    assert!(matches!(entry.state, EntryState::UnreadableManifest { .. }));
    assert_eq!(entry.manifest, None);
    // §10.2's 「遇到新版本数据，旧程序只读/报错，禁止按默认值覆盖」 reached from the resource side: the
    // record is not the reader's to rewrite, and a read that repaired would destroy the evidence
    // of whatever wrote it.
    assert_eq!(std::fs::read(&path).expect("readable"), before);
}

#[test]
fn the_reserved_names_are_not_characters_and_do_not_collide_with_the_next_import() {
    let (library, _data) = installed("cache-reserved");
    // Leftovers from a process that was killed mid-import. They are bookkeeping, not characters,
    // and a listing that offered them as ones would offer the user half a pack.
    for name in [".staging-1-0", ".removing-2-0"] {
        std::fs::create_dir_all(library.root().join(name)).expect("creatable");
    }
    let entries = library.list().expect("readable");
    assert_eq!(entries.len(), 1, "only the real character is listed");

    // And the next import claims a name anyway: the reserved namespace is swept into the claim
    // rather than assumed to be free.
    let source = pack_dir("cache-reserved-next");
    write(&source, "sheet.png", &png(32, 32));
    library
        .install(&install_request("dog", &source))
        .expect("a second character installs beside the leftovers");
    assert_eq!(library.list().expect("readable").len(), 2);
}

#[test]
fn the_manifest_records_every_file_and_the_digest_of_the_bytes_the_library_wrote() {
    let (library, _data) = installed("cache-record");
    let entries = library.list().expect("readable");
    let manifest = only(&entries).manifest.as_ref().expect("readable");
    let mut names: Vec<&str> = manifest.files.iter().map(|file| file.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, vec!["meow.ogg", "sheet.png"]);
    for file in &manifest.files {
        let bytes = std::fs::read(library.root().join("cat").join(&file.name)).expect("readable");
        assert_eq!(file.bytes, bytes.len() as u64);
        assert_eq!(file.sha256.len(), 64, "a sha256 in lower-case hex");
    }
    // The library's record is the one file a pack cannot supply, and there is no second record
    // beside the directories that could disagree with them.
    assert_eq!(
        listing(library.root()),
        vec!["cat"],
        "a library index file would be a second answer to what is installed"
    );
}
