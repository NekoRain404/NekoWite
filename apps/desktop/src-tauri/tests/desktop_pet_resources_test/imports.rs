//! The transaction: what a successful import leaves behind, and what a refused one does not.
//!
//! §8's 「导入后先校验再复制到受管资源目录」 is one sentence about an order, and the order is what
//! these cases are about. The failure mode this file exists to catch is not "an import failed" —
//! it is "an import failed and left something": a character directory with half a pack in it, a
//! manifest that names files nobody copied, a staging directory nobody will ever look at again.
//!
//! So every refusal case here asserts a *listing*, taken before and after. A count could be
//! satisfied by the library having acquired one thing and lost another, and a state check could be
//! satisfied by a character that is present but wrong.

use std::path::Path;

use crate::desktop_pet::resources::{
    CreateRequest, EntryState, PackageProblem, ResourceRefusal, INSTALLED_MANIFEST,
};
use crate::support::{gif, install_request, library, listing, ogg, pack_dir, pet_json, png, write};

#[test]
fn a_successful_import_publishes_the_pack_the_manifest_and_nothing_else() {
    let (library, _data) = library("import-ok");
    let source = pack_dir("import-ok");
    write(&source, "pet.json", &pet_json(""));
    write(&source, "sheet.png", &png(1536, 1872));
    write(&source, "meow.ogg", &ogg(64));

    let installed = library
        .install(&install_request("cat", &source))
        .expect("a pack of images, sound and one pet.json");

    let directory = library.root().join("cat");
    let mut published = listing(&directory);
    published.retain(|name| name != INSTALLED_MANIFEST);
    assert_eq!(published, vec!["meow.ogg", "pet.json", "sheet.png"]);
    // The pack's own manifest is carried as data and is not the record the library trusts: a
    // record a pack can author is a record a pack can lie in.
    assert_ne!(INSTALLED_MANIFEST, "pet.json");
    assert!(directory.join(INSTALLED_MANIFEST).is_file());

    assert_eq!(installed.sheet.file, "sheet.png");
    assert_eq!(
        (installed.sheet.width, installed.sheet.height),
        (1536, 1872)
    );
    assert_eq!(installed.files.len(), 3);
    // Nothing named with the reserved prefix is left anywhere under the library: the staging
    // directory is the transaction's own bookkeeping and it is gone once the rename happened.
    assert_eq!(
        listing(library.root())
            .into_iter()
            .filter(|name| name.starts_with('.'))
            .count(),
        0
    );
    assert!(library.verify("cat").expect("reading it back").is_empty());

    let entries = library.list().expect("a library that was just written to");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].state, EntryState::Intact);
    assert_eq!(
        entries[0]
            .manifest
            .as_ref()
            .map(|manifest| manifest.files.len()),
        Some(3)
    );
    assert_eq!(
        library.root().parent(),
        Some(_data.join("desktop-pet").as_path())
    );
}

#[test]
fn a_pack_with_one_bad_file_after_several_good_ones_publishes_none_of_them() {
    let (library, _data) = library("import-partial");
    let source = pack_dir("import-partial");
    write(&source, "sheet.png", &png(64, 64));
    write(&source, "pet.json", &pet_json(""));
    write(&source, "notes.md", b"a file nobody here can validate");

    let refusal = library
        .install(&install_request("cat", &source))
        .expect_err("a file whose type cannot be established");
    assert!(matches!(refusal, ResourceRefusal::Unrecognized { ref name } if name == "notes.md"));

    // Not "the character is incomplete" — there is no character, no directory, and no staging
    // name left behind. The three good files were read and then nothing was published.
    assert!(listing(library.root()).is_empty());
    assert!(library
        .list()
        .expect("an unreadable library would be a second failure")
        .is_empty());
}

#[test]
fn a_refused_import_leaves_a_library_that_already_holds_characters_untouched() {
    let (library, _data) = library("import-untouched");
    let good = pack_dir("import-untouched-good");
    write(&good, "sheet.png", &png(64, 64));
    library
        .install(&install_request("first", &good))
        .expect("a pack of one image");

    let before = listing(library.root());
    let bad = pack_dir("import-untouched-bad");
    write(&bad, "sheet.png", &png(64, 64));
    write(
        &bad,
        "payload.zip",
        b"PK\x03\x04 not a pack this build unpacks",
    );

    library
        .install(&install_request("second", &bad))
        .expect_err("an archive");

    assert_eq!(listing(library.root()), before);
    assert_eq!(library.list().expect("still readable").len(), 1);
}

#[test]
fn importing_the_same_id_twice_is_refused_rather_than_replacing_the_first() {
    let (library, _data) = library("import-twice");
    let first = pack_dir("import-twice-a");
    write(&first, "sheet.png", &png(64, 64));
    library
        .install(&install_request("cat", &first))
        .expect("the first import");
    let sheet_before = std::fs::read(library.root().join("cat/sheet.png")).expect("readable");

    let second = pack_dir("import-twice-b");
    write(&second, "sheet.png", &gif(64, 64));
    let refusal = library
        .install(&install_request("cat", &second))
        .expect_err("the name is taken");
    assert_eq!(
        refusal,
        ResourceRefusal::AlreadyInstalled {
            character_id: "cat".to_string()
        }
    );

    // §8's 重名覆盖 is about a copy replacing what it found, and the replacement is the failure:
    // the first character is byte-for-byte what it was, and the second was never staged.
    assert_eq!(
        std::fs::read(library.root().join("cat/sheet.png")).expect("readable"),
        sheet_before
    );
}

/// A pack from a Chinese-language user: the folder is named in Chinese, the sheet inside it is
/// named in Chinese, and the character is a character.
///
/// This is the case D12's report named — 「中文文件夹名会被拒绝」 — and it is the whole reason the
/// name rule is a filesystem rule rather than an ASCII one. Nothing here is special-cased: the id
/// the importer derives *is* the folder's name, the sheet keeps the name it had, and every read
/// afterwards addresses both by the same strings.
#[test]
fn a_pack_named_in_chinese_is_a_character_like_any_other() {
    let (library, _data) = library("import-cjk");
    let source = pack_dir("import-cjk");
    write(&source, "精灵图.png", &png(1536, 1872));
    write(&source, "pet.json", &pet_json(",\"displayName\":\"喵喵\""));

    // The id `character_view::free_character_id` derives from a folder named 喵喵 — asserted
    // where it is derived. What is under test here is the library: that the same string it hands
    // out is one it will hold a character under.
    let installed = library
        .install(&install_request("喵喵", &source))
        .expect("a pack whose names are Chinese");

    assert_eq!(installed.character_id, "喵喵");
    assert_eq!(installed.sheet.file, "精灵图.png");
    // The directory is the id, the sheet inside it kept its own name, and the pack's own manifest
    // was carried as data beside it.
    let mut published = listing(&library.root().join("喵喵"));
    published.retain(|name| name != INSTALLED_MANIFEST);
    assert_eq!(published, vec!["pet.json", "精灵图.png"]);
    assert!(library
        .root()
        .join("喵喵")
        .join(INSTALLED_MANIFEST)
        .is_file());

    // The reads a settings page makes all address it by that same string — the listing, and the
    // digest pass, which is the one that reads every file back by the name in the manifest.
    let entries = library.list().expect("a library that was just written to");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].character_id, "喵喵");
    assert_eq!(entries[0].state, EntryState::Intact);
    assert!(library
        .verify("喵喵")
        .expect("read back by name")
        .is_empty());
}

/// The second import of one folder is a second character, and the first one is untouched.
#[test]
fn a_chinese_name_that_is_taken_is_refused_rather_than_overwritten() {
    let (library, _data) = library("import-cjk-twice");
    let source = pack_dir("import-cjk-twice");
    write(&source, "精灵图.png", &png(64, 64));

    library
        .install(&install_request("喵喵", &source))
        .expect("the first import");
    let sheet_before =
        std::fs::read(library.root().join("喵喵").join("精灵图.png")).expect("readable");

    // The generator suffixes a taken id (`喵喵-2`, asserted with the generator), and the library
    // refuses one that is taken however it arrived: no import can replace a character a user
    // already has (§8's 重名覆盖), in any script.
    let refusal = library
        .install(&install_request("喵喵", &source))
        .expect_err("the id is taken");
    assert_eq!(
        refusal,
        ResourceRefusal::AlreadyInstalled {
            character_id: "喵喵".to_string()
        }
    );
    assert_eq!(
        std::fs::read(library.root().join("喵喵").join("精灵图.png")).expect("readable"),
        sheet_before,
        "the character that was there is byte-for-byte what it was"
    );
}

/// One name typed two ways: two byte sequences, two directories on Linux, and two characters.
///
/// The library is byte-exact, like the filesystem it lives on — the rule is stated on
/// `resources::is_path_component`, and this is what it means at the library's own level. What the
/// case pins is that the decision is not *silent*: neither spelling overwrites the other, and the
/// collision the generator resolves by suffixing is resolved by looking, never by folding. Hangul
/// is the pair where both spellings are made of letters (`각` and `각`), so nothing about the two
/// names differs except their bytes.
#[test]
fn two_spellings_of_one_name_are_two_characters_and_neither_overwrites_the_other() {
    let (library, _data) = library("import-nfc");
    let source = pack_dir("import-nfc");
    write(&source, "sheet.png", &png(64, 64));

    // U+AC01 (precomposed) and U+1100 U+1161 U+11A8 (jamo): NFC and NFD of the same syllable.
    let composed = "\u{ac01}";
    let decomposed = "\u{1100}\u{1161}\u{11a8}";
    assert_ne!(composed, decomposed);

    library
        .install(&install_request(composed, &source))
        .expect("the first spelling");
    library
        .install(&install_request(decomposed, &source))
        .expect("the second spelling");

    let mut ids: Vec<String> = library
        .list()
        .expect("readable")
        .into_iter()
        .map(|entry| entry.character_id)
        .collect();
    ids.sort();
    let mut expected = vec![composed.to_string(), decomposed.to_string()];
    expected.sort();
    assert_eq!(
        ids, expected,
        "both are installed, and neither replaced the other"
    );
    assert_eq!(listing(library.root()).len(), 2);
}

#[test]
fn a_pack_entry_named_for_the_librarys_own_namespace_is_refused_with_its_reason() {
    let (library, _data) = library("import-hidden");
    let source = pack_dir("import-hidden");
    write(&source, "sheet.png", &png(64, 64));
    // A name a user really has on disk (`macOS` writes these), and the one prefix the library
    // mints its own directories under — so it is refused, and refused for that reason.
    write(&source, ".DS_Store", b"\x00\x00\x00\x01Bud1");

    let refusal = library
        .install(&install_request("cat", &source))
        .expect_err("a hidden file");
    let ResourceRefusal::Package {
        name,
        problem,
        detail,
    } = &refusal
    else {
        panic!("a pack entry is refused as a package problem: {refusal:?}");
    };
    assert_eq!(name, ".DS_Store");
    assert_eq!(*problem, PackageProblem::UnusableName);
    assert!(detail.contains("leading dot"), "{detail}");
    assert!(listing(library.root()).is_empty());
}

#[test]
fn creating_a_character_is_the_same_transaction_with_the_same_budgets() {
    let (library, _data) = library("create-ok");
    let created = library
        .create(&CreateRequest {
            character_id: "local-1700000000000".to_string(),
            name: "Bear".to_string(),
            installed_at_ms: 1_700_000_000_001,
            sheet_name: "sheet.png".to_string(),
            sheet: png(800, 900),
            columns: 8,
            rows: 9,
        })
        .expect("a sheet the renderer's own grid divides");

    let entries = library.list().expect("readable");
    assert_eq!(entries[0].state, EntryState::Intact);
    assert_eq!(
        entries[0]
            .manifest
            .as_ref()
            .map(|manifest| manifest.sheet.clone()),
        Some(created.sheet.clone())
    );
    assert_eq!(created.sheet.columns, 8);

    // The same refusals apply, which is the point of there being one path: a corrupt sheet fails
    // here exactly as it would fail as a pack, and leaves nothing behind.
    let before = listing(library.root());
    let refusal = library
        .create(&CreateRequest {
            character_id: "local-2".to_string(),
            name: "Bear".to_string(),
            installed_at_ms: 1_700_000_000_002,
            sheet_name: "sheet.png".to_string(),
            sheet: b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec(),
            columns: 8,
            rows: 9,
        })
        .expect_err("a document is not a sheet");
    assert!(
        matches!(
            refusal,
            ResourceRefusal::Package {
                problem: crate::desktop_pet::resources::PackageProblem::Script,
                ..
            }
        ),
        "a document is refused by the rule that names it, not as an unknown type"
    );
    assert_eq!(listing(library.root()), before);
}

#[test]
fn a_pack_cannot_author_the_record_the_library_trusts() {
    let (library, _data) = library("import-forged");
    let source = pack_dir("import-forged");
    write(&source, "sheet.png", &png(64, 64));
    // A pack that ships its own `manifest.json`, with the name the library uses for its record.
    write(
        &source,
        INSTALLED_MANIFEST,
        br#"{"schemaVersion":1,"characterId":"admin","files":[]}"#,
    );

    let refusal = library
        .install(&install_request("cat", &source))
        .expect_err("a file of a type this build cannot establish");
    assert!(
        matches!(refusal, ResourceRefusal::Unrecognized { ref name } if name == INSTALLED_MANIFEST)
    );

    // And the record that exists after a real import is the library's, written from the bytes it
    // staged rather than from anything the pack said.
    let clean = pack_dir("import-forged-clean");
    write(&clean, "sheet.png", &png(64, 64));
    let installed = library
        .install(&install_request("cat", &clean))
        .expect("a clean pack");
    assert_eq!(installed.files[0].name, "sheet.png");
    assert_eq!(installed.files[0].bytes, 24);
    assert_eq!(installed.files[0].sha256.len(), 64);
    let text = std::fs::read_to_string(library.root().join("cat").join(INSTALLED_MANIFEST))
        .expect("the record is readable");
    assert!(
        text.contains(&installed.files[0].sha256),
        "the digest the library computed"
    );
    assert!(text.contains("\"schemaVersion\": 1"));
}

#[test]
fn the_clock_and_the_order_are_the_callers() {
    let (library, _data) = library("import-order");
    for (id, at) in [("old", 1_000u64), ("new", 2_000u64)] {
        let source = pack_dir(&format!("import-order-{id}"));
        write(&source, "sheet.png", &png(64, 64));
        let mut request = install_request(id, &source);
        request.installed_at_ms = at;
        let installed = library.install(&request).expect("a pack of one image");
        assert_eq!(installed.installed_at_ms, at);
    }

    let ids: Vec<String> = library
        .list()
        .expect("readable")
        .into_iter()
        .map(|entry| entry.character_id)
        .collect();
    assert_eq!(
        ids,
        vec!["new", "old"],
        "the newest import is where the user finds it"
    );
}

#[test]
fn a_source_that_is_not_there_is_refused_with_the_path_it_looked_for() {
    let (library, _data) = library("import-missing");
    let missing = Path::new("/tmp/nkw-pet-resources-does-not-exist");
    let refusal = library
        .install(&install_request("cat", missing))
        .expect_err("a source that does not exist");
    assert_eq!(
        refusal,
        ResourceRefusal::NoSource {
            path: missing.to_path_buf()
        }
    );
    assert!(listing(library.root()).is_empty());
}

#[test]
fn a_pack_may_be_one_file_because_the_user_picked_a_sheet_and_not_a_folder() {
    let (library, _data) = library("import-single");
    let single = pack_dir("import-single").join("sheet.png");
    write(
        single.parent().expect("a directory"),
        "sheet.png",
        &png(64, 64),
    );

    let installed = library
        .install(&install_request("cat", &single))
        .expect("a single file is a pack of one image");
    assert_eq!(installed.files.len(), 1);
    assert_eq!(installed.sheet.file, "sheet.png");
}
