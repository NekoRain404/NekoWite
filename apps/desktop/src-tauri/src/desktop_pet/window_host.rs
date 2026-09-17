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
 *   give it the editor's whole surface.
 * - **It is not an instance, so the two per-window operations refuse it.** {@link
 *   PetWindowHost::close_own} and {@link PetWindowHost::set_click_through} resolve their caller
 *   through {@link PetWindowHost::authorized}, which looks the label up in `instances` — where the
 *   ball is not. A ball window that asked to be click-through is refused by name
 *   (`UnrecognizedCaller { observed: "pet-ball" }`), which is the structural half of 「the ball is
 *   a stable click target and must not be click-through」: the permission is granted to the pet's
 *   windows as a group, and the identity check is what keeps the ball from using it.
 * - **It follows the pet's switch, not the character list.** {@link PetWindowHost::open} — the
 *   call `apply_feature_switch` makes when `general.enabled` is written true — opens it, {@link
 *   PetWindowHost::set_visible} hides and shows it with the rest, and {@link
 *   PetWindowHost::disable} closes it. The ball has no switch of its own yet: upstream's is a
 *   stored flag defaulting to on (`lib.rs:331-345`), plan §5.1/§5.2 put 悬浮球 on the settings
 *   page's 常规与交互 row, and that page's `general` domain has no such field today.
 */
use serde::Serialize;

/// §7.1's numbers: 「建议默认最多 3 个、可配置硬上限 5 个，需性能验证后确认」.
///
/// The plan's, not measured ones. The ceiling is a clamp here rather than a constant each caller
/// restates, so "the user asked for 50 characters" cannot reach a window system as 50.
pub const DEFAULT_CHARACTER_CAP: usize = 3;
pub const HARD_CHARACTER_CAP: usize = 5;

/// The label prefix every pet window carries. Upstream's `is_pet_window` (`:42-43`) matched
/// `"pet"` and `"pet-"`; one string here so that "is this ours" has one answer.
const LABEL_PREFIX: &str = "pet";

/// The page the pet's windows load. `apps/desktop/desktop-pet.html` is the lightweight entry
/// (§9); its second Vite entry is the integrator's wiring point, so this names the built page.
pub const DESKTOP_PET_PAGE: &str = "desktop-pet.html";

/// The character window's size in logical px: upstream's `260x320` (`:459`), the same at all
/// four of its builder sites.
pub const CHARACTER_WINDOW_SIZE: (f64, f64) = (260.0, 320.0);

/// The floating ball's window label. Fixed, and not a generation: there is one ball (upstream's
/// `FLOATING_BALL_LABEL`, `:310`), so there is nothing for a generation to distinguish it from.
///
/// It carries {@link LABEL_PREFIX} on purpose. `capabilities/desktop-pet.json` selects its windows
/// by the glob `pet-*`, and a label outside it would be a window with no capability at all — see
/// this file's header.
pub const BALL_LABEL: &str = "pet-ball";

/// The ball's page. The second light entry (§9), beside `desktop-pet.html`: the ball is a different
/// surface from the character window (it is a launcher that stays where it is put, while the
/// character roams) and it must not be click-through, so it is not the character window's page and
/// not the character window's bundle.
pub const DESKTOP_PET_BALL_PAGE: &str = "desktop-pet-ball.html";

/// The ball window's size in logical px: upstream's `BALL_W`/`BALL_H` (`:312-314`) — an 80 px
/// square for a 56 px orb, so the orb's shadow and its hover scale are not clipped by the window's
/// own edges.
pub const BALL_WINDOW_SIZE: (f64, f64) = (80.0, 80.0);

/// Where a ball with no readable screen is placed, and the margins upstream used for its default
/// corner (`:357`: `(sw - BALL_W - 24, sh - BALL_H - 80)` — the wider bottom gap is where a
/// taskbar or a dock usually is).
const BALL_MARGIN_X: f64 = 24.0;
const BALL_MARGIN_Y: f64 = 80.0;

/// What we ask a compositor for, as a value rather than as calls buried in an adapter.
///
/// Every field is a §7.2 row — 透明、无边框、置顶、不抢焦点 — and upstream set the same seven flags
/// at each of its four `WebviewWindowBuilder` sites (`:289-296`, `:358-370`, `:457-467`,
/// `:552-559`), which is how `spawn_extra_pet` and `sync_project_windows` came to differ in
/// nothing but their position. Keeping it a value means what the app requests is one thing, and
/// `TauriSurfaces` is the only place it becomes builder calls.
///
/// None of it is a claim that the request is honoured. Whether a compositor applies any of these
/// is `linux_capabilities`' business, and today it answers `unverified` for all seven.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowStyle {
    pub transparent: bool,
    pub decorations: bool,
    pub always_on_top: bool,
    pub skip_taskbar: bool,
    pub resizable: bool,
    pub shadow: bool,
    pub focused: bool,
}

/// Upstream's flags together (`:461-469`), once.
pub const PET_WINDOW_STYLE: WindowStyle = WindowStyle {
    transparent: true,
    decorations: false,
    always_on_top: true,
    skip_taskbar: true,
    resizable: false,
    shadow: false,
    focused: false,
};

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

/// A window label this host minted.
///
/// The inner string is private and there is no public constructor, which is the whole of §7.1's
/// 「前端不能自选任意 label」: a front end that could build one of these could name the main
/// window, and a check on a string is something a later edit can drop without the type changing.
/// Everything the host does with a label, it first made itself.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(transparent)]
pub struct PetWindowLabel(String);

impl PetWindowLabel {
    fn mint(generation: u32) -> Self {
        Self(format!("{LABEL_PREFIX}-{generation}"))
    }

    /// The ball's label, and the one label here that is not minted from a generation.
    ///
    /// Still built here and nowhere else: the point of the private field is that a label is the
    /// host's to make, and a fixed name is no exception. A generation could not collide with it —
    /// `mint` formats a number, this is a word — so a character window can never inherit it.
    fn ball() -> Self {
        Self(BALL_LABEL.to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The window that issued an IPC call, as the windowing system reported it.
///
/// `from_window_label` is the only constructor, and its only intended caller is the
/// `#[tauri::command]` shim (T4's/integrator's file), which Tauri hands a `WebviewWindow` and
/// which reads `label()` off that. A value from a request body never reaches this type, which is
/// the difference between a caller that is identified and one that names itself.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CallerWindow(String);

impl CallerWindow {
    pub fn from_window_label(label: impl Into<String>) -> Self {
        Self(label.into())
    }

    pub fn label(&self) -> &str {
        &self.0
    }
}

/// Which window operation failed, so a refusal reads as a sentence rather than as "it broke".
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowAction {
    Open,
    Close,
    Show,
    Hide,
    ClickThrough,
}

/// Why the host refused.
///
/// `UnrecognizedCaller` carries the label it saw rather than being a unit, because the two cases
/// that reach it — the main window, and a label from a pet window that has since closed — are
/// told apart by exactly that string, and a refusal that names what it refused is the difference
/// between a diagnosable report and "the pet stopped working".
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(tag = "reason", rename_all = "kebab-case")]
pub enum HostRefusal {
    UnrecognizedCaller {
        observed: String,
    },
    CapReached {
        cap: usize,
        open: usize,
    },
    Window {
        action: WindowAction,
        detail: String,
    },
}

/// The windowing system, as much of it as the host uses.
///
/// A port rather than a set of calls, so the rules — the cap, the labels, who may close what —
/// can be tested against something that is not a compositor, and so {@link PetWindowHost} needs
/// no window to run. {@link TauriSurfaces} is the real one and is deliberately thin.
pub trait PetSurfaces: Send {
    /// Create one window: its identity, its page, where it goes, how big it is, what it is, and
    /// whether it starts on screen.
    ///
    /// The size is a parameter rather than something the adapter reads, because the pet has two
    /// surfaces of two different sizes — a 260x320 character window and an 80x80 ball — and an
    /// adapter that picked one of them itself would be the place the two could be swapped without
    /// a test noticing.
    fn open(
        &mut self,
        label: &PetWindowLabel,
        page: &str,
        at: Placement,
        size: (f64, f64),
        style: WindowStyle,
        visible: bool,
    ) -> Result<(), String>;

    fn close(&mut self, label: &PetWindowLabel) -> Result<(), String>;

    fn set_visible(&mut self, label: &PetWindowLabel, visible: bool) -> Result<(), String>;

    /// §7.2's 鼠标穿透, system half: whether the compositor sends this window the clicks that
    /// land on it. Deliberately *not* the same claim as knowing which pixels of the sprite are
    /// opaque — that is the renderer's hit test, and §7.2 forbids presenting one as the other.
    fn set_click_through(&mut self, label: &PetWindowLabel, ignore: bool) -> Result<(), String>;

    /// The primary monitor's work area, logical px; `None` when it cannot be read.
    ///
    /// Returning an option rather than a size is §7.2's rule about substitution: upstream
    /// `unwrap_or((1920.0, 1080.0))`-ed an unreadable monitor (`:194`) and could therefore park
    /// the pet off-screen on exactly the display it failed to read.
    fn work_area(&self) -> Option<WorkArea>;
}

/// One character window.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetInstance {
    /// Host-assigned, and the only identifier a caller ever sees.
    pub id: u32,
    pub label: PetWindowLabel,
    pub character_id: String,
}

/// What one close did.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Closed {
    pub label: PetWindowLabel,
    pub character_id: String,
}

/// What tearing the pet down did.
///
/// Both fields describe a *window*, which is the claim (§7.1: 「禁用桌宠销毁动画/监听/计时器，不
/// 取消后台 Agent 任务」; §4: 「关闭不影响 Agent 工作、笔记保存与原设置页」 and 「不删除已导入的
/// 角色与养成数据」). There is nowhere in this type to record a cancelled run, a deleted character
/// or a cleared ledger, and nowhere in this module to obtain one: the alternatives are not merely
/// unhandled, they are unrepresentable. `failed` exists so that a window the compositor would not
/// close is neither swallowed nor mistaken for a success — it stays in the registry and a later
/// teardown retries it.
#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeardownReport {
    pub closed: Vec<Closed>,
    pub failed: Vec<HostRefusal>,
}

/// The character windows, and the rules about them.
pub struct PetWindowHost {
    surfaces: Box<dyn PetSurfaces>,
    cap: usize,
    /// Only rises. See this file's header: a reused label is an alias onto a live window's
    /// identity, and a caller left over from a closed window would otherwise be believed.
    generation: u32,
    instances: Vec<PetInstance>,
    /// The ball's window, when it has one. Deliberately *not* an entry in `instances`: the two
    /// types of window differ in what they hold (a character, or none), in what the cap counts,
    /// and in whether a per-window operation may be aimed at them — see this file's header.
    ball: Option<PetWindowLabel>,
    visible: bool,
}

impl PetWindowHost {
    pub fn new(surfaces: Box<dyn PetSurfaces>) -> Self {
        Self {
            surfaces,
            cap: DEFAULT_CHARACTER_CAP,
            generation: 0,
            instances: Vec::new(),
            ball: None,
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
        self.ball.as_ref()
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
    /// `:334-339`) and its own switch does not exist in this build yet. A ball that would not open
    /// fails this call rather than being logged and forgotten, because the window the *caller*
    /// asked for did not come up either; the refusal names the action, and the next enable (or
    /// character pick) retries, since the ball is only recorded once it opened.
    pub fn open(&mut self, character_id: &str) -> Result<PetInstance, HostRefusal> {
        self.ensure_ball()?;
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
                CHARACTER_WINDOW_SIZE,
                PET_WINDOW_STYLE,
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
            .chain(self.ball.clone())
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
    pub fn disable(&mut self) -> TeardownReport {
        let mut report = TeardownReport::default();
        if let Some(label) = self.ball.take() {
            if let Err(detail) = self.surfaces.close(&label) {
                report.failed.push(HostRefusal::Window {
                    action: WindowAction::Close,
                    detail,
                });
                // Still a window, and the same rule as below: it stays so the next teardown can
                // try again rather than being forgotten while the compositor still holds it.
                self.ball = Some(label);
            }
        }
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

    /// Open the ball's window if the pet does not have one yet, and record it once it opened.
    ///
    /// Idempotent, and recorded *after* the call succeeds: a compositor that refused it leaves
    /// this host believing it has no ball, so the next enable asks again instead of reporting a
    /// window that is not there.
    fn ensure_ball(&mut self) -> Result<(), HostRefusal> {
        if self.ball.is_some() {
            return Ok(());
        }
        let label = PetWindowLabel::ball();
        self.surfaces
            .open(
                &label,
                DESKTOP_PET_BALL_PAGE,
                self.ball_position(),
                BALL_WINDOW_SIZE,
                PET_WINDOW_STYLE,
                self.visible,
            )
            .map_err(|detail| HostRefusal::Window {
                action: WindowAction::Open,
                detail,
            })?;
        self.ball = Some(label);
        Ok(())
    }

    /// Where the ball goes: upstream's default corner, and never off the screen.
    ///
    /// Upstream *restored* a dragged position from a file and clamped it, defaulting to the
    /// bottom-right (`:350-358`). There is no stored position here because nothing can move the
    /// ball yet — drag needs a window permission the pet's capability deliberately does not hold
    /// and snap needs a command that does not exist — so this is the default, and a stored
    /// position arrives with whatever gives the ball its drag. An unreadable work area is not
    /// substituted with a guessed screen (§7.2): the ball goes to the margins and the compositor
    /// has the last word, the rule {@link Self::cascade} already follows.
    fn ball_position(&self) -> Placement {
        let (width, height) = BALL_WINDOW_SIZE;
        let Some(area) = self.surfaces.work_area() else {
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

    /// Where a new window goes: upstream's cascade (`:281-292`), stepped by index so several
    /// characters do not land on one pixel, clamped inside the work area.
    ///
    /// Upstream read the monitor's `size()` (`:185-190`), which includes the taskbar, so its
    /// clamp could park a window under it; the work area is the same screen without the strip
    /// reserved for it. An unreadable screen is not substituted with a guessed one — §7.2's rule
    /// — so the window is placed at the margin and the compositor has the last word.
    fn cascade(&self) -> Placement {
        const STEP: f64 = 40.0;
        const MARGIN: f64 = 20.0;
        let (width, height) = CHARACTER_WINDOW_SIZE;
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

/// The real windowing system.
///
/// Everything left here is translation: §7.1's rules are in {@link PetWindowHost}, and what
/// remains is turning {@link PET_WINDOW_STYLE} and a {@link Placement} into builder calls. The
/// flags are read from the value rather than written twice, so the window the app asks for and
/// the one a test asserts about cannot drift apart.
pub struct TauriSurfaces {
    app: tauri::AppHandle,
}

impl TauriSurfaces {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    fn window(&self, label: &PetWindowLabel) -> Result<tauri::WebviewWindow, String> {
        use tauri::Manager;
        self.app
            .get_webview_window(label.as_str())
            .ok_or_else(|| format!("no pet window labelled {}", label.as_str()))
    }
}

impl PetSurfaces for TauriSurfaces {
    fn open(
        &mut self,
        label: &PetWindowLabel,
        page: &str,
        at: Placement,
        size: (f64, f64),
        style: WindowStyle,
        visible: bool,
    ) -> Result<(), String> {
        use tauri::{WebviewUrl, WebviewWindowBuilder};
        let (width, height) = size;
        WebviewWindowBuilder::new(&self.app, label.as_str(), WebviewUrl::App(page.into()))
            .title("NekoWite")
            .inner_size(width, height)
            .position(at.x, at.y)
            .transparent(style.transparent)
            .decorations(style.decorations)
            .always_on_top(style.always_on_top)
            .skip_taskbar(style.skip_taskbar)
            .resizable(style.resizable)
            .shadow(style.shadow)
            .focused(style.focused)
            .visible(visible)
            .build()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn close(&mut self, label: &PetWindowLabel) -> Result<(), String> {
        self.window(label)?
            .close()
            .map_err(|error| error.to_string())
    }

    fn set_visible(&mut self, label: &PetWindowLabel, visible: bool) -> Result<(), String> {
        let window = self.window(label)?;
        if visible {
            window.show()
        } else {
            window.hide()
        }
        .map_err(|error| error.to_string())
    }

    fn set_click_through(&mut self, label: &PetWindowLabel, ignore: bool) -> Result<(), String> {
        self.window(label)?
            .set_ignore_cursor_events(ignore)
            .map_err(|error| error.to_string())
    }

    fn work_area(&self) -> Option<WorkArea> {
        let monitor = self.app.primary_monitor().ok().flatten()?;
        let area = monitor.work_area();
        // A zero scale factor would divide by zero, and a monitor that reports one is a monitor
        // whose geometry cannot be used at all rather than one that is 1:1.
        let scale = monitor.scale_factor();
        if !(scale > 0.0) {
            return None;
        }
        Some(WorkArea {
            x: area.position.x as f64 / scale,
            y: area.position.y as f64 / scale,
            width: area.size.width as f64 / scale,
            height: area.size.height as f64 / scale,
        })
    }
}
