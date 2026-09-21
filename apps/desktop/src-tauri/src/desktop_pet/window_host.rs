/**
 * The windows the pet runs in: how many, which labels, and who may ask (§7.1).
 *
 * Ported from `references/desktop-pet/windows/src-tauri/src/lib.rs` at commit
 * `be171a01273a1ed92a27bcdf72f8a58768bac421` (MIT, `Copyright (c) 2026 Nguyễn Thành Đạt`). That
 * file is 892 lines and §9 requires it to be split on the way in rather than copied and tidied
 * later; this is the window half of it. The symbol-by-symbol table is in this task's report.
 *
 * Four behaviours here are not upstream's, and each is something the plan asks for:
 *
 * - **Labels are the host's** (§7.1: 「Tauri 管理窗口标识与角色实例关联」). Upstream took the
 *   label from the front end — `close_extra_pet` (`:487-497`) accepted any string and checked a
 *   prefix on it, and `list_extra_pets` (`:499-505`) handed labels back out. Here a label never
 *   leaves this module: the one operation a pet window may invoke takes no window argument at
 *   all, and the caller's identity is read from the window the windowing system says made the
 *   call, never from the request body.
 * - **Labels are never reused.** Upstream's `next_extra_label` (`:475-485`) picked the lowest
 *   free index, so a closed window's label went to the next one. With identity read from the
 *   label that is an alias: a caller left over from a closed window would inherit a live one's
 *   authority. {@link PetWindowHost}'s counter only rises.
 * - **A cap is a refusal, not a rule for the front end** (§7.1: 「数量上限由后端控制」). Upstream
 *   had no cap — `spawn_extra_pet` (`:446-471`) opened a window per call — so the limit lives
 *   here and comes back as something a caller can show the user.
 * - **Tearing down closes windows and nothing else** (§7.1: 「禁用桌宠销毁动画/监听/计时器，不取消
 *   后台 Agent 任务」). See {@link TeardownReport}: every field it has describes a window.
 *
 * The policy half of this file needs no window at all — {@link PetSurfaces} is injected (§10.2)
 * — which is what lets the rules above be tested against something that is not a compositor.
 *
 * **The ball is the pet's second surface, and this host mints it too** (D11b's
 * `PetFloatingBall.vue` had no window until now). Upstream keeps it in its own window with its own
 * label and its own lifetime (`references/.../src-tauri/src/lib.rs:306-315`: 「A single instance
 * lives on the desktop as a stable click target … so the user doesn't have to chase a roaming
 * pet」), and plan:77 ships it in the port's first round (「不静默删掉」) — but it is not a
 * *character* window: it holds no character, it is not counted by the cap, and no caller may
 * close it per window. Three consequences, each with the place it is enforced:
 *
 * - **It is minted with the same label prefix, so `capabilities/desktop-pet.json` governs it.**
 *   `"windows": ["pet-*"]` is what hands a window the pet's eight commands and two `core:event`
 *   permissions *instead of* `capabilities/default.json`'s sixty-odd; a label that matched
 *   neither would give the ball a window with no IPC at all, and one that matched `main` would
 *   give it the editor's whole surface. The prefix itself, and the two sides that read it, are
 *   `identity.rs`'s; what is this file's is that the ball is built out of the same type.
 * - **It is not an instance, so the two per-window operations refuse it.** {@link
 *   PetWindowHost::close_own} and {@link PetWindowHost::set_click_through} resolve their caller
 *   through {@link PetWindowHost::authorized}, which looks the label up in `instances` — where the
 *   ball is not. A ball window that asked to be click-through is refused by name
 *   (`UnrecognizedCaller { observed: "pet-ball" }`), which is the structural half of 「the ball is
 *   a stable click target and must not be click-through」: the permission is granted to the pet's
 *   windows as a group, and the identity check is what keeps the ball from using it.
 * - **It follows its own switch, not the character list.** The ball exists exactly while
 *   `general.ball` is on, and nothing above that switch decides anything — `general.enabled` is
 *   derived from this one and the character window's, so a record cannot say "no pet window at all"
 *   while a window's own switch is on. {@link PetWindowHost::open} — the call
 *   `feature_switch::apply` makes for the character window — brings it up too,
 *   {@link PetWindowHost::ensure_ball} is the call that brings it up on its own (the window that
 *   exists when 显示角色窗口 is off), {@link PetWindowHost::set_visible} hides and shows it with the
 *   rest, and {@link PetWindowHost::disable} closes it. Its switch (`general.ball`, upstream's
 *   stored flag, `lib.rs:331-345`) is read in {@link Ball::ensure};
 *   {@link PetWindowHost::set_ball_enabled} is how the preference reaches it, and
 *   {@link PetWindowHost::close_characters} is the operation the character window's own switch gets
 *   instead.
 *
 * **What the ball's window *is*, and how it answers its switch, is `ball.rs`.** The policy lived
 * here until it had a switch of its own to hold; the host keeps the one ball, the instances and the
 * rules about them, and the two window *sizes* the two surfaces are built at
 * ([`character_window_size`], and `ball::ball_window_size` for the ball).
 *
 * **The file is now the host and a list of modules.** It passed the budget `docs/dev.md:286` puts on
 * a business source file, and the split is by what makes each piece change rather than by line
 * count: `geometry.rs` (the character window's numbers), `identity.rs` (labels, the page, and who is
 * calling), `presentation.rs` (what a window is asked to be), `outcomes.rs` (what a caller reads
 * back), `placement.rs` (where a new window goes), `preferences.rs` (a setting applied to the
 * windows already open), `surfaces.rs` (the port and the one Tauri implementation) and
 * `selection.rs` (which instance a settings change is about). What is left here is the host: the
 * `PetWindowHost` struct, the ball-facing operations that forward to {@link Ball}, and every rule
 * about *instances* — the cap, the caller check, closing one window or all of them, and what a
 * teardown does. Every name they hold is re-exported below, so `desktop_pet::window_host::…` is
 * still the path every caller outside this file resolves.
 */
mod geometry;
mod identity;
mod outcomes;
mod placement;
mod preferences;
mod presentation;
mod selection;
mod surfaces;

use super::ball::Ball;

// The ball's policy moved to `ball.rs`; the path it was read by does not move with it. Every caller
// that named `window_host::BALL_LABEL` — the command surface's tests among them — still resolves,
// which is the property `state.rs` states for its own split: the split moved the code, not the
// surface. `BALL_WINDOW_SIZE` is gone rather than re-exported: a window size is a function of
// `general.ballSize` now (`ball::ball_window_size`), and a constant here would be the second answer
// the setting exists to end.
pub use super::ball::{
    ball_window_size, BALL_DEFAULT_SIZE, BALL_LABEL, BALL_MARGIN, DESKTOP_PET_BALL_PAGE,
};

// Every name the children above hold is re-exported here, and the modules themselves stay private:
// the surface is this file's, so one of them moving again is a line here rather than a change at
// every call site. `desktop_pet/mod.rs`, `ball.rs`, `feature_switch.rs`, `commands/desktop_pet.rs`
// and the four test targets that name `desktop_pet::window_host::…` all keep resolving, which is the
// property `state.rs` states for its own splits: the split moved the code, not the surface.
pub use geometry::{
    character_window_size, CHARACTER_DEFAULT_SIZE, DEFAULT_CHARACTER_CAP, HARD_CHARACTER_CAP,
};
pub use identity::{CallerWindow, PetWindowLabel, DESKTOP_PET_PAGE};
pub use outcomes::{Closed, HostRefusal, PetInstance, TeardownReport, WindowAction};
pub use placement::{Placement, WorkArea};
pub use presentation::{
    stored_always_on_top, stored_ball_size, stored_character_size, WindowStyle, PET_WINDOW_STYLE,
};
pub use surfaces::{PetSurfaces, TauriSurfaces};

/// The character windows, and the rules about them.
pub struct PetWindowHost {
    surfaces: Box<dyn PetSurfaces>,
    cap: usize,
    /// Only rises. See this file's header: a reused label is an alias onto a live window's
    /// identity, and a caller left over from a closed window would otherwise be believed.
    generation: u32,
    instances: Vec<PetInstance>,
    selected_instance: Option<PetWindowLabel>,
    /// The ball's window and its switch. Deliberately *not* an entry in `instances`: the two types
    /// of window differ in what they hold (a character, or none), in what the cap counts, and in
    /// whether a per-window operation may be aimed at them — see this file's header. The label is
    /// minted here and handed over, which is what keeps `PetWindowLabel`'s one constructor in this
    /// module (`ball.rs`'s header).
    ball: Ball,
    /// What every window this host opens is asked for. [`PET_WINDOW_STYLE`] until a stored
    /// preference replaces it — see [`Self::set_always_on_top`] for the one flag that moves.
    style: WindowStyle,
    /// The rendered size the character is drawn at, `character.size` (§5.1's 角色与动画), which the
    /// character window's own geometry is derived from ([`character_window_size`]).
    ///
    /// Held rather than read per window for the reason the style is: it is a stored preference whose
    /// only door is an applied write (or the launch), and asking a file per `open` would be a read for
    /// a value that moves through one command. [`CHARACTER_DEFAULT_SIZE`] until a store says
    /// otherwise, so a host built without one opens exactly the window this build always opened.
    character_size: f64,
    visible: bool,
}

impl PetWindowHost {
    pub fn new(surfaces: Box<dyn PetSurfaces>) -> Self {
        Self {
            surfaces,
            cap: DEFAULT_CHARACTER_CAP,
            generation: 0,
            instances: Vec::new(),
            selected_instance: None,
            ball: Ball::new(PetWindowLabel::ball()),
            style: PET_WINDOW_STYLE,
            character_size: CHARACTER_DEFAULT_SIZE,
            visible: true,
        }
    }

    /// The cap, clamped to §7.1's ceiling. Returns the effective value so the settings page
    /// shows what the backend will actually enforce rather than what was asked for.
    ///
    /// Lowering it does not close what is already open: the limit is on opening, and closing
    /// windows the user has because a number moved would be this module deciding to take
    /// something away.
    pub fn set_cap(&mut self, requested: usize) -> usize {
        self.cap = requested.clamp(1, HARD_CHARACTER_CAP);
        self.cap
    }

    pub fn cap(&self) -> usize {
        self.cap
    }

    pub fn instances(&self) -> &[PetInstance] {
        &self.instances
    }

    pub fn is_visible(&self) -> bool {
        self.visible
    }

    /// The ball's window, when it is open.
    ///
    /// The label stays inside its own type and no operation accepts one, so this is a read for a
    /// report or a test rather than a handle a caller could aim something with.
    pub fn ball(&self) -> Option<&PetWindowLabel> {
        self.ball.label()
    }

    /// Whether the user wants the ball at all (`general.ball`).
    pub fn ball_enabled(&self) -> bool {
        self.ball.is_enabled()
    }

    /// The ball's own switch, as §5.1's 悬浮球 row writes it — see {@link Ball::set_enabled} for why
    /// turning it *on* opens nothing here.
    pub fn set_ball_enabled(&mut self, enabled: bool) -> Result<(), HostRefusal> {
        self.ball.set_enabled(&mut *self.surfaces, enabled)
    }

    /// How big the ball is drawn, as the ball currently holds it (`general.ballSize`).
    pub fn ball_size(&self) -> f64 {
        self.ball.size()
    }

    /// Tell the host how big the ball is drawn, and resize its window if one is up.
    ///
    /// [`Self::set_character_size`]'s shape, one window over. What is *not* here is a move, and that
    /// is a decision rather than an omission: the ball's default corner is computed from its size when
    /// the window is created ([`super::ball::Ball::ensure`]), and a resize keeps the window's top-left
    /// because a host cannot move a window on Wayland at all — position is the compositor's, which is
    /// the same reason the drag is `start_dragging` rather than a stream of positions. A ball standing
    /// at that corner therefore grows toward the screen's interior and, at the top of its range, can
    /// reach past the work area's right edge; dragging it back is one gesture, and the alternative
    /// would be this process guessing at a position it cannot read. Reported rather than papered over:
    /// §7.2's `position-restore` row is `unverified` for the same reason and nothing here changes it.
    pub fn set_ball_size(&mut self, size: f64) -> Result<(), HostRefusal> {
        self.ball.set_size(&mut *self.surfaces, size)
    }

    /// Bring the ball's window up if the user wants one and it is not up yet.
    ///
    /// The half [`Self::set_ball_enabled`] deliberately leaves out, and it is a call of its own
    /// because of the state the pair exists for: with the character window switched off, the ball
    /// is the *only* window, so nothing else in this host would ask for it. {@link Ball::ensure}
    /// reads the switch, so this is idempotent and safe to call after {@link Self::open} has
    /// already tried — an already-open ball returns without asking the compositor again.
    pub fn ensure_ball(&mut self) -> Result<(), HostRefusal> {
        self.ball
            .ensure(&mut *self.surfaces, self.style, self.visible)
    }

    /// Create the window for a character, or return the one already showing it (§7.1's 按需创建).
    ///
    /// Idempotent per character because the caller is a settings change: upstream's
    /// `sync_project_windows` (`:270-305`) guarded its spawn with
    /// `get_webview_window(&label).is_some()` for the same reason, and a second window per
    /// character is what having no guard costs.
    ///
    /// **It also brings up the ball**, and that is a decision rather than a side effect: this is
    /// the call the enable switch makes, and the pet's two surfaces appear and disappear with that
    /// switch — the ball is on by default upstream (`read_ball_visible`'s `unwrap_or(true)`,
    /// `:334-339`) and this build's `general.ball` holds the same default. It is `Ball::ensure` that
    /// reads that switch, so a user who wants the character and not the ball gets exactly that. A
    /// ball that would not open fails this call rather than being logged and forgotten, because the
    /// window the *caller* asked for did not come up either; the refusal names the action, and the
    /// next enable (or character pick) retries, since the ball is only recorded once it opened.
    pub fn open(&mut self, character_id: &str) -> Result<PetInstance, HostRefusal> {
        self.ball
            .ensure(&mut *self.surfaces, self.style, self.visible)?;
        if let Some(existing) = self
            .instances
            .iter()
            .find(|instance| instance.character_id == character_id)
        {
            return Ok(existing.clone());
        }
        if self.instances.len() >= self.cap {
            return Err(HostRefusal::CapReached {
                cap: self.cap,
                open: self.instances.len(),
            });
        }

        self.generation = self.generation.saturating_add(1);
        let label = PetWindowLabel::mint(self.generation);
        let at = self.cascade();
        self.surfaces
            .open(
                &label,
                DESKTOP_PET_PAGE,
                at,
                character_window_size(self.character_size),
                self.style,
                self.visible,
            )
            .map_err(|detail| HostRefusal::Window {
                action: WindowAction::Open,
                detail,
            })?;

        let instance = PetInstance {
            id: self.generation,
            label,
            character_id: character_id.to_string(),
        };
        self.instances.push(instance.clone());
        Ok(instance)
    }

    /// Close the window that is asking, and only that one.
    ///
    /// No parameter names a window — see this file's header — so the only thing a caller can
    /// close is the window the windowing system says it is. §7.1's 「前端不能自选任意 label 去关闭
    /// 主窗口」 is therefore not an extra check that could be omitted: there is no argument to pass.
    pub fn close_own(&mut self, caller: &CallerWindow) -> Result<Closed, HostRefusal> {
        let instance = self.authorized(caller)?.clone();
        self.surfaces
            .close(&instance.label)
            .map_err(|detail| HostRefusal::Window {
                action: WindowAction::Close,
                detail,
            })?;
        self.instances.retain(|open| open.label != instance.label);
        Ok(Closed {
            label: instance.label,
            character_id: instance.character_id,
        })
    }

    /// Stop drawing every pet window, without giving up what a hidden pet still owes the user
    /// (§7.1: 「隐藏时停止动画绘制但保留后端提醒」).
    ///
    /// Hide is not disable: the instances stay, the subscriptions stay, and the next
    /// `set_visible(true)` — from the settings page, which is the way back on a desktop with no
    /// tray (§7.1) — shows the same pet again. A teardown here would make the difference between
    /// "not now" and "never" a matter of which button the user found.
    pub fn set_visible(&mut self, visible: bool) -> Result<(), HostRefusal> {
        let labels: Vec<PetWindowLabel> = self
            .instances
            .iter()
            .map(|open| open.label.clone())
            .collect();
        for label in &labels {
            self.surfaces
                .set_visible(label, visible)
                .map_err(|detail| HostRefusal::Window {
                    action: if visible {
                        WindowAction::Show
                    } else {
                        WindowAction::Hide
                    },
                    detail,
                })?;
        }
        // The ball is shown and hidden with the rest, and a ball that is not open is not an error:
        // its own switch may be off, or the compositor may have refused it.
        self.ball.set_visible(&mut *self.surfaces, visible)?;
        self.visible = visible;
        Ok(())
    }

    /// Whether clicks that land on this window reach the pet or pass through to what is below it.
    ///
    /// Identity-checked like {@link Self::close_own}, and for the same reason: it is a property
    /// of the caller's own window, and a window that could set it on another window could make a
    /// different one stop receiving input.
    pub fn set_click_through(
        &mut self,
        caller: &CallerWindow,
        ignore: bool,
    ) -> Result<(), HostRefusal> {
        let label = self.authorized(caller)?.label.clone();
        self.surfaces
            .set_click_through(&label, ignore)
            .map_err(|detail| HostRefusal::Window {
                action: WindowAction::ClickThrough,
                detail,
            })
    }

    /// The feature switch going off: every window closes, and the report says which.
    ///
    /// What it does not do is the point of {@link TeardownReport}. Animation timers and listeners
    /// belong to the window's own renderer and stop when it goes; agent runs, note saves and the
    /// settings pages are not this module's to touch, and characters, care progress and history
    /// are not deleted here or anywhere else (§4's rollback is the switch).
    ///
    /// **The ball closes here too, and its success is not in `closed`.** That list is a list of
    /// *character* windows — every entry carries the `character_id` it was showing — and the ball
    /// shows none, so an entry for it would have to invent one. What a caller loses is nothing it
    /// can act on: the ball's failure to close *is* reported (`failed` carries the action and the
    /// compositor's words, which need no character), and the success is visible in the state that
    /// follows — the same way every other closed window's is.
    ///
    /// **The ball goes first**, and that is an order a caller can see in the compositor's own log:
    /// it is not one of the cascade, so taking it down before walking the character windows keeps
    /// that walk a loop over `instances` alone.
    pub fn disable(&mut self) -> TeardownReport {
        let mut report = TeardownReport::default();
        if let Err(refusal) = self.ball.close(&mut *self.surfaces) {
            // Still a window, and the same rule as below: it stays so the next teardown can try
            // again rather than being forgotten while the compositor still holds it.
            report.failed.push(refusal);
        }
        let characters = self.close_characters();
        report.closed.extend(characters.closed);
        report.failed.extend(characters.failed);
        report
    }

    /// Close every character window, and report which — the half of {@link Self::disable} that is
    /// §5.1's 显示角色窗口 going off rather than the feature going off.
    ///
    /// A window the compositor would not close stays in the registry and is reported in `failed`,
    /// for the reason `disable` gives: forgetting it here would leak the very thing this call
    /// exists to clean up. The ball is deliberately not touched — it is a window with a switch of
    /// its own, and a character switch that took it down would be the master switch wearing a
    /// narrower name.
    pub fn close_characters(&mut self) -> TeardownReport {
        let mut report = TeardownReport::default();
        for instance in std::mem::take(&mut self.instances) {
            match self.surfaces.close(&instance.label) {
                Ok(()) => report.closed.push(Closed {
                    label: instance.label,
                    character_id: instance.character_id,
                }),
                Err(detail) => {
                    report.failed.push(HostRefusal::Window {
                        action: WindowAction::Close,
                        detail,
                    });
                    // Still a window: forgetting it here would leak the very thing this call
                    // exists to clean up, so it stays and the next teardown tries again.
                    self.instances.push(instance);
                }
            }
        }
        report
    }

    /// The instance that the caller *is*, or a refusal.
    ///
    /// One lookup feeds every identity-checked operation, so a new operation cannot be added
    /// without passing through it.
    fn authorized(&self, caller: &CallerWindow) -> Result<&PetInstance, HostRefusal> {
        self.instances
            .iter()
            .find(|instance| instance.label.as_str() == caller.label())
            .ok_or_else(|| HostRefusal::UnrecognizedCaller {
                observed: caller.label().to_string(),
            })
    }
}
