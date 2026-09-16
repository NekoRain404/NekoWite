//! What a manifest on disk may name when the library reads it back.
//!
//! `manifest.json` is written by `library.rs` and by nothing else — but it is a file in a directory
//! the user owns, so every name in it is input from outside the app. That matters here and not
//! there: `list` stats what a name points at and `verify` *reads and hashes* it, so a name joined
//! onto the character's directory unchecked is a read of any path on the machine, and its digest
//! is a fact about a file the user never offered this app.
//!
//! The rule is the library's own and is not restated for this file: a name that becomes one path
//! component is judged by [`name_problem`], the same function `read_pack` applies to every entry on
//! the way in and `character_view` applies to `manifest.sheet.file`. Nothing is read through a
//! link, which is the same rule one level down — the *name* confines where a path points, and a
//! link inside the directory would send the read wherever it points instead.
//!
//! Every case below plants the file's *correct* digest in the manifest, so a library that read it
//! would report the character clean. A pass here cannot come from a digest that merely failed to
//! match: it can only come from not reading the file at all.
//!
//! The last case is the other half of the same rule. A manifest this library wrote still resolves,
//! including one whose file names are Chinese — which is what a confinement that quietly kept an
//! alphabet would break.

use std::path::PathBuf;

use sha2::{Digest, Sha256};

use crate::desktop_pet::resources::{
    name_problem, CharacterLibrary, EntryState, PackageProblem, ResourceRefusal, INSTALLED_MANIFEST,
};
use crate::support::{install_request, library, pack_dir, png, write};

/// Bytes outside the character's directory, which a hostile name would make the library read.
const OUTSIDE: &[u8] = b"a file this library was never asked to read";

/// A library with one character installed, and a file beside the library that nothing in it may
/// reach. The digest of that file is what every hostile manifest below records.
fn fixture(label: &str) -> (CharacterLibrary, PathBuf) {
    let (library, data) = library(label);
    let source = pack_dir(label);
    write(&source, "sheet.png", &png(64, 64));
    library
        .install(&install_request("cat", &source))
        .expect("a pack of one file");
    std::fs::write(data.join("outside.txt"), OUTSIDE).expect("a file beside the library");
    (library, data)
}

/// Rewrite the manifest's file list to one entry, the way a hand-edit would.
///
/// The digest and the size are the *true* ones for the bytes the name reaches, so the manifest is
/// a manifest a reader that followed the name would find nothing wrong with.
fn plant(library: &CharacterLibrary, name: &str, reached: &[u8]) {
    let path = library.root().join("cat").join(INSTALLED_MANIFEST);
    let text = std::fs::read_to_string(&path).expect("the manifest this library wrote");
    let mut manifest: serde_json::Value = serde_json::from_str(&text).expect("a manifest");
    manifest["files"] = serde_json::json!([{
        "name": name,
        "bytes": reached.len(),
        "sha256": format!("{:x}", Sha256::digest(reached)),
    }]);
    std::fs::write(&path, serde_json::to_string(&manifest).expect("a manifest")).expect("writable");
}

/// What the library reports for the one character in the fixture.
fn state_of(library: &CharacterLibrary) -> EntryState {
    let entries = library.list().expect("readable");
    assert_eq!(entries.len(), 1, "the fixture installs exactly one character");
    entries.into_iter().next().expect("one entry").state
}

/// The refusal `verify` raises for a name the library will not open, asserted to be a *name*
/// refusal that carries the clause which refused it.
///
/// The sentence is not respelled here: it is `name_problem`'s own, asked of the same function the
/// library asked — which is what keeps the check and the explanation from drifting apart.
fn name_refusal(library: &CharacterLibrary, name: &str) -> ResourceRefusal {
    let refusal = library.verify("cat").expect_err("a name the library will not open");
    assert_eq!(
        refusal,
        ResourceRefusal::InvalidName {
            field: "files[].name",
            value: name.to_string(),
            detail: name_problem(name).expect("a name this rule refuses"),
        },
        "{name:?} was not refused as the name it is"
    );
    refusal
}

#[test]
fn a_manifest_naming_a_parent_directory_names_nothing() {
    let (library, _data) = fixture("confine-parent");
    // `..` and every spelling that starts with it: from the character's own directory, three of
    // them are the app's data directory, which is where `outside.txt` is.
    for name in ["..", "../..", "../../../outside.txt", "cat/../../outside.txt"] {
        plant(&library, name, OUTSIDE);
        assert_eq!(
            state_of(&library),
            EntryState::OutsideDirectory {
                names: vec![name.to_string()]
            },
            "{name:?} was reported as a state about a file"
        );
        name_refusal(&library, name);
    }
}

#[test]
fn a_manifest_naming_an_absolute_path_names_nothing() {
    let (library, data) = fixture("confine-absolute");
    // An absolute path joins to a directory by replacing it, so this is the shortest hole of the
    // set: `verify` reads it and `list` reports its size, with nothing in the library resembling it.
    let absolute = data.join("outside.txt");
    let name = absolute.to_string_lossy().into_owned();

    plant(&library, &name, OUTSIDE);
    assert_eq!(
        state_of(&library),
        EntryState::OutsideDirectory {
            names: vec![name.clone()]
        }
    );
    name_refusal(&library, &name);
    assert!(absolute.is_file(), "nothing here reads or removes the file it refused to name");
}

#[test]
fn a_manifest_naming_a_control_character_names_nothing() {
    let (library, _data) = fixture("confine-nul");
    // NUL is the case the *syscall* refuses — it ends the path — and it is refused here by the name
    // rule, which says so, rather than by whatever the kernel answers for a name nobody checked.
    for name in ["cat\0", "\0", "cat\tx"] {
        plant(&library, name, OUTSIDE);
        assert_eq!(
            state_of(&library),
            EntryState::OutsideDirectory {
                names: vec![name.to_string()]
            }
        );
        name_refusal(&library, name);
    }
}

#[test]
fn a_manifest_naming_only_dots_names_nothing() {
    let (library, _data) = fixture("confine-dots");
    // A name of dots and nothing else: `...` is a file the filesystem takes, and a leading dot is
    // the namespace this module mints its staging directories in — a character may not be mistaken
    // for the library's own debris. `..` and `.` name directories and are their own clause.
    for name in [".", "..", "...", "...."] {
        plant(&library, name, OUTSIDE);
        assert_eq!(
            state_of(&library),
            EntryState::OutsideDirectory {
                names: vec![name.to_string()]
            }
        );
        name_refusal(&library, name);
    }
}

#[test]
fn a_manifest_naming_the_empty_string_names_nothing() {
    let (library, _data) = fixture("confine-empty");
    // The empty name joins to the character's own directory — a path that happens to stay inside,
    // so a rule that confined by location alone would call it safe. It names no file, and that is
    // the fact to refuse it by.
    plant(&library, "", OUTSIDE);
    assert_eq!(
        state_of(&library),
        EntryState::OutsideDirectory {
            names: vec![String::new()]
        }
    );
    name_refusal(&library, "");
}

#[test]
fn a_manifest_naming_a_link_out_of_the_directory_is_not_followed() {
    let (library, data) = fixture("confine-link");
    // A name that *is* a component (.png, no separator) whose file is a link to something outside:
    // the one way a confined name still reaches out of the directory. The import follows no links
    // (`read_pack`), so this one was not written by this library.
    let target = data.join("outside.txt");
    std::os::unix::fs::symlink(&target, library.root().join("cat/linked.png")).expect("a symlink");

    plant(&library, "linked.png", OUTSIDE);
    assert_eq!(
        state_of(&library),
        EntryState::OutsideDirectory {
            names: vec!["linked.png".to_string()]
        }
    );
    match library.verify("cat").expect_err("a link is not read through") {
        ResourceRefusal::Package { name, problem, .. } => {
            assert_eq!(name, "linked.png");
            assert_eq!(problem, PackageProblem::Symlink);
        }
        other => panic!("a link was refused as something else: {other:?}"),
    }
}

#[test]
fn a_manifest_this_library_wrote_still_resolves_whatever_its_names_are() {
    // The other half of the rule, and the one a confinement can break by being too strict: every
    // name the library itself writes is read exactly as before. The Chinese names are the case the
    // library was just changed to accept, so a rule that kept an alphabet would fail here rather
    // than in the settings page of the user who imported it.
    let (library, _data) = library("confine-valid");
    let source = pack_dir("confine-valid");
    write(&source, "精灵图.png", &png(64, 64));
    write(&source, "喵 叫声.ogg", b"OggS a sound");
    library
        .install(&install_request("喵喵", &source))
        .expect("a pack whose names are Chinese");

    let entries = library.list().expect("readable");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].state,
        EntryState::Intact,
        "a name with a letter of another script is a name this library reads"
    );
    assert!(library.verify("喵喵").expect("readable").is_empty());
    // And the same character is still addressable as a directory: nothing here changed what an id
    // is, only what a manifest may name.
    assert!(library.root().join("喵喵").join("精灵图.png").is_file());
}

#[test]
fn a_manifest_that_names_an_unreadable_file_still_reports_it_rather_than_refusing_it() {
    // The boundary of the rule: a name that IS a path component is looked up, and a file that is
    // not there is `incomplete` — the state this module has always reported. A confinement that
    // widened into "anything absent is hostile" would turn a deleted file into a refusal.
    let (library, _data) = fixture("confine-absent");
    plant(&library, "gone.png", OUTSIDE);
    assert_eq!(
        state_of(&library),
        EntryState::Incomplete {
            missing: vec!["gone.png".to_string()]
        }
    );
    assert!(
        library.verify("cat").is_err(),
        "a file that is not there is an io refusal, not a clean pass"
    );
}
