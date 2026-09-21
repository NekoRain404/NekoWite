//! The refusal vocabulary as a user reads it: the sentences a user acts on differently, and the
//! wording a page shows without mapping any of it.
//!
//! Beside `refusal.rs` and needing nothing but it — no library, no store, no window. That is what
//! makes the module's claim checkable at a glance: a sentence is a function of the refusal alone,
//! so the imports here name the refusal and nothing else.

use super::*;

#[test]
fn a_name_the_library_refuses_and_a_pack_it_cannot_read_are_different_sentences() {
    let absent = std::env::temp_dir().join(format!("nkw-pet-view-absent-{}", std::process::id()));
    let named = refusal_sentence(&ResourceRefusal::InvalidName {
        field: "characterId",
        value: "喵/喵".to_string(),
        detail: "a name may not contain \"/\": that is the separator between path components"
            .to_string(),
    });
    let unreadable = refusal_sentence(&ResourceRefusal::NoSource { path: absent });

    // Two claims, and the user acts differently on each: rename the folder, or point at one
    // that is there. A sentence that said the second when the first was true would send a
    // user to fix something that was never wrong.
    assert!(named.contains("cannot be used as"), "{named}");
    assert!(named.contains("separator"), "{named}");
    assert!(unreadable.contains("read"), "{unreadable}");
    assert_ne!(named, unreadable);
}

#[test]
fn the_refusal_sentences_name_the_thing_that_refused() {
    // Two of the refusals a user can actually meet on the import path, so "the wording exists"
    // is asserted rather than assumed: a page shows these strings and nothing maps them.
    let no_sheet = refusal_sentence(&ResourceRefusal::NoSheet);
    assert!(no_sheet.contains("spritesheet"), "{no_sheet}");

    let named = refusal_sentence(&ResourceRefusal::Package {
        name: "evil.png".to_string(),
        problem: PackageProblem::UnusableName,
        detail: "a name may not contain \"/\"".to_string(),
    });
    // The file that was refused, and both halves of why: the category a page groups by, and
    // the clause of the rule that actually refused.
    assert!(named.contains("evil.png"), "{named}");
    assert!(named.contains("the library can hold"), "{named}");
    assert!(named.contains("may not contain"), "{named}");
}
