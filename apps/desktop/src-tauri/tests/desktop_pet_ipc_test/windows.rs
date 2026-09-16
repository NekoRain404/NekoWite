//! Which windows exist, and what they were asked for (§7.1's 按需创建 and its cap).
//!
//! The cap cases are here rather than beside the settings that carry the number because §7.1 makes
//! the backend the authority (「数量上限由后端控制」): a front end that asked for fifty characters
//! has to meet a refusal, and the refusal is what these tests read.

use std::path::Path;

use crate::desktop_pet::window_host::{
    HostRefusal, PetWindowHost, Placement, DEFAULT_CHARACTER_CAP, DESKTOP_PET_PAGE,
    HARD_CHARACTER_CAP, PET_WINDOW_STYLE,
};
use crate::support::{fill, with_host, FakeSurfaces};

#[test]
fn one_character_opens_one_window_and_asks_for_the_lightweight_entry() {
    let (mut host, surfaces) = with_host();
    let instance = host.open("cat").expect("the first character fits");

    assert_eq!(surfaces.live(), vec![instance.label.as_str().to_string()]);
    let call = surfaces.last_open();
    assert_eq!(call.page, DESKTOP_PET_PAGE);
    // The page is a file on disk, not a string that happens to look like one: §7.1's whole
    // requirement is that this window loads the pet and nothing else, and a constant nothing
    // builds would leave that requirement unenforced at exactly the moment it matters.
    assert!(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../desktop-pet.html")
            .is_file(),
        "desktop-pet.html is the lightweight entry {DESKTOP_PET_PAGE} names and it is not there"
    );
}

#[test]
fn opening_the_same_character_twice_returns_the_window_it_already_has() {
    let (mut host, surfaces) = with_host();
    let first = host.open("cat").expect("opens");
    let again = host.open("cat").expect("the second call is not an error");

    assert_eq!(first, again);
    assert_eq!(surfaces.opened().len(), 1, "a second window per character");
    assert_eq!(host.instances().len(), 1);
}

#[test]
fn the_default_cap_is_three_and_the_fourth_character_is_refused() {
    let (mut host, _) = with_host();
    assert_eq!(host.cap(), DEFAULT_CHARACTER_CAP);
    fill(&mut host, DEFAULT_CHARACTER_CAP);

    assert_eq!(
        host.open("one-too-many"),
        Err(HostRefusal::CapReached { cap: 3, open: 3 })
    );
    assert_eq!(host.instances().len(), 3, "the refusal opened something anyway");
}

#[test]
fn the_cap_cannot_be_set_above_the_hard_ceiling() {
    let (mut host, _) = with_host();
    assert_eq!(host.set_cap(50), HARD_CHARACTER_CAP);
    // Below one character there is no feature to have, so the floor is the same kind of clamp.
    assert_eq!(host.set_cap(0), 1);

    host.set_cap(HARD_CHARACTER_CAP);
    fill(&mut host, HARD_CHARACTER_CAP);
    assert!(matches!(
        host.open("one-too-many"),
        Err(HostRefusal::CapReached { cap: 5, open: 5 })
    ));
}

#[test]
fn lowering_the_cap_does_not_close_windows_that_are_already_open() {
    let (mut host, surfaces) = with_host();
    fill(&mut host, DEFAULT_CHARACTER_CAP);

    assert_eq!(host.set_cap(1), 1);
    // The limit is on opening. Closing what the user has because a number moved would be this
    // module deciding to take something away, which is the class of thing §4 rules out.
    assert_eq!(host.instances().len(), 3);
    assert_eq!(surfaces.live().len(), 3);
}

#[test]
fn every_window_is_asked_for_with_the_same_presentation() {
    let (mut host, surfaces) = with_host();
    host.open("one").expect("opens");
    host.open("two").expect("opens");

    for call in surfaces.opened() {
        assert_eq!(call.style, PET_WINDOW_STYLE);
    }
    // Field by field, because the value could be equal and wrong in the same way: these are §7.2's
    // four rows plus the three upstream set at every one of its builder sites.
    assert!(PET_WINDOW_STYLE.transparent, "transparency (§7.2)");
    assert!(!PET_WINDOW_STYLE.decorations, "borderless (§7.2)");
    assert!(PET_WINDOW_STYLE.always_on_top, "always on top (§7.2)");
    assert!(!PET_WINDOW_STYLE.focused, "must not steal focus (§7.2)");
    assert!(PET_WINDOW_STYLE.skip_taskbar, "not a second taskbar entry");
    assert!(!PET_WINDOW_STYLE.resizable);
    assert!(!PET_WINDOW_STYLE.shadow);
}

#[test]
fn a_new_window_is_opened_hidden_when_the_pet_is_hidden() {
    let (mut host, surfaces) = with_host();
    host.open("one").expect("opens");
    host.set_visible(false).expect("hides");

    host.open("two").expect("a second character still opens");

    // Creating a window while the feature is hidden must not flash it on screen: §7.1's 隐藏 is a
    // state of the feature, not of one window.
    assert!(!surfaces.last_open().visible);
}

#[test]
fn an_unreadable_screen_is_not_replaced_by_a_guessed_one() {
    let surfaces = FakeSurfaces::new();
    surfaces.state().work_area = None;
    let mut host = PetWindowHost::new(Box::new(surfaces.clone()));

    host.open("cat").expect("a window with no screen to read");

    // Upstream substituted 1920x1080 for a monitor it could not read (`lib.rs:194`), which is how
    // a pet ends up off-screen on exactly the display that failed. The margin is inside every
    // screen there is, and the compositor has the last word.
    assert_eq!(
        surfaces.last_open().at,
        Placement {
            x: 20.0,
            y: 20.0
        }
    );
}

#[test]
fn windows_are_cascaded_so_they_do_not_stack_on_one_pixel() {
    let (mut host, surfaces) = with_host();
    let first = host.open("one").expect("opens");
    let second = host.open("two").expect("opens");
    let opened = surfaces.opened();
    let (a, b) = (opened[0].at, opened[1].at);

    assert_ne!(a, b);
    assert!(a.x < b.x && a.y < b.y, "the cascade goes down-right");
    assert!(a.x >= 0.0 && b.x >= 0.0);
    assert_ne!(first.label, second.label);
}
