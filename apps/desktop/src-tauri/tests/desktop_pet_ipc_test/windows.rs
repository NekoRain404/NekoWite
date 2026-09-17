//! Which windows exist, and what they were asked for (§7.1's 按需创建 and its cap).
//!
//! The cap cases are here rather than beside the settings that carry the number because §7.1 makes
//! the backend the authority (「数量上限由后端控制」): a front end that asked for fifty characters
//! has to meet a refusal, and the refusal is what these tests read.

use std::fs;
use std::path::Path;

use crate::desktop_pet::window_host::{
    HostRefusal, PetWindowHost, Placement, BALL_LABEL, BALL_WINDOW_SIZE, CHARACTER_WINDOW_SIZE,
    DEFAULT_CHARACTER_CAP, DESKTOP_PET_BALL_PAGE, DESKTOP_PET_PAGE, HARD_CHARACTER_CAP,
    PET_WINDOW_STYLE,
};
use crate::support::{fill, with_host, FakeSurfaces};

#[test]
fn one_character_opens_one_window_and_asks_for_the_lightweight_entry() {
    let (mut host, surfaces) = with_host();
    let instance = host.open("cat").expect("the first character fits");

    assert_eq!(
        surfaces.live_characters(),
        vec![instance.label.as_str().to_string()]
    );
    let call = surfaces.last_character_open();
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
    assert_eq!(
        surfaces.character_opens().len(),
        1,
        "a second window per character"
    );
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
    assert_eq!(
        host.instances().len(),
        3,
        "the refusal opened something anyway"
    );
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
    assert_eq!(surfaces.live_characters().len(), 3);
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

/// The one flag of that presentation that is a setting, and the rule that makes it one.
///
/// `view.alwaysOnTop` is upstream's *absence* as much as its value — every builder site upstream has
/// hardcodes `true` and its page has no row for it — so what is asserted here is the host's own
/// rule: the windows are opened with the style it holds, an already-open window is asked to change
/// when it moves, and the compositor's refusal is reported rather than swallowed. The settings that
/// drive it are `window_style.rs`'s; this is the half that has nothing to do with a store.
#[test]
fn a_window_is_opened_with_the_style_the_host_holds() {
    let (mut host, surfaces) = with_host();
    host.open("cat").expect("the pet opens");
    // The default is upstream's, so the change below is the only thing that moves the flag.
    assert!(surfaces.last_character_open().style.always_on_top);

    host.set_always_on_top(false)
        .expect("the fake refuses nothing");

    // Every open window was asked — the character's and the ball's, which is one of the pet's
    // windows (§5.1's 悬浮球) rather than a decoration beside them.
    let changes = surfaces.on_top_changes();
    assert_eq!(changes.len(), host.instances().len() + 1, "{changes:?}");
    assert!(
        changes.iter().any(|(label, _)| label == BALL_LABEL),
        "{changes:?}"
    );
    assert!(changes.iter().all(|(_, on_top)| !on_top), "{changes:?}");

    // …and the next one opens with it rather than being restyled after the fact.
    host.open("dog").expect("within the cap");
    let opened = surfaces.last_character_open();
    assert!(!opened.style.always_on_top);
    // The other six flags do not move with it: this is one setting about one row of §7.2.
    assert_eq!(
        opened.style,
        crate::desktop_pet::window_host::WindowStyle {
            always_on_top: false,
            ..PET_WINDOW_STYLE
        }
    );
}

#[test]
fn a_window_the_compositor_will_not_restyle_is_reported_and_the_others_still_asked() {
    let (mut host, surfaces) = with_host();
    host.open("cat").expect("the pet opens");
    let character = host.instances()[0].label.as_str().to_string();
    surfaces
        .state()
        .refuse_always_on_top
        .push(character.clone());

    let refusal = host
        .set_always_on_top(false)
        .expect_err("the compositor refused the character window");
    // The action that failed, and the windowing system's own words. **Not the label**: a refusal
    // from this host names what was being done and never which window it was done to — §7.1's
    // 「前端不能自选任意 label」 read the other way round, so a caller holding a refusal learns
    // nothing it could aim at another window.
    assert!(
        format!("{refusal:?}").starts_with("Window { action: AlwaysOnTop"),
        "{refusal:?}"
    );
    assert!(format!("{refusal:?}").contains("declined"), "{refusal:?}");
    assert!(
        !format!("{refusal:?}").contains(character.as_str()),
        "the host does not hand a label outward: {refusal:?}"
    );
    // The ball was still asked: a windowing system that refused one window has not refused the
    // others, and stopping at the first would leave the rest in the stack the user just left.
    assert!(surfaces
        .on_top_changes()
        .iter()
        .any(|(label, _)| label == BALL_LABEL));
    // The preference is kept either way — it is the user's, and the next window opens with it.
    assert!(!host.style().always_on_top);
}

#[test]
fn a_new_window_is_opened_hidden_when_the_pet_is_hidden() {
    let (mut host, surfaces) = with_host();
    host.open("one").expect("opens");
    host.set_visible(false).expect("hides");

    host.open("two").expect("a second character still opens");

    // Creating a window while the feature is hidden must not flash it on screen: §7.1's 隐藏 is a
    // state of the feature, not of one window.
    assert!(!surfaces.last_character_open().visible);
}

/// The ball: the pet's second surface, brought up by the same call and asked for as the
/// reference's window rather than as a small character window.
///
/// Every number here is upstream's, and each is the difference between the two surfaces: the
/// label (`lib.rs:310`), the 80x80 box for a 56 px orb (`lib.rs:312-314`), the page, and the same
/// seven presentation flags (`lib.rs:366-372`).
#[test]
fn the_pet_comes_up_with_its_ball_on_the_reference_s_window() {
    let (mut host, surfaces) = with_host();
    host.open("cat").expect("opens");

    let ball = surfaces.ball_call();
    assert_eq!(ball.label, BALL_LABEL);
    assert_eq!(ball.label, "pet-ball");
    assert_eq!(ball.page, DESKTOP_PET_BALL_PAGE);
    assert_eq!(ball.size, BALL_WINDOW_SIZE);
    assert_eq!(ball.size, (80.0, 80.0));
    assert_ne!(ball.size, CHARACTER_WINDOW_SIZE);
    assert_eq!(ball.style, PET_WINDOW_STYLE);
    assert!(ball.visible);

    // The page is a file on disk for the same reason the character page is: a constant nothing
    // builds is a window that loads a blank frame in the packaged app.
    assert!(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../desktop-pet-ball.html")
            .is_file(),
        "desktop-pet-ball.html is the entry {DESKTOP_PET_BALL_PAGE} names and it is not there"
    );
}

#[test]
fn the_ball_is_opened_once_however_many_characters_arrive() {
    let (mut host, surfaces) = with_host();
    fill(&mut host, DEFAULT_CHARACTER_CAP);

    let balls: Vec<_> = surfaces
        .opened()
        .into_iter()
        .filter(|call| call.label == BALL_LABEL)
        .collect();
    assert_eq!(
        balls.len(),
        1,
        "the ball is one window, not one per character"
    );
    assert_eq!(host.ball().map(|label| label.as_str()), Some(BALL_LABEL));
    // And it is not a character: the cap counts characters, and a second `open` for a character
    // that already has a window must not open a second ball either.
    assert_eq!(host.instances().len(), DEFAULT_CHARACTER_CAP);
}

#[test]
fn the_ball_lands_in_the_corner_upstream_put_it_in() {
    let (mut host, surfaces) = with_host();
    host.open("cat").expect("opens");

    // The fake's work area is 1920x1080 at the origin, so upstream's default (`lib.rs:357`:
    // `(sw - BALL_W - 24, sh - BALL_H - 80)`) is `(1920 - 80 - 24, 1080 - 80 - 80)`.
    assert_eq!(
        surfaces.ball_call().at,
        Placement {
            x: 1816.0,
            y: 920.0
        }
    );
}

#[test]
fn a_ball_with_no_screen_to_read_goes_to_the_margin_not_to_a_guessed_corner() {
    let surfaces = FakeSurfaces::new();
    surfaces.state().work_area = None;
    let mut host = PetWindowHost::new(Box::new(surfaces.clone()));

    host.open("cat").expect("a window with no screen to read");

    // The same rule as the character's cascade: an unreadable monitor is not replaced by a size
    // somebody guessed, so there is no "bottom right of 1920x1080" to compute — only the margin
    // upstream's default corner is measured from, and the compositor has the last word.
    assert_eq!(surfaces.ball_call().at, Placement { x: 24.0, y: 80.0 });
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
    assert_eq!(surfaces.last_open().at, Placement { x: 20.0, y: 20.0 });
}

#[test]
fn windows_are_cascaded_so_they_do_not_stack_on_one_pixel() {
    let (mut host, surfaces) = with_host();
    let first = host.open("one").expect("opens");
    let second = host.open("two").expect("opens");
    let opened = surfaces.character_opens();
    let (a, b) = (opened[0].at, opened[1].at);

    assert_ne!(a, b);
    assert!(a.x < b.x && a.y < b.y, "the cascade goes down-right");
    assert!(a.x >= 0.0 && b.x >= 0.0);
    assert_ne!(first.label, second.label);
}

#[test]
fn the_bubble_fits_the_window_it_is_drawn_in() {
    // The bubble is drawn inside the character window, not in a window of its own: upstream's
    // `index.html` puts `#bubble` and the pet in one column (「The bubble sits above the sprite」)
    // and caps it at `max-width: 260px` — the window's own width. This port's cap was 280, chosen
    // against upstream's 300px *popover* window, which is a different surface; 280 > 260 and the
    // two numbers had never been compared (task-191).
    //
    // The relationship is checked here rather than by a comment, and across the language boundary
    // the way `capabilities.rs` checks the capability vocabulary: the front end cannot import this
    // file, so the side that owns the window reads the side that owns the surface. A webview
    // cannot paint outside its own window, so a bubble wider than this is a clipped bubble — and a
    // clipped bubble cannot even be right-clicked, which is how D13 found the height half of it.
    let layout = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/features/desktop-pet/services/pet-bubble-layout.ts");
    let text = fs::read_to_string(&layout).unwrap_or_else(|error| panic!("{layout:?}: {error}"));

    let bubble = number_after(&text, "export const PET_BUBBLE_MAX_WIDTH =");
    let (window_width, _) = CHARACTER_WINDOW_SIZE;
    assert!(
        bubble <= window_width,
        "the bubble caps itself at {bubble}px and the window it is drawn in is {window_width}px \
         wide (CHARACTER_WINDOW_SIZE): the surface would be clipped, not overhanging"
    );
}

/// The number that follows a marker in a TypeScript file, or a panic naming the marker that moved.
///
/// A panic rather than a default: a constant this test cannot find is a constant it is not
/// checking, and a test that quietly checks nothing is worse than one that fails.
fn number_after(text: &str, marker: &str) -> f64 {
    let from = text
        .find(marker)
        .unwrap_or_else(|| panic!("{marker} is not in the layout service"));
    text[from + marker.len()..]
        .trim_start()
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '.')
        .collect::<String>()
        .parse()
        .unwrap_or_else(|error| panic!("{marker} is not followed by a number: {error}"))
}
