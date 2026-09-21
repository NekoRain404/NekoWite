//! The presentation preferences the host holds, and applying one to the windows that are open.
//!
//! Split out of `window_host.rs` when that file passed the line budget `docs/dev.md:286` puts on a
//! business source file. It changes when a §5.2 setting gains a live effect on the pet that is on
//! screen: both setters exist because a control the user moves while the window stays the size — or
//! the stacking — it was opened at is a control that lies, which is the defect `view.alwaysOnTop`
//! shipped with until a setter read it. Reading the stored value is `presentation.rs`'s half; what
//! is here is what happens to the windows already up, and the refusal that comes back when a
//! compositor will not do it.
//!
//! Both walk every open window before anything is reported, and the *first* refusal is what a caller
//! reads: stopping at the first would leave the rest in the state the user just changed, and
//! reporting only the last would hide the reason the earlier ones failed. The preference is kept
//! either way — it is the user's, and the next window opens with it.

use super::geometry::character_window_size;
use super::identity::PetWindowLabel;
use super::outcomes::{HostRefusal, WindowAction};
use super::presentation::WindowStyle;
use super::PetWindowHost;

impl PetWindowHost {
    /// The size the character's windows are built at, as the host currently holds it.
    pub fn character_size(&self) -> f64 {
        self.character_size
    }

    /// Tell the host how big the character is drawn, and resize the windows that are already open.
    ///
    /// The same shape as [`Self::set_always_on_top`], for the same reason: the setting is about the
    /// pet the user can see, so a slider that moved while the window stayed the size it was opened at
    /// would be a control that lies (§5.2). Every open character window is asked before anything is
    /// reported — stopping at the first refusal would leave the rest at the old size — and the *first*
    /// refusal is what a caller reads. The preference is kept either way: it is the user's, and the
    /// next window opens with it.
    ///
    /// The ball is not touched: it has a size of its own (`general.ballSize`, [`Self::set_ball_size`])
    /// and the two are different settings about different windows.
    pub fn set_character_size(&mut self, size: f64) -> Result<(), HostRefusal> {
        self.character_size = size;
        let (width, height) = character_window_size(size);
        let labels: Vec<PetWindowLabel> = self
            .instances
            .iter()
            .map(|instance| instance.label.clone())
            .collect();
        let mut refusal: Option<HostRefusal> = None;
        for label in &labels {
            if let Err(detail) = self.surfaces.resize(label, (width, height)) {
                refusal.get_or_insert(HostRefusal::Window {
                    action: WindowAction::Resize,
                    detail,
                });
            }
        }
        match refusal {
            Some(refused) => Err(refused),
            None => Ok(()),
        }
    }

    /// The presentation every window is opened with, as the host currently holds it.
    pub fn style(&self) -> WindowStyle {
        self.style
    }

    /// Whether the pet's windows are kept above ordinary ones (`view.alwaysOnTop`, §5.2's 窗口行为).
    ///
    /// **The one window flag that is a setting, and the reason it is a method rather than a field a
    /// caller writes.** Upstream hardcoded `.always_on_top(true)` at every builder site and had no
    /// row for it, so nothing here is a port: §5.2's 常规与交互 offers the choice, the capability
    /// report says whether this desktop can deliver it (§7.2's 「置顶」), and this is what makes the
    /// choice mean something. Until it existed the stored value was read by nobody and the checkbox
    /// wrote into a file — a control that lies, which §5.2 forbids and which only the capability
    /// gate's `unverified` arm was hiding.
    ///
    /// Applies to the windows that are *already open*, not only to the next one: a user who unchecks
    /// the box while the pet is on screen is asking about the pet they can see. Every open window is
    /// asked before anything is reported — a compositor that refused one has not refused the others,
    /// and stopping at the first would leave the rest in the stack the user just changed — and the
    /// *first* refusal is what a caller reads, in the compositor's own words. The preference is kept
    /// either way: it is the user's, and the next window opens with it.
    pub fn set_always_on_top(&mut self, on_top: bool) -> Result<(), HostRefusal> {
        self.style.always_on_top = on_top;
        // The ball is included, and it is one of the pet's windows (§5.1's 悬浮球) — a rule that
        // applied to the character window alone would leave a surface the user cannot put away.
        let labels: Vec<PetWindowLabel> = self
            .instances
            .iter()
            .map(|instance| instance.label.clone())
            .chain(self.ball.label().cloned())
            .collect();
        let mut refusal: Option<HostRefusal> = None;
        for label in &labels {
            if let Err(detail) = self.surfaces.set_always_on_top(label, on_top) {
                refusal.get_or_insert(HostRefusal::Window {
                    action: WindowAction::AlwaysOnTop,
                    detail,
                });
            }
        }
        match refusal {
            Some(refused) => Err(refused),
            None => Ok(()),
        }
    }
}
