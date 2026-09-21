//! The character, as the two windows read it: the library list a settings page chooses from, and
//! the one drawing the pet window needs.
//!
//! §5.2's 角色与动画 puts the character in front of the user in two places — a picker in the main
//! window and a spritesheet in the pet window — and both are reads of the same two facts: what the
//! library holds (`resources.rs`) and what the `character` settings domain says. This module is
//! the join, and nothing in this tree touches a window, a file or the network: it turns what those
//! two already answered into the shapes a window can draw.
//!
//! **The split, and what makes each piece change.** This file was 1558 lines — the largest business
//! file in the tree, against the 600-line backlog `docs/dev.md:286` names — and the only thing
//! holding its contents together was the reader that happened to want all of them. Each part
//! answers a different question and moves on a different clock, so each is a module of its own
//! beneath `character_view/`, with the cases for it in a behaviour file beside it:
//!
//! - [`listing`] — every installed character as the picker shows it: its id, the pack's name, its
//!   kind, whether its files can be drawn, and when it was installed. Moves when a *page's* row
//!   gains a column, or the library's per-entry state vocabulary does.
//! - [`drawing`] — the one character the pet window draws: the sheet and its grid, the rendered
//!   size, the animation mapping — or the state that says why it draws nothing. Moves when the *pet
//!   window's* wire shape or the `character` domain's drawing fields do.
//! - [`motion`] — `general.motion`, the stored policy on how far the pet's windows may move.
//! - [`bubble`] — `message`, as the surface draws with it: what the bubble shows
//!   ([`BubbleMessage`]) and the alpha it is drawn at ([`BubbleOpacity`]).
//! - [`ball_size`] — `general.ballSize`, the diameter the floating ball is drawn *and windowed* at.
//! - [`id`] — the id the app invents for a folder a human named, and the rule that keeps it a path
//!   component. Moves when the *naming policy* does, never when the library's own rules do.
//! - [`refusal`] — why the library refused, as a sentence a user reads.
//!
//! **Three facts a window is handed alongside the character are not the character's**, and each has
//! a module of its own above for the same reason it has a field of its own on [`PetAppearance`]:
//! none of them can a pet window read for itself — `capabilities/desktop-pet.json` holds no settings
//! read — and all of them ride the appearance because the drawings and those policies are what one
//! frame needs together. That is the argument [`drawing::appearance`]'s own caller makes for handing
//! out the sheet and the size in one answer, one domain over.
//!
//! **Every name that was reachable here is reachable still.** The children are private and the items
//! are re-exported below, so `desktop_pet::character_view::appearance`, `…::free_character_id` and
//! the rest resolve exactly as they did while they were defined in this file. That is what keeps
//! `desktop_pet/mod.rs`'s re-export list, `window_host`'s reading of [`BallSize`], `bundled`'s of
//! [`free_character_id`] and every test target that imports from this path from having to know the
//! split happened.
//!
//! `Drawing` — the `character` domain's fields a window draws with — is deliberately *not* among
//! them: it is private to [`drawing`], an intermediate of that one read, and a caller that could
//! hold one could hand a window a size the store would have refused.

mod ball_size;
mod bubble;
mod drawing;
mod id;
mod listing;
mod motion;
mod refusal;
// Test-only, and declared here rather than left to the behaviour files that use it: a `.rs` file no
// `mod` names is a file no `cargo check` compiles, which is the defect `tests/module_tree_test.rs`
// exists to catch. `#[cfg(test)]` keeps it out of every release build.
#[cfg(test)]
pub(crate) mod test_support;

pub use ball_size::BallSize;
pub use bubble::{stored_bubble_message, stored_bubble_opacity, BubbleMessage, BubbleOpacity};
pub use drawing::{appearance, PetAppearance, PetCharacterSheet};
pub use id::free_character_id;
pub use listing::{entries, PetCharacterEntry, PetCharacterFiles};
pub use motion::{stored_motion, Motion};
pub use refusal::refusal_sentence;
