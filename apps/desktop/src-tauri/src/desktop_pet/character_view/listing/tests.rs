//! The picker's list: what a page reads out of a library, and what it is told about a character it
//! cannot draw.
//!
//! Beside `listing.rs` rather than inside it, on the seam the module itself draws: the list is a
//! read of the library's own entries, so every case needs an installed character and none of them
//! needs the pet window's drawing facts — which is why the only import below is a fixture.

use super::super::test_support::{install, library};
use super::*;

#[test]
fn the_listing_carries_the_packs_name_and_whether_it_can_be_drawn() {
    let (library, _data) = library("listing");
    let sheet = install(&library, "kitty", "Kitty");

    let intact = entries(&library).expect("the library is readable");
    assert_eq!(intact.len(), 1);
    assert_eq!(intact[0].character_id, "kitty");
    assert_eq!(intact[0].pack_name, "Kitty");
    assert_eq!(intact[0].files, PetCharacterFiles::Intact);
    assert_eq!(intact[0].kind, CharacterKind::Created);
    assert_eq!(intact[0].installed_at_ms, 1_700_000_000_000);

    std::fs::remove_file(sheet).expect("the sheet is there to remove");
    let damaged = entries(&library).expect("the library is readable");
    assert_eq!(damaged[0].files, PetCharacterFiles::Damaged);
}
