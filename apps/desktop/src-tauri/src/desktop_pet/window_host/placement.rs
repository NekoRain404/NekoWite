//! Where a new window goes, and the two screen values the rule reads.
//!
//! Split out of `window_host.rs` when that file passed the line budget `docs/dev.md:286` puts on a
//! business source file. It changes when placement does — upstream's cascade, the work-area clamp,
//! the two margins — which is a question about a screen rather than about the pet, so a fix for a
//! window parked under a taskbar lands here and nowhere else. The cascade itself is a method on
//! `PetWindowHost` because only the host knows the two facts it reads (how many instances are open,
//! and the size they were built at); what lives here is the arithmetic and the values it answers in.
//!
//! **An unreadable monitor is not substituted.** [`WorkArea`] is an `Option` on the port and the
//! cascade falls back to the margin, because upstream's `unwrap_or((1920.0, 1080.0))` (`:194`) could
//! park the pet off-screen on exactly the display it had just failed to read (§7.2's rule about
//! substitution). The clamp is against the *work area* rather than the monitor's size, which is the
//! same screen without the strip a taskbar reserved.

use serde::Serialize;

use super::geometry::character_window_size;
use super::PetWindowHost;

/// A new window's position, logical px.
#[derive(Clone, Copy, PartialEq, Debug, Serialize)]
pub struct Placement {
    pub x: f64,
    pub y: f64,
}

/// A monitor's usable rectangle, logical px: upstream's `primary_work_area` (`:181-196`).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct WorkArea {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl PetWindowHost {
    /// Where a new window goes: upstream's cascade (`:281-292`), stepped by index so several
    /// characters do not land on one pixel, clamped inside the work area.
    ///
    /// Upstream read the monitor's `size()` (`:185-190`), which includes the taskbar, so its
    /// clamp could park a window under it; the work area is the same screen without the strip
    /// reserved for it. An unreadable screen is not substituted with a guessed one — §7.2's rule
    /// — so the window is placed at the margin and the compositor has the last word.
    pub(super) fn cascade(&self) -> Placement {
        const STEP: f64 = 40.0;
        const MARGIN: f64 = 20.0;
        // The window the clamp is about: the size this host would open one at, which is the stored
        // character size. A cascade that clamped against a different number would park the window
        // under the taskbar it is trying to avoid.
        let (width, height) = character_window_size(self.character_size);
        let index = self.instances.len() as f64;
        let Some(area) = self.surfaces.work_area() else {
            return Placement {
                x: MARGIN,
                y: MARGIN,
            };
        };
        Placement {
            x: (area.x + MARGIN + index * STEP)
                .min(area.x + area.width - width)
                .max(area.x),
            y: (area.y + MARGIN + index * STEP)
                .min(area.y + area.height - height)
                .max(area.y),
        }
    }
}
