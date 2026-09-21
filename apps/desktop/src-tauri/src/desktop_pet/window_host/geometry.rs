//! The character window's numbers: how many of them may exist, and how big one is.
//!
//! Split out of `window_host.rs` when that file passed the line budget `docs/dev.md:286` puts on a
//! business source file. The seam is a reason to change rather than a line count: everything here is
//! a number a *character* window is built from — §7.1's cap and the rendered size §5.1's 角色与动画
//! asks for — and none of them needs an instance, a compositor or a stored record to be decided. A
//! cap that moves because the plan's ceiling did, or a size rule that moves because the page's
//! sprite box did, changes this file and nothing else.
//!
//! **The numbers are here; the rules that enforce them are not.** `PetWindowHost::set_cap` clamps
//! and `PetWindowHost::open` refuses, and both live with the instances they are about, so a reader
//! asking "when is a window refused" never has to open a file about geometry. [`HARD_CHARACTER_CAP`]
//! is the same fact read the other way: the clamp and the ceiling it clamps to are one constant, so
//! "the user asked for 50 characters" cannot reach a window system as 50.
/// §7.1's numbers: 「建议默认最多 3 个、可配置硬上限 5 个，需性能验证后确认」.
///
/// The plan's, not measured ones. The ceiling is a clamp here rather than a constant each caller
/// restates, so "the user asked for 50 characters" cannot reach a window system as 50.
pub const DEFAULT_CHARACTER_CAP: usize = 3;
pub const HARD_CHARACTER_CAP: usize = 5;

/// The character window's size in logical px, for a character drawn at `size` (§5.1's 角色与动画).
///
/// **It was upstream's fixed `260x320` and it is now a function of the setting**, which is the defect
/// this rule closes: the sprite is drawn at `character.size` — the slider offers 64 to 320 — and a
/// window that never moved meant a sprite at the top of the range was drawn into a box narrower than
/// itself.
///
/// **Measured before the rule landed** (Chromium, `page.setViewportSize` as the window, the real
/// `DesktopPetRoot` mounted on the real appearance read — `e2e/desktop-pet-window-fit.spec.ts`): at
/// 320 the canvas was 320x360 and the window 260x320, and the canvas came out **30 px past the left
/// edge, 30 px past the right and 40 px past the bottom**, clipped there by the page's own
/// `overflow: hidden`. It was *not* scaled down: the canvas's CSS box, its backing store and its
/// computed style all read 320x360, because a flex item does not shrink below its own content and
/// there was no free space to take it from. 64 and 160 fitted with room to spare. After the rule, all
/// three fit.
///
/// The rule is stated over *upstream's own pair*: 260x320 is upstream's window and 160x180 is
/// upstream's sprite at 100%, so the difference between them — 100 px of width and 140 px of height,
/// [`CHARACTER_WINDOW_SLACK`] — is the room its window had for the bubble and the character's own
/// breathing space. That slack is what is kept constant, so the window at the default size is exactly
/// the window this build has always opened, and the room above the sprite for the bubble does not
/// shrink as the character grows.
///
/// The aspect is the sheet's ([`SPRITE_ASPECT`], `pet-appearance.ts`'s `BASE_WIDTH`/`BASE_HEIGHT`) and
/// not a number invented here: the window has to be at least as tall as the sprite it holds, and this
/// is the only way to know how tall that is without asking the page. One stored number —
/// `character.size` — is read by this function for the window and by
/// `services/pet-appearance.ts` for the sprite's box; the *aspect* is theirs together and
/// `tests/desktop_pet_settings_test/geometry.rs` reads it out of the TypeScript module, so the two
/// cannot drift apart without a test failing.
pub fn character_window_size(size: f64) -> (f64, f64) {
    let (base_width, base_height) = SPRITE_ASPECT;
    let height = (size * base_height / base_width).round();
    (
        (size + CHARACTER_WINDOW_SLACK.0).max(CHARACTER_WINDOW_MIN_WIDTH),
        height + CHARACTER_WINDOW_SLACK.1,
    )
}

/// The narrowest character window this build will ask for: 260 px, which is upstream's window and
/// the width of the bubble's own cap (`pet-bubble-layout.ts`'s `PET_BUBBLE_MAX_WIDTH`).
///
/// A floor and not a preference. The character is drawn in this window and so is every reminder the
/// pet has: the bubble stretches to the window's width, and a window narrower than the width that
/// cap was chosen against would squeeze every row the surface exists to show. A small character
/// therefore gets a window with more room around it rather than a narrower one — which is also what
/// keeps the *default* window (160 px of character) exactly the 260x320 this build has always opened.
const CHARACTER_WINDOW_MIN_WIDTH: f64 = 260.0;

/// The sprite box's aspect: upstream's canvas at 100% (`index.html:12`, `main.ts:116-117`).
///
/// `PetSprite.vue`'s `BASE_SIZE` and `pet-appearance.ts`'s `BASE_WIDTH`/`BASE_HEIGHT` are the same
/// pair on the page's side, and the reader of the sprite box is `pet-appearance.ts`'s `box()`. Kept
/// as the two numbers rather than as a ratio so the cross-language test can compare them literally.
const SPRITE_ASPECT: (f64, f64) = (160.0, 180.0);

/// What upstream's window has around upstream's sprite: 260x320 minus 160x180.
///
/// The height is where the bubble goes — `DesktopPetRoot.vue` lays the window out as a column with the
/// bubble above the sprite and the sprite against the bottom edge — and the width is what centres a
/// character narrower than the window.
const CHARACTER_WINDOW_SLACK: (f64, f64) = (100.0, 140.0);

/// The rendered size the character window is built for when nothing says otherwise.
///
/// `character.size`'s own default (`settings::fields`, `pet-contracts/config.ts`), which is the size
/// of a window opened before any record has been read — and the size [`character_window_size`] answers
/// upstream's own 260x320 for.
pub const CHARACTER_DEFAULT_SIZE: f64 = 160.0;
