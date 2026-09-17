//! The floating ball's window: its label, its page, its size, its corner, and whether the user
//! wants it at all.
//!
//! Moved out of `window_host.rs` by the change that gave the ball its own switch (§13.1's seam,
//! named in `ball-window.md` §7.7 before it was needed): the character windows' rules and the ball's
//! policy are two subjects, and the second one had grown — a label, a page, a size, a corner and now
//! a switch of its own — inside a file whose header is about instances and caps. The host still mints
//! every window and still owns the one `PetSurfaces`; what moved here is *what the ball's window is*
//! and the four operations that follow it, none of which touch a character.
//!
//! **It is still not an instance.** The ball holds no character, the cap does not count it, and no
//! per-window operation (`close_own`, `set_click_through`) can be aimed at it — those resolve their
//! caller through the host's instance list, where the ball has never been. Nothing here changes
//! that; this module is where the reason is now written down beside the window it is about.
//!
//! **The switch.** Upstream stores one of its own (`read_ball_visible`, on by default,
//! `references/.../src-tauri/src/lib.rs:334-339`) and its settings page has had a 「Show floating
//! ball」 row all along; this build's `general` domain had no such field, so the ball followed the
//! master switch and a user who wanted the character but not the ball could not say so. It is
//! `general.ball` now, and the rule is upstream's: the ball exists when this switch is on, and
//! nothing about the character window decides it — a ball on its own, with no character window at
//! all, is the state the pair of switches exists for (「只开悬浮球」). The one gate above it is
//! `general.enabled`, §5.1's master switch and §4's rollback, which takes *every* pet window down
//! and is not a window's own switch: a ball with the feature switched off would be a surface the
//! switch the user pulled does not govern.
//!
//! Ported from that file at commit `be171a01273a1ed92a27bcdf72f8a58768bac421` (MIT, `Copyright (c)
//! 2026 Nguyễn Thành Đạt`): `BALL_W`/`BALL_H` and the 24/80 margins are its numbers, and the
//! position rule is its `spawn_floating_ball_impl` (`:347-372`) minus the part this build has no
//! window for yet (a restored position, and the snap that would write one).

use super::window_host::{
    HostRefusal, PetSurfaces, PetWindowLabel, Placement, WindowAction, WindowStyle,
};

/// The floating ball's window label. Fixed, and not a generation: there is one ball (upstream's
/// `FLOATING_BALL_LABEL`, `:310`), so there is nothing for a generation to distinguish it from.
///
/// It carries the pet's label prefix on purpose. `capabilities/desktop-pet.json` selects its windows
/// by the glob `pet-*`, and a label outside it would be a window with no capability at all — and
/// `capabilities/desktop-pet-ball.json` narrows what this one window may do beyond that, which is
/// the same glob rule read the other way.
pub const BALL_LABEL: &str = "pet-ball";

/// The ball's page. The second light entry (§9), beside `desktop-pet.html`: the ball is a different
/// surface from the character window (it is a launcher that stays where it is put, while the
/// character roams) and it must not be click-through, so it is not the character window's page and
/// not the character window's bundle.
pub const DESKTOP_PET_BALL_PAGE: &str = "desktop-pet-ball.html";

/// The ball window's size in logical px: upstream's `BALL_W`/`BALL_H` (`:312-314`) — an 80 px square
/// for a 56 px orb, so the orb's shadow and its hover scale are not clipped by the window's own
/// edges.
///
/// The number is what the *host asks for*. What a compositor gives back is its own business:
/// `ball-window.md` §5 measured WebKitGTK 4.1 handing back 200x200 for this request, because the
/// engine's content minimum wins over `inner_size`, and the page draws its 80 px box at the
/// window's top-left.
pub const BALL_WINDOW_SIZE: (f64, f64) = (80.0, 80.0);

/// Where a ball with no readable screen is placed, and the margins upstream used for its default
/// corner (`:357`: `(sw - BALL_W - 24, sh - BALL_H - 80)` — the wider bottom gap is where a taskbar
/// or a dock usually is).
const BALL_MARGIN_X: f64 = 24.0;
const BALL_MARGIN_Y: f64 = 80.0;

/// The ball's window, as the host holds it.
///
/// `enabled` is the user's answer (`general.ball`) and `label` is minted by the host whether or not
/// a window is on screen: a label is the host's to make, and handing it over at construction is what
/// keeps `PetWindowLabel`'s one constructor inside `window_host`.
#[derive(Debug)]
pub(super) struct Ball {
    label: PetWindowLabel,
    /// Whether the user wants the ball. True is what a store that has never been written reads as —
    /// `general.ball`'s own default (`settings/fields.rs`) — which is why the host is built with it
    /// on and the stored value replaces it at startup (`feature_switch::restore`).
    enabled: bool,
    /// Whether a window is on screen for it. Not the same fact as `enabled`: a ball can be wanted
    /// and not open (the pet is switched off, or the compositor refused the window).
    open: bool,
}

impl Ball {
    pub(super) fn new(label: PetWindowLabel) -> Self {
        Self {
            label,
            enabled: true,
            open: false,
        }
    }

    /// The ball's window, when it is open.
    ///
    /// The label stays inside its own type and no operation accepts one, so this is a read for a
    /// report or a test rather than a handle a caller could aim something with.
    pub(super) fn label(&self) -> Option<&PetWindowLabel> {
        self.open.then_some(&self.label)
    }

    pub(super) fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Open the ball's window if the user wants one and the pet does not have one yet.
    ///
    /// Idempotent, and recorded *after* the call succeeds: a compositor that refused it leaves this
    /// state believing there is no window, so the next enable asks again instead of reporting a
    /// window that is not there.
    ///
    /// **The switch is read here and not by the caller.** Three callers reach it — the host's
    /// `open` (the enable path, and a character pick), `PetWindowHost::ensure_ball` (the write that
    /// turns 显示角色窗口 off, where the ball is the window that stays), and nothing else — and none
    /// of them asks whether the ball is wanted: what "the ball is on" means is decided here, once,
    /// in `if !self.enabled` below.
    ///
    /// The presentation is the *host's* ([`PetWindowHost::style`]) rather than this file's
    /// constant, because one of its flags is a setting (`view.alwaysOnTop`) and the ball is one of
    /// the windows that setting is about. `ball-window.md`'s rule that this module owns "what the
    /// ball's window is" still holds: what it *is* does not change with a preference, and which
    /// stack it sits in does.
    pub(super) fn ensure(
        &mut self,
        surfaces: &mut dyn PetSurfaces,
        style: WindowStyle,
        visible: bool,
    ) -> Result<(), HostRefusal> {
        if !self.enabled || self.open {
            return Ok(());
        }
        let at = self.position(surfaces);
        surfaces
            .open(
                &self.label,
                DESKTOP_PET_BALL_PAGE,
                at,
                BALL_WINDOW_SIZE,
                style,
                visible,
            )
            .map_err(|detail| HostRefusal::Window {
                action: WindowAction::Open,
                detail,
            })?;
        self.open = true;
        Ok(())
    }

    /// Turn the switch on or off, and do what the answer means for the window that is up.
    ///
    /// **On does not open.** The same applied write that carries `ball: true` also carries the rest
    /// of the `general` record — `enabled`, and the character window's own switch — and
    /// `feature_switch::apply` asks the host for each of its windows right after this, so the open
    /// happens there rather than twice here. What this call must not do is open a window with the
    /// master switch off, which is what an unconditional `ensure` would do: the ball would appear on
    /// a desktop whose pet the user had just switched off. {@link Ball::ensure} is the other half,
    /// and it is where the preference reaches a window — `PetWindowHost::ensure_ball` calls it.
    pub(super) fn set_enabled(
        &mut self,
        surfaces: &mut dyn PetSurfaces,
        enabled: bool,
    ) -> Result<(), HostRefusal> {
        self.enabled = enabled;
        if enabled {
            return Ok(());
        }
        self.close(surfaces)
    }

    /// Close the window, and remember that it is gone — or keep it, when the compositor refused.
    ///
    /// A window that would not close stays recorded, so a later teardown tries again rather than
    /// forgetting a window the compositor still holds.
    pub(super) fn close(&mut self, surfaces: &mut dyn PetSurfaces) -> Result<(), HostRefusal> {
        if !self.open {
            return Ok(());
        }
        surfaces
            .close(&self.label)
            .map_err(|detail| HostRefusal::Window {
                action: WindowAction::Close,
                detail,
            })?;
        self.open = false;
        Ok(())
    }

    /// Hide or show the ball with the rest of the pet (§7.1: 「隐藏时停止动画绘制但保留后端提醒」).
    pub(super) fn set_visible(
        &mut self,
        surfaces: &mut dyn PetSurfaces,
        visible: bool,
    ) -> Result<(), HostRefusal> {
        if !self.open {
            return Ok(());
        }
        surfaces
            .set_visible(&self.label, visible)
            .map_err(|detail| HostRefusal::Window {
                action: if visible {
                    WindowAction::Show
                } else {
                    WindowAction::Hide
                },
                detail,
            })
    }

    /// Where the ball goes: upstream's default corner, and never off the screen.
    ///
    /// Upstream *restored* a dragged position from a file and clamped it, defaulting to the
    /// bottom-right (`:350-358`); there is no stored position here because nothing *remembers* one.
    /// The drag itself landed — both of the pet's surfaces have one, the orb and the character
    /// window — but the window it moved is only moved for as long as the compositor is doing it:
    /// §7.2's `position-restore` row is still `unverified`, nothing writes a position to a file, and
    /// a launched window therefore opens at this default again, which is what `position` is. A
    /// stored position arrives with whatever gives the ball its snap. An unreadable work area is not
    /// substituted with a guessed screen (§7.2): the ball goes to the margins and the compositor has
    /// the last word.
    fn position(&self, surfaces: &dyn PetSurfaces) -> Placement {
        let (width, height) = BALL_WINDOW_SIZE;
        let Some(area) = surfaces.work_area() else {
            return Placement {
                x: BALL_MARGIN_X,
                y: BALL_MARGIN_Y,
            };
        };
        Placement {
            x: (area.x + area.width - width - BALL_MARGIN_X).max(area.x),
            y: (area.y + area.height - height - BALL_MARGIN_Y).max(area.y),
        }
    }
}
