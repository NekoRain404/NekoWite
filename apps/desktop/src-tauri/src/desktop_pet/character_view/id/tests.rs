//! The invented id: what survives a slug, what happens when the name has nothing usable in it, and
//! what an id that is already taken becomes.
//!
//! Beside `id.rs`. The cases that need a library are the ones about a *taken* id — the rest are the
//! pure rule, which is why they need nothing at all — and the slug cases carry the bound's own
//! reason: it is bytes, so a name in Chinese costs three of them a character.

use crate::desktop_pet::resources::is_path_component;

use super::super::test_support::{install, library};
use super::*;

#[test]
fn a_folder_name_becomes_a_component_and_loses_its_edges() {
    assert_eq!(slug("My Pet! 2"), "my-pet-2");
    assert_eq!(slug("  ...  "), "");
    assert_eq!(slug("a"), "a");
    // Runs of punctuation collapse rather than becoming runs of dashes, so two folders that
    // differ only in punctuation do not become two characters nobody can tell apart.
    assert_eq!(slug("snake__pet"), "snake-pet");
    assert!(slug(&"x".repeat(200)).len() <= MAX_ID_CHARS);
    // The bound is bytes and a Chinese name costs three of them a character, so a generator
    // that counted characters would write an id three times this long — and a name the
    // library then refuses.
    let long_cjk = slug(&"猫".repeat(200));
    assert!(long_cjk.len() <= MAX_ID_CHARS, "{long_cjk}");
    assert!(is_path_component(&long_cjk));
}

#[test]
fn a_folder_named_in_chinese_has_an_id_in_chinese() {
    let (library, _data) = library("cjk-id");
    // The gap D12's report named: a Chinese folder name was refused because "an id is
    // ASCII". An id is a path component, and `喵喵` is one — so the id is the folder's name.
    assert_eq!(free_character_id(&library, "喵喵").expect("an id"), "喵喵");
    assert_eq!(
        free_character_id(&library, "我的猫 2").expect("an id"),
        "我的猫-2"
    );
    // Scripts with case are still lowercased and still lose their punctuation, so nothing
    // about the ids a library already holds moved.
    assert_eq!(
        free_character_id(&library, "Kitty").expect("an id"),
        "kitty"
    );
}

#[test]
fn a_name_with_no_letter_or_digit_in_it_has_no_id_and_says_which_folders_work() {
    let (library, _data) = library("no-id");
    for name in ["…", "!!!", "🐱"] {
        let refusal = free_character_id(&library, name).expect_err("nothing survives the slug");
        assert!(refusal.contains("no letter or digit"), "{refusal}");
        // The sentence must not restate the rule that was removed: nothing here was refused
        // for being outside ASCII, and a user who reads it must not go renaming a folder that
        // was never the problem.
        assert!(!refusal.contains("ASCII"), "{refusal}");
    }
    // 你好 is not one of those cases, and the difference is which of the two rules refused.
    assert_eq!(
        free_character_id(&library, "你好").expect("letters"),
        "你好"
    );
}

#[test]
fn an_id_that_is_taken_is_suffixed_rather_than_refused() {
    let (library, _data) = library("taken");
    install(&library, "kitty", "Kitty");

    assert_eq!(
        free_character_id(&library, "Kitty").expect("a free variant"),
        "kitty-2"
    );

    // And the same rule in Chinese, which is the case a user meets by importing the folder
    // they already imported: the second one is a character beside the first, not a refusal —
    // and never a second import over the first.
    install(&library, "喵喵", "喵喵");
    assert_eq!(
        free_character_id(&library, "喵喵").expect("a free variant"),
        "喵喵-2"
    );
    assert_eq!(
        free_character_id(&library, "喵喵-3").expect("a free variant"),
        "喵喵-3"
    );
    assert_eq!(library.list().expect("readable").len(), 2);
}
