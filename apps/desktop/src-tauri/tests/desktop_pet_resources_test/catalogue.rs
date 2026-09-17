//! The catalogue as untrusted input: what a document may make this build do, and what it may not.
//!
//! The catalogue is a document written by strangers, served by a host this app does not operate,
//! listing 4,044 rows that each name an address. That makes it the one piece of input in this
//! module that arrives *already shaped like a decision* — and the cases here are about refusing to
//! take it that way:
//!
//! - **A row whose slug is not a path component is not an offer.** The slug becomes a directory
//!   name in the user's library, so `..`, a separator, a leading dot and an over-long name are the
//!   same class of thing here as they are in `security.rs` — except that this one arrives over a
//!   network rather than from a folder the user picked, which is why it is refused while the list
//!   is *read* rather than when the user clicks.
//! - **A row naming an address this build will not fetch is not an offer.** A row that could only
//!   ever fail is a row that wastes the user's click and teaches them the feature is broken.
//! - **A row that is malformed costs one row.** This is the reference's decision
//!   (`PetBrowser.swift:26-31`) and it is kept: decoding the array strictly would make one bad
//!   submission an app that cannot show the catalogue at all.
//! - **A document that is not a catalogue is a refusal, not an empty list.** The distinction the
//!   whole vocabulary exists for: `Err` here is "this is not the document", and `Ok` with an empty
//!   list is "this is the document and it lists nothing".
//!
//! Nothing in this file opens a socket: `parse_catalogue` is a pure function of the bytes, which is
//! what makes these cases runnable at all. The address a row names is checked against the *pinned
//! endpoint's host* — the same rule the fetch path applies — so the fixtures below spell that host
//! out, and a fixture that used a different one would be testing the refusal rather than the parse.

use crate::desktop_pet::resources::{parse_catalogue, CatalogueReading, LIBRARY_ENDPOINT};

/// The host the pinned catalogue is served from, as the fixtures spell it.
///
/// Read off the constant rather than written out again: a fixture that hard-coded the host would go
/// on passing after the endpoint moved, which is exactly the drift these cases are for.
fn catalogue_host() -> String {
    let endpoint = LIBRARY_ENDPOINT.expect("this build reads a catalogue");
    let without_scheme = endpoint.trim_start_matches("https://");
    without_scheme
        .split('/')
        .next()
        .expect("a host")
        .to_string()
}

fn sheet_url(slug: &str) -> String {
    format!("https://{}/pets/{slug}/spritesheet.webp", catalogue_host())
}

/// One entry with everything the live catalogue states, so a case that changes one field changes
/// one field.
fn entry(slug: &str) -> serde_json::Value {
    serde_json::json!({
        "slug": slug,
        "displayName": format!("Pet {slug}"),
        "kind": "creature",
        "submittedBy": "someone",
        "spritesheetUrl": sheet_url(slug),
    })
}

fn document(entries: Vec<serde_json::Value>) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "pets": entries })).expect("a document")
}

#[test]
fn a_row_that_is_malformed_costs_one_row_and_not_the_whole_list() {
    let bytes = document(vec![
        entry("good-one"),
        // No slug at all.
        serde_json::json!({ "displayName": "Nameless", "spritesheetUrl": sheet_url("x") }),
        entry("good-two"),
        // A slug that is not a string.
        serde_json::json!({ "slug": 7, "spritesheetUrl": sheet_url("x") }),
        entry("good-three"),
        // Not an object.
        serde_json::json!("just a string"),
    ]);

    let catalogue = parse_catalogue(&bytes).expect("this is a catalogue");
    let slugs: Vec<&str> = catalogue
        .entries
        .iter()
        .map(|entry| entry.slug.as_str())
        .collect();
    assert_eq!(slugs, ["good-one", "good-two", "good-three"]);
    // Counted, not silently dropped: a page that showed three rows for a six-row document without
    // saying so would be the "[] means three things" defect in its other direction.
    assert_eq!(catalogue.skipped, 3);
}

#[test]
fn a_slug_that_could_not_be_a_directory_name_is_never_offered() {
    // Each of these has a case in `security.rs` for a pack folder the user picked. They are here
    // again because the source is different and so is the moment: a network document is read
    // before the user sees anything, so this is where the row stops existing rather than where an
    // install fails.
    for slug in [
        "..",
        ".",
        "a/b",
        "a\\b",
        ".hidden",
        "",
        "   ",
        "with\u{0}nul",
        "zero\u{200b}width",
        // 65 bytes: one past what a name in the library may be.
        &"x".repeat(65),
    ] {
        let bytes = document(vec![entry(slug)]);
        let catalogue = parse_catalogue(&bytes).expect("this is a catalogue");
        assert!(
            catalogue.entries.is_empty(),
            "{slug:?} was offered as a character"
        );
        assert_eq!(catalogue.skipped, 1, "{slug:?}");
    }
}

#[test]
fn a_row_naming_an_address_this_build_will_not_fetch_is_never_offered() {
    for url in [
        "https://cdn.example.invalid/cat.webp",
        "http://pets.example.invalid/cat.webp",
        "https://127.0.0.1/cat.webp",
        "https://[::1]/cat.webp",
        "file:///etc/passwd",
        "not a url at all",
    ] {
        let bytes = document(vec![serde_json::json!({
            "slug": "cat",
            "spritesheetUrl": url,
        })]);
        let catalogue = parse_catalogue(&bytes).expect("this is a catalogue");
        assert!(
            catalogue.entries.is_empty(),
            "{url} was offered as a character's address"
        );
        assert_eq!(catalogue.skipped, 1, "{url}");
    }
}

#[test]
fn a_document_that_is_not_a_catalogue_is_refused_rather_than_read_as_an_empty_one() {
    // The distinction the whole vocabulary exists for. An empty catalogue is a real state — a
    // catalogue that lists nothing — and it is `Ok`; a document that is not a catalogue is `Err`
    // with a sentence, and a caller that flattened the two would be the defect §3.1 records
    // against the upstream client's `[]`-on-every-failure.
    for bytes in [
        b"not json at all".to_vec(),
        b"<html><body>404</body></html>".to_vec(),
        b"{}".to_vec(),
        b"{\"pets\":{}}".to_vec(),
        b"{\"pets\":\"cat\"}".to_vec(),
        b"[]".to_vec(),
    ] {
        let refusal = parse_catalogue(&bytes)
            .err()
            .unwrap_or_else(|| panic!("a document that is not a catalogue was accepted"));
        assert!(!refusal.is_empty(), "a refusal has to say what refused");
    }

    // And the empty catalogue itself, which is not a failure.
    let empty = parse_catalogue(b"{\"pets\":[]}").expect("an empty catalogue is a catalogue");
    assert!(empty.entries.is_empty());
    assert_eq!(empty.skipped, 0);
}

#[test]
fn one_slug_is_one_row() {
    // The library is keyed by directory and cannot hold two characters under one id, so a
    // catalogue that listed a slug twice would draw a row that could only ever fail with
    // `AlreadyInstalled`. First one wins, which is the reference's rule too.
    let bytes = document(vec![
        entry("cat"),
        serde_json::json!({
            "slug": "cat",
            "displayName": "A different cat",
            "spritesheetUrl": sheet_url("cat"),
        }),
    ]);
    let catalogue = parse_catalogue(&bytes).expect("this is a catalogue");
    assert_eq!(catalogue.entries.len(), 1);
    assert_eq!(catalogue.entries[0].name, "Pet cat");
}

#[test]
fn terms_a_catalogue_states_are_carried_rather_than_dropped() {
    // Every catalogue available today states none — 0 of 4,044 entries carry a terms field — and
    // that is a fact the page says rather than one this build hides. A field that is read is what
    // makes the page able to say it, and what makes the day one appears different from the day it
    // does not.
    let bytes = document(vec![
        entry("no-terms"),
        serde_json::json!({
            "slug": "with-terms",
            "displayName": "With Terms",
            "spritesheetUrl": sheet_url("with-terms"),
            "license": "CC0",
        }),
    ]);
    let catalogue = parse_catalogue(&bytes).expect("this is a catalogue");
    assert_eq!(catalogue.entries[0].terms, None);
    assert_eq!(catalogue.entries[1].terms.as_deref(), Some("CC0"));
}

#[test]
fn the_byline_is_the_catalogues_own_and_is_not_dressed_up_as_permission() {
    let bytes = document(vec![serde_json::json!({
        "slug": "cat",
        "displayName": "Cat",
        "submittedBy": "  someone  ",
        "spritesheetUrl": sheet_url("cat"),
    })]);
    let catalogue = parse_catalogue(&bytes).expect("this is a catalogue");
    // Trimmed, because a name with padding renders with padding; carried as free text, because it
    // is what the catalogue states and this build does not parse it into a claim.
    assert_eq!(catalogue.entries[0].author.as_deref(), Some("someone"));
}

#[test]
fn the_offer_a_window_is_told_about_carries_no_address() {
    // The one direction that matters for §7.1's shape: a renderer names a slug, and the address a
    // character is downloaded from is resolved on the host side from a catalogue the host read. If
    // an offer carried its URL, a front end could hold it, and the next method to take one would
    // be an SSRF primitive with a friendly name.
    let bytes = document(vec![entry("cat")]);
    let catalogue = parse_catalogue(&bytes).expect("this is a catalogue");
    let offer = crate::desktop_pet::resources::CatalogueOffer::from(&catalogue.entries[0]);
    let wire = serde_json::to_string(&offer).expect("an offer serialises");

    assert!(!wire.contains("http"), "{wire}");
    assert!(!wire.contains("Url"), "{wire}");
    assert!(wire.contains("\"slug\":\"cat\""), "{wire}");
}

#[test]
fn a_reading_of_a_catalogue_that_was_never_reached_is_not_an_empty_listing() {
    // The wire shape is a *value* a page can branch on, and the two arms below are the two a page
    // draws differently. This case pins the shapes rather than the wording: a failure arm carries a
    // detail, and the empty arm carries no list at all — there is no arm in which a failure and an
    // empty catalogue are the same value.
    let unreachable = CatalogueReading::Unreachable {
        detail: "the host answered 503".to_string(),
    };
    let empty = CatalogueReading::Empty { skipped: 0 };
    let wire = serde_json::to_string(&unreachable).expect("a reading serialises");
    assert!(wire.contains("\"status\":\"unreachable\""), "{wire}");
    assert!(!wire.contains("offers"), "{wire}");
    let wire = serde_json::to_string(&empty).expect("a reading serialises");
    assert!(wire.contains("\"status\":\"empty\""), "{wire}");
    assert!(!wire.contains("offers"), "{wire}");
}
