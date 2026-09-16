//! What a pack may not carry (§8's list), and what the library refuses before it copies anything.
//!
//! Two of these cases are about checking and the rest are about not needing to. The strongest
//! refusals in this file are the ones where there is no check to get wrong: a pack entry's name is
//! never joined onto a path, so a traversal has nothing to traverse; a subdirectory is refused
//! rather than walked, so a pack cannot describe a tree at all. What is tested instead is that the
//! *shape* holds — that `..` as a character id cannot name a directory, and that a name with a
//! separator cannot become one.

use std::path::Path;

use crate::desktop_pet::resources::{
    is_path_component, CharacterLibrary, PackageProblem, ResourceRefusal, BUDGET_RULES,
    DEFAULT_SHEET_COLUMNS, DEFAULT_SHEET_ROWS, MAX_AUDIO_BYTES, MAX_COMPONENT_BYTES, MAX_FRAMES,
    MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS, MAX_PACKAGE_FILES, PACK_MANIFEST,
};
use crate::support::{
    gif, install_request, jpeg, library, listing, ogg, pack_dir, pet_json, png, webp, write,
};

fn refusal_of(refusal: &ResourceRefusal) -> &PackageProblem {
    match refusal {
        ResourceRefusal::Package { problem, .. } => problem,
        other => panic!("expected a package refusal, got {other:?}"),
    }
}

#[test]
fn a_character_id_that_could_be_a_path_names_nothing() {
    let (library, _data) = library("security-id");
    let source = pack_dir("security-id");
    write(&source, "sheet.png", &png(64, 64));

    let overlong = "x".repeat(MAX_COMPONENT_BYTES + 1);
    // The same ceiling in a script that costs three bytes a character, so a rule that counted
    // characters and called them bytes would pass the first case and fail this one.
    let overlong_cjk = "猫".repeat(MAX_COMPONENT_BYTES / 3 + 1);
    let cases: [(&str, &str); 17] = [
        ("..", "name directories"),
        (".", "name directories"),
        ("a/b", "separator between path components"),
        ("a\\b", "another system reads it as a separator"),
        ("../etc", "leading dot belongs to the library itself"),
        (".hidden", "leading dot belongs to the library itself"),
        ("", "cannot be empty"),
        ("cat\0", "control character"),
        ("ca\tx", "control character"),
        ("cat\n", "whitespace at either end"),
        (" lead", "whitespace at either end"),
        ("trail ", "whitespace at either end"),
        ("   ", "whitespace at either end"),
        ("cat\u{fffd}", "U+FFFD"),
        ("cat\u{202e}gnp", "render as a different one"),
        (overlong.as_str(), "at most 64 bytes"),
        (overlong_cjk.as_str(), "at most 64 bytes"),
    ];
    for (id, why) in cases {
        let refusal = library
            .install(&install_request(id, &source))
            .expect_err("an id that is not a path component");
        // The refusal names the *rule that refused*, not only the field: this sentence is what a
        // user reads, and "cannot be used as characterId" is not something anyone can act on.
        let ResourceRefusal::InvalidName { field, detail, .. } = &refusal else {
            panic!("{id:?} was refused as something other than a name: {refusal:?}");
        };
        assert_eq!(*field, "characterId", "{id:?}");
        assert!(
            detail.contains(why),
            "{id:?} was refused with a sentence that does not name why ({why}): {detail}"
        );
    }
    assert!(!is_path_component(".."));
    assert!(!is_path_component("sibling/.."));
    assert!(is_path_component("local-1700000000000"));
    assert!(is_path_component("shiba-inu_2"));

    // Nothing was created anywhere: not for the traversal, not for the empty id, not for the
    // hidden one — a reserved name is a name this module owns, not a character.
    assert!(listing(library.root()).is_empty());
}

#[test]
fn every_letter_of_every_script_is_a_name_and_only_the_hostile_ones_are_not() {
    // The rule is a filesystem rule: what the kernel takes, and what a page can draw back. It is
    // not an alphabet, and this is the case D12 reported — a Chinese-language user's folders are
    // named in Chinese.
    for name in [
        "喵喵",
        "我的猫-2",
        "猫 猫",
        "日本語のキャラ",
        "한글 캐릭터",
        "café",
        "Ω-3",
        "精灵图.png",
        "a b.png",
        "猫（素材）",
    ] {
        assert!(
            is_path_component(name),
            "{name:?} is a name the filesystem holds"
        );
    }
    // And what is refused is refused for something the filesystem or the page objects to, never
    // for being in the wrong alphabet.
    for name in [
        "喵/喵",
        "喵\n喵",
        ".喵喵",
        "..",
        "",
        "\u{fffd}",
        "喵\u{202e}喵",
    ] {
        assert!(
            !is_path_component(name),
            "{name:?} is not a name this library takes"
        );
    }
}

#[test]
fn a_refused_name_and_an_unreadable_pack_are_two_different_answers() {
    // §13's 「没收到报告不等于报告没有」, applied to error copy: "this name is not allowed" and "this
    // character could not be read" are different claims, and a page that showed one for the other
    // would be telling a user to rename a folder that is already fine. The two arms are what makes
    // that possible — the sentence each one becomes is written in `character_view`.
    let (library, _data) = library("security-sentences");

    let named = library
        .install(&install_request(
            "喵/喵",
            &pack_dir("security-sentences-name"),
        ))
        .expect_err("a name that is a path");
    assert!(
        matches!(&named, ResourceRefusal::InvalidName { field: "characterId", detail, .. }
            if detail.contains("separator")),
        "a name that is a path is refused as a name, with the rule that refused: {named:?}"
    );

    // A source that is not there — and deliberately not one this helper created, because "the
    // folder is empty" and "the folder could not be read" are different answers too.
    let absent = std::env::temp_dir().join(format!("nkw-pet-absent-{}", std::process::id()));
    let missing = library
        .install(&install_request("cat", &absent))
        .expect_err("a source that was never there");
    assert!(
        matches!(&missing, ResourceRefusal::NoSource { path } if path == &absent),
        "a source that could not be read is refused as a source, not as a name: {missing:?}"
    );
}

#[test]
fn a_symlinked_pack_entry_is_refused_rather_than_followed() {
    let (library, _data) = library("security-symlink");
    let source = pack_dir("security-symlink");
    write(&source, "sheet.png", &png(64, 64));
    // A link inside the pack that points outside it: following one would make what gets copied
    // depend on a file the user never chose, and on a second read on whether it still exists.
    std::os::unix::fs::symlink("/etc/hostname", source.join("linked.png")).expect("a symlink");

    let refusal = library
        .install(&install_request("cat", &source))
        .expect_err("a link");
    assert_eq!(refusal_of(&refusal), &PackageProblem::Symlink);
    assert!(listing(library.root()).is_empty());
}

#[test]
fn a_subdirectory_is_refused_rather_than_walked() {
    let (library, _data) = library("security-nested");
    let source = pack_dir("security-nested");
    write(&source, "sheet.png", &png(64, 64));
    std::fs::create_dir_all(source.join("frames")).expect("a nested directory");
    write(&source.join("frames"), "01.png", &png(16, 16));

    let refusal = library
        .install(&install_request("cat", &source))
        .expect_err("a pack is a flat set of files");
    assert_eq!(refusal_of(&refusal), &PackageProblem::Directory);
    assert!(listing(library.root()).is_empty());
}

#[test]
fn an_archive_is_refused_by_its_bytes_whatever_it_is_called() {
    let (library, _data) = library("security-archive");
    for name in ["cat.zip", "cat.dat", "pack"] {
        let source = pack_dir(&format!("security-archive-{name}"));
        write(&source, "sheet.png", &png(64, 64));
        write(
            &source,
            name,
            b"PK\x03\x04\x14\x00\x00\x00 a zip by its own bytes",
        );

        let refusal = library
            .install(&install_request("cat", &source))
            .expect_err("an archive");
        assert_eq!(
            refusal_of(&refusal),
            &PackageProblem::Archive,
            "{name} was refused for the wrong reason"
        );
    }
    // A corrupt archive is still refused, and refused as an archive: the name decides the
    // sentence when the bytes cannot.
    let source = pack_dir("security-archive-broken");
    write(&source, "sheet.png", &png(64, 64));
    write(&source, "cat.zip", b"not a zip at all");
    let refusal = library
        .install(&install_request("cat", &source))
        .expect_err("a .zip");
    assert_eq!(refusal_of(&refusal), &PackageProblem::Archive);
    assert!(listing(library.root()).is_empty());
}

#[test]
fn a_document_in_a_pack_is_refused_and_never_carried_into_the_library() {
    let (library, _data) = library("security-script");
    // SVG is the case that matters: it is an image by every naming convention and a document by
    // behaviour, and this app renders imported text as text — a resource path that bypassed that
    // would be the regression §7.2's D9 work removed.
    let cases: [(&str, &[u8]); 3] = [
        (
            "sheet.svg",
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
        ),
        ("payload.dat", b"<!doctype html><script>alert(1)</script>"),
        ("pet.js", b"export default 1"),
    ];
    for (name, bytes) in cases {
        let source = pack_dir(&format!("security-script-{name}"));
        write(&source, "sheet.png", &png(64, 64));
        write(&source, name, bytes);

        let refusal = library
            .install(&install_request("cat", &source))
            .expect_err("a document");
        assert_eq!(refusal_of(&refusal), &PackageProblem::Script, "{name}");
    }
    assert!(listing(library.root()).is_empty());
}

#[test]
fn the_sheet_budget_is_measured_from_the_header_and_not_taken_on_trust() {
    let (library, _data) = library("security-budget-edge");
    let source = pack_dir("security-budget-edge");
    write(&source, "sheet.png", &png(MAX_IMAGE_EDGE + 1, 16));
    let refusal = library
        .install(&install_request("cat", &source))
        .expect_err("too wide");
    assert_eq!(
        refusal,
        ResourceRefusal::Budget {
            rule: "image-edge",
            limit: MAX_IMAGE_EDGE as u64,
            found: (MAX_IMAGE_EDGE + 1) as u64,
        }
    );

    // The same ceiling, measured the same way, in each of the four formats: a header parser that
    // worked for one container and returned `None` for another would admit the second unbounded.
    for (name, bytes, found) in [
        ("sheet.gif", gif(4097, 16), 4097u64),
        ("sheet.jpg", jpeg(16, 4097), 4097),
        ("sheet.webp", webp(4097, 4097), 4097),
    ] {
        let source = pack_dir(&format!("security-budget-{name}"));
        write(&source, name, &bytes);
        let refusal = library
            .install(&install_request("cat", &source))
            .expect_err("too large");
        assert_eq!(
            refusal,
            ResourceRefusal::Budget {
                rule: "image-edge",
                limit: MAX_IMAGE_EDGE as u64,
                found,
            },
            "{name}"
        );
    }

    // §8 states the edge and the total pixels as two rows. Held together they are one ceiling:
    // the largest square a sheet may be. Pinned so that raising one without the other fails here
    // rather than in a settings page that suddenly admits a sheet nothing can draw.
    assert_eq!(
        MAX_IMAGE_PIXELS,
        MAX_IMAGE_EDGE as u64 * MAX_IMAGE_EDGE as u64
    );
    let source = pack_dir("security-budget-exact");
    write(&source, "sheet.png", &png(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE));
    library
        .install(&install_request("cat", &source))
        .expect("exactly at the ceiling is inside it");
}

#[test]
fn the_package_budgets_are_bounded_in_every_row_they_name() {
    // File count: cheap to reach, and the row that stops a pack of ten thousand frames.
    let (files_library, _files_data) = library("security-files");
    let source = pack_dir("security-files");
    write(&source, PACK_MANIFEST, &pet_json(""));
    for index in 0..=MAX_PACKAGE_FILES {
        write(&source, &format!("frame-{index}.ogg"), b"OggS");
    }
    let refusal = files_library
        .install(&install_request("cat", &source))
        .expect_err("too many files");
    assert!(matches!(
        refusal,
        ResourceRefusal::Budget {
            rule: "file-count",
            ..
        }
    ));

    // Audio: one file, over §8's five mebibytes.
    let (audio_library, _audio_data) = library("security-audio");
    let source = pack_dir("security-audio");
    write(&source, "sheet.png", &png(64, 64));
    write(&source, "meow.ogg", &ogg(5 * 1024 * 1024 + 1));
    let refusal = audio_library
        .install(&install_request("cat", &source))
        .expect_err("too loud");
    assert!(matches!(
        refusal,
        ResourceRefusal::Budget {
            rule: "audio-bytes",
            ..
        }
    ));

    // Package: the whole pack, not one file in it.
    let (total_library, _total_data) = library("security-total");
    let source = pack_dir("security-total");
    // Each file exactly at §8's audio ceiling, so the row that fires is the pack's own total and
    // not the third file's size.
    write(&source, "sheet.png", &png(64, 64));
    for name in ["meow.ogg", "purr.ogg", "hiss.ogg", "mew.ogg", "trill.ogg"] {
        write(&source, name, &ogg(MAX_AUDIO_BYTES as usize - 4));
    }
    let refusal = total_library
        .install(&install_request("cat", &source))
        .expect_err("too big");
    assert!(matches!(
        refusal,
        ResourceRefusal::Budget {
            rule: "package-bytes",
            ..
        }
    ));

    // A rule this module names and never reaches would be a row of §8 it only claims to check.
    assert!(BUDGET_RULES.contains(&"metadata-depth"));
    let mut rules = BUDGET_RULES.to_vec();
    rules.sort_unstable();
    rules.dedup();
    assert_eq!(rules.len(), BUDGET_RULES.len(), "a rule is named twice");
}

#[test]
fn a_declared_grid_is_checked_against_the_renderer_and_against_the_sheet() {
    let (library, _data) = library("security-grid");
    // More cells than the renderer's own grid can address: the extra frames would be drawn by
    // nobody, and a resource that is silently truncated is refused instead.
    let source = pack_dir("security-grid-frames");
    write(&source, "sheet.png", &png(1024, 1024));
    write(
        &source,
        PACK_MANIFEST,
        &pet_json(",\"columns\":100,\"rows\":100"),
    );
    let refusal = library
        .install(&install_request("cat", &source))
        .expect_err("too many frames");
    assert!(matches!(
        refusal,
        ResourceRefusal::Budget { rule: "frames", .. }
    ));
    assert_eq!(
        MAX_FRAMES,
        DEFAULT_SHEET_COLUMNS as u64 * DEFAULT_SHEET_ROWS as u64
    );

    // A grid the sheet does not divide into is a grid that would cut frames in half.
    let source = pack_dir("security-grid-ragged");
    write(&source, "sheet.png", &png(1000, 900));
    write(
        &source,
        PACK_MANIFEST,
        &pet_json(",\"columns\":7,\"rows\":9"),
    );
    let refusal = library
        .install(&install_request("cat", &source))
        .expect_err("ragged");
    assert!(matches!(refusal, ResourceRefusal::MalformedManifest { .. }));

    // Half a grid is not a grid: one field of the pair with the other missing is refused rather
    // than completed from the default, because the pair is one fact.
    let source = pack_dir("security-grid-half");
    write(&source, "sheet.png", &png(800, 900));
    write(&source, PACK_MANIFEST, &pet_json(",\"columns\":8"));
    let refusal = library
        .install(&install_request("cat", &source))
        .expect_err("half a grid");
    assert!(matches!(refusal, ResourceRefusal::MalformedManifest { .. }));

    // A pack that declares nothing is sliced on the renderer's own grid, which is a real answer
    // and not a missing one.
    let source = pack_dir("security-grid-none");
    write(&source, "sheet.png", &png(800, 900));
    let installed = library
        .install(&install_request("cat", &source))
        .expect("no grid declared");
    assert_eq!(
        (installed.sheet.columns, installed.sheet.rows),
        (DEFAULT_SHEET_COLUMNS, DEFAULT_SHEET_ROWS)
    );
}

#[test]
fn metadata_deeper_than_the_library_will_walk_is_refused() {
    let (library, _data) = library("security-depth");
    let source = pack_dir("security-depth");
    write(&source, "sheet.png", &png(64, 64));
    let deep = format!(
        "{{\"displayName\":\"Cat\",\"notes\":{}{}}}",
        "[".repeat(20),
        "]".repeat(20)
    );
    write(&source, PACK_MANIFEST, deep.as_bytes());
    let refusal = library
        .install(&install_request("cat", &source))
        .expect_err("too deep");
    assert!(matches!(
        refusal,
        ResourceRefusal::Budget {
            rule: "metadata-depth",
            ..
        }
    ));
}

#[test]
fn the_sheet_grid_is_the_renderers_own() {
    // Read off disk rather than restated, for the reason D3's tests read the TypeScript: two
    // constants that have to agree, in one language each, is the defect this assertion removes.
    // The grid decides how many frames a sheet can address, so a renderer that changed it would
    // otherwise leave this module bounding a layout nothing draws.
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/features/desktop-pet/rendering/sprite-slicer.ts");
    let text = std::fs::read_to_string(&source)
        .unwrap_or_else(|error| panic!("{} is the renderer's slicer: {error}", source.display()));
    assert!(
        text.contains(&format!("FIXED_GRID_COLS = {DEFAULT_SHEET_COLUMNS}")),
        "the renderer's column count moved"
    );
    assert!(
        text.contains(&format!("FIXED_GRID_ROWS = {DEFAULT_SHEET_ROWS}")),
        "the renderer's row count moved"
    );
}

#[test]
fn a_library_root_the_app_does_not_own_is_refused_before_anything_is_written() {
    for root in ["/usr/share/nekowite", "/etc", "relative/path"] {
        let refusal = CharacterLibrary::new(Path::new(root)).expect_err("not the app's to write");
        assert!(
            matches!(refusal, ResourceRefusal::OutsideManagedScope { .. }),
            "{root}"
        );
    }
}
