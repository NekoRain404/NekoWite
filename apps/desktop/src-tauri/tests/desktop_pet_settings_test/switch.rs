//! The enable path: §5.1's 启用 is a settings *value*, so an applied `general` write is what opens
//! and closes the pet's windows — and this is the only caller `desktop_pet_open` has.
//!
//! The values a save can carry fail in different ways, so this module tree is split at the domains the
//! original file's own headings already drew. A bare `mod` here resolves against this file's own
//! directory, which is where the five siblings below are:
//!
//! - `switch_applied.rs` — an applied `general` write is the switch: the windows it opens and closes,
//!   the two switches as the state rather than a master above them, and the refusals at that boundary.
//! - `switch_window_pair.rs` — the pet's two windows, each on its own switch: 只开悬浮球 and its mirror.
//! - `switch_migration.rs` — the records this build did not write: one from a schema before the two
//!   switches existed, migrated to the meaning it had when it was written, and one whose pair is only
//!   half readable, refused.
//! - `switch_notification.rs` — the same applied write reaching §6.3's ledger through the
//!   `notification` domain's switches.
//! - `switch_launch.rs` — the same switch at the other moment it is known, a launch, where `restore`
//!   reads a store instead of a write.
//!
//! The launch cases stay in this tree, one file over from the write path's, so that everything a
//! launch can do to a host is still read beside the write path's answer to the same question.

mod switch_applied;
mod switch_launch;
mod switch_migration;
mod switch_notification;
mod switch_window_pair;
