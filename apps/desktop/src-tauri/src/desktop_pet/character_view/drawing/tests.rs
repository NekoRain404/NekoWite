//! The pet window's answer: the four arms, and the drawing facts each of them carries.
//!
//! Beside `drawing.rs` rather than inside it, on the seam `url_policy/tests.rs` states — the drawing
//! is the largest piece of this split, and its cases are about the states a character can be in:
//! what a fresh install is told, what a chosen character is handed, and every way a choice that
//! cannot be honoured is *named* rather than emptied. Each case installs what it needs through the
//! shared fixtures, so nothing here is asserted against the module's internals — the path rule and
//! the malformed manifest cases reach the same public `appearance` a command does.

use std::path::Path;

use super::super::ball_size::BallSize;
use super::super::test_support::{install, install_named, library, record};
use super::*;

#[test]
fn a_character_whose_folder_and_sheet_are_named_in_chinese_is_drawable() {
    let (library, _data) = library("cjk-ready");
    let sheet = install_named(&library, "喵喵", "喵喵", "精灵图.png");

    let answer = appearance(
        &record(Some("喵喵"), 200),
        Motion::DEFAULT,
        BubbleOpacity::DEFAULT,
        BubbleMessage::defaults(),
        BallSize::DEFAULT.value(),
        Some(&library),
    );

    let PetAppearance::Ready {
        character_id,
        name,
        sheet_path,
        ..
    } = answer
    else {
        panic!("a Chinese-named character is drawable: {answer:?}");
    };
    assert_eq!(character_id, "喵喵");
    assert_eq!(name, "喵喵");
    // The path the window is handed is the real one on disk. Turning it into a URL is
    // `convertFileSrc`'s job on the front end, and that percent-encodes — the protocol decodes
    // before it checks the scope, so a non-ASCII path is served like any other.
    assert_eq!(Path::new(&sheet_path), sheet);
    assert!(sheet.is_file());
}

#[test]
fn nothing_chosen_draws_nothing_and_is_not_a_missing_character() {
    let (library, _data) = library("unset");

    assert_eq!(
        appearance(
            &record(None, 200),
            Motion::DEFAULT,
            BubbleOpacity::DEFAULT,
            BubbleMessage::defaults(),
            BallSize::DEFAULT.value(),
            Some(&library),
        ),
        PetAppearance::Unset {
            motion: Motion::DEFAULT,
            bubble_opacity: BubbleOpacity::DEFAULT.value(),
            bubble: BubbleMessage::defaults(),
            ball_size: BallSize::DEFAULT.value(),
        }
    );
}

#[test]
fn an_installed_character_answers_with_its_sheet_and_its_own_grid() {
    let (library, _data) = library("ready");
    let sheet = install(&library, "kitty", "Kitty");

    let answer = appearance(
        &record(Some("kitty"), 200),
        Motion::DEFAULT,
        BubbleOpacity::DEFAULT,
        BubbleMessage::defaults(),
        BallSize::DEFAULT.value(),
        Some(&library),
    );

    let PetAppearance::Ready {
        character_id,
        name,
        sheet_path,
        sheet: grid,
        size,
        idle_mode,
        idle_interval_ms,
        ..
    } = answer
    else {
        panic!("an installed character is drawable: {answer:?}");
    };
    assert_eq!(character_id, "kitty");
    assert_eq!(name, "Kitty");
    assert_eq!(Path::new(&sheet_path), sheet);
    assert_eq!((grid.columns, grid.rows), (6, 5));
    // The drawing facts come from the record the caller passed, not from the code's own
    // defaults: §5.1's size slider and animation mapping have to reach the sprite.
    assert_eq!(size, 200);
    assert_eq!(idle_mode, "random");
    assert_eq!(idle_interval_ms, 5_000);
}

#[test]
fn a_character_that_is_not_installed_is_named_rather_than_emptied() {
    let (library, _data) = library("absent-character");

    let answer = appearance(
        &record(Some("ghost"), 200),
        Motion::DEFAULT,
        BubbleOpacity::DEFAULT,
        BubbleMessage::defaults(),
        BallSize::DEFAULT.value(),
        Some(&library),
    );

    let PetAppearance::Missing {
        character_id,
        detail,
        ..
    } = answer
    else {
        panic!("a choice that cannot be honoured is not a ready one");
    };
    assert_eq!(character_id, "ghost");
    assert!(detail.contains("not installed"), "{detail}");
}

#[test]
fn a_character_whose_sheet_is_gone_is_missing_and_not_ready() {
    let (library, _data) = library("damaged");
    let sheet = install(&library, "kitty", "Kitty");
    std::fs::remove_file(&sheet).expect("the sheet is there to remove");

    let answer = appearance(
        &record(Some("kitty"), 200),
        Motion::DEFAULT,
        BubbleOpacity::DEFAULT,
        BubbleMessage::defaults(),
        BallSize::DEFAULT.value(),
        Some(&library),
    );

    let PetAppearance::Missing { detail, .. } = answer else {
        panic!("the sheet is not there to draw");
    };
    assert!(detail.contains("sheet.png"), "{detail}");
}

#[test]
fn a_manifest_that_names_a_path_does_not_become_one() {
    let (library, _data) = library("traversal");
    install(&library, "kitty", "Kitty");
    // The manifest is a file on disk, so this is what a hand-edited one looks like: a sheet
    // name that is a path. It is refused as a name, not joined onto the library's root.
    let manifest = library.root().join("kitty").join("manifest.json");
    let mut document: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&manifest).expect("the manifest is there"))
            .expect("it is JSON");
    document["sheet"]["file"] = serde_json::Value::String("../outside.png".to_string());
    std::fs::write(&manifest, document.to_string()).expect("the manifest is writable");

    let answer = appearance(
        &record(Some("kitty"), 200),
        Motion::DEFAULT,
        BubbleOpacity::DEFAULT,
        BubbleMessage::defaults(),
        BallSize::DEFAULT.value(),
        Some(&library),
    );

    let PetAppearance::Missing { detail, .. } = answer else {
        panic!("a name that is a path is not a file");
    };
    assert!(detail.contains("outside the library"), "{detail}");
}

#[test]
fn an_app_with_no_library_still_names_the_character_it_cannot_produce() {
    assert!(
        matches!(
            appearance(
                &record(Some("kitty"), 200),
                Motion::DEFAULT,
                BubbleOpacity::DEFAULT,
                BubbleMessage::defaults(),
                BallSize::DEFAULT.value(),
                None
            ),
            PetAppearance::Missing { .. }
        ),
        "no library is a reason, not an absence of a choice"
    );
}
