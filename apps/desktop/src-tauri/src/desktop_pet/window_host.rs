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
 * here until it had a switch of its own to hold; this file keeps the one `PetSurfaces`, the
 * instances, the rules about them, and the two window *sizes* the two surfaces are built at
 * ([`character_window_size`], and `ball::ball_window_size` for the ball).
 */
use serde::Serialize;
mod selection;

use super::ball::Ball;
use super::settings::{PetSettingsDomain, PetSettingsStore};
// The ball's policy moved to `ball.rs`; the path it was read by does not move with it. Every caller
// that named `window_host::BALL_LABEL` — the command surface's tests among them — still resolves,
// which is the property `state.rs` states for its own split: the split moved the code, not the
// surface. `BALL_WINDOW_SIZE` is gone rather than re-exported: a window size is a function of
// `general.ballSize` now (`ball::ball_window_size`), and a constant here would be the second answer
// the setting exists to end.
pub use super::ball::{
    ball_window_size, BALL_DEFAULT_SIZE, BALL_LABEL, BALL_MARGIN, DESKTOP_PET_BALL_PAGE,
};

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
///
/// The *default* presentation: what a pet window is opened with until a stored preference says
/// otherwise, and what every flag but one stays for the life of the process. `always_on_top` is the
/// one that is also a setting (§5.2's 窗口行为, `view.alwaysOnTop`), so the host holds the value and
/// this constant is where it starts — a host with no readable record opens exactly what upstream
/// opened.
pub const PET_WINDOW_STYLE: WindowStyle = WindowStyle {
    transparent: true,
    decorations: false,
    always_on_top: true,
    skip_taskbar: true,
    resizable: false,
    shadow: false,
    focused: false,
};

/// Whether the pet's windows are kept above ordinary ones, as the `view` record holds it.
///
/// The one flag of [`PET_WINDOW_STYLE`] that is a stored preference (§5.2's 窗口行为), so this is
/// where a host that has a store asks what to open with. Read once, at the two moments a window can
/// appear — the launch (`feature_switch::restore`) and an applied `view` write
/// (`desktop_pet_surface::apply_window_style`) — because the host holds the answer in between and a
/// per-`open` file read would be a read per window for a value that only ever changes through one.
///
/// Every arm but a readable `false` answers `true`, which is what upstream asked for at all four of
/// its builder sites (`lib.rs:295,368,463,557`): an absent record is a fresh install, an unreadable
/// one is this build's defaults everywhere else, and §10.2's read-only arm is a record whose
/// *choice* this build cannot read — and taking a pet out of the top of the stack on a guess is the
/// direction that hides the pet the user asked for.
pub fn stored_always_on_top(store: &PetSettingsStore) -> bool {
    store
        .read(PetSettingsDomain::View)
        .record()
        .and_then(|record| {
            record
                .value("alwaysOnTop")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(PET_WINDOW_STYLE.always_on_top)
}

/// The size the character window is built for, as the `character` record holds it (§5.1's 角色与动画).
///
/// The same shape as [`stored_always_on_top`] and for the same reason: it is a stored preference the
/// *window's own geometry* depends on, so the host has to be told it before it opens one, and the two
/// moments it can change are a launch and an applied write. Read once at each rather than per window:
/// a file read per `open` would be a read for a value that only changes through one command.
///
/// Every arm but a readable number answers [`CHARACTER_DEFAULT_SIZE`] — an absent record is a fresh
/// install, and an unreadable one is this build's defaults everywhere else, which is the reading
/// `settings::values` gives it too. §10.2's read-only arm is a record whose *choice* this build cannot
/// read, and the default is the direction that does not clip a sprite it cannot measure.
pub fn stored_character_size(store: &PetSettingsStore) -> f64 {
    store
        .read(PetSettingsDomain::Character)
        .record()
        .and_then(|record| record.value("size").and_then(serde_json::Value::as_f64))
        .unwrap_or(CHARACTER_DEFAULT_SIZE)
}

/// The floating ball's diameter, as the `general` record holds it (`general.ballSize`).
///
/// Beside [`stored_character_size`] rather than in `ball.rs`, because it is the same fact about the
/// same question — what size is a window built at — and because two of the three callers are here and
/// in `character_view` (the ball's page is told the same number through the appearance read, so that
/// one stored value sizes both the orb and the window around it).
///
/// Every arm but a readable number answers `ball::BALL_DEFAULT_SIZE`. The `general` domain is read
/// once for both of the ball's facts, and a read-only record — a newer build's — is the arm where a
/// choice exists and cannot be read: the schema's default is what this build's ball has always been.
///
/// The reading itself is `character_view::BallSize`'s, because the *page* needs the same number
/// through the appearance read and two readers of one field is how a window and an orb come to
/// disagree. What is here is the store half of it, beside the character's size for the same reason.
pub fn stored_ball_size(store: &PetSettingsStore) -> f64 {
    store
        .read(PetSettingsDomain::General)
        .record()
        .map_or(
            super::character_view::BallSize::DEFAULT,
            super::character_view::BallSize::of,
        )
        .value()
}

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
    /// host's to make, and a fixed name is no exception — `ball.rs` holds the label, but it is
    /// handed one rather than making one. A generation could not collide with it — `mint` formats a
    /// number, this is a word — so a character window can never inherit it.
    pub(super) fn ball() -> Self {
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
    /// Changing which stack a window sits in (`view.alwaysOnTop`). A window operation and not a
    /// settings one: the setting is stored whether or not it can be delivered, and this is what a
    /// compositor refusing the change is reported under.
    AlwaysOnTop,
    /// Giving an open window a new size (`character.size`, `general.ballSize`). The same shape as
    /// [`Self::AlwaysOnTop`]: the setting is stored whether or not the compositor honours it, and
    /// §7.2's 「asked for」 is what a refusal here means.
    Resize,
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
    /// surfaces of two sizes — a character window that follows `character.size` and a ball that
    /// follows `general.ballSize` — and an adapter that picked one of them itself would be the place
    /// the two could be swapped without a test noticing.
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

    /// Give an existing window a new size, keeping its position.
    ///
    /// A separate call rather than a close-and-reopen, for the reason [`Self::set_always_on_top`] is
    /// one: the size setting is about the pet that is *on screen*, and reopening it would reload the
    /// page — the sprite, the bubble and the open menu — every time a slider moved. Three settings
    /// reach it: `character.size` for the character's window, and `general.ballSize` for the ball's.
    ///
    /// **The position is not this call's business.** The compositor keeps the window where it is and
    /// moves only the edges, which is what a user dragging the size slider expects — and for the ball
    /// it is also what keeps a position the user dragged it to. What a *new* window is placed at is
    /// [`PetWindowHost::open`]'s and [`super::ball::Ball::ensure`]'s, and those read the size.
    fn resize(&mut self, label: &PetWindowLabel, size: (f64, f64)) -> Result<(), String>;

    fn set_visible(&mut self, label: &PetWindowLabel, visible: bool) -> Result<(), String>;

    /// Put this window in the always-on-top stack, or take it out (§5.2's `view.alwaysOnTop`).
    ///
    /// A separate call rather than a re-open: the setting changes what an *existing* window is, and
    /// a surface that could only be asked at creation would make the checkbox a preference about the
    /// next pet rather than about the one on screen. What a compositor does with it is its own
    /// business, which is why §7.2's 「置顶」 row exists at all.
    fn set_always_on_top(&mut self, label: &PetWindowLabel, on_top: bool) -> Result<(), String>;

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

    fn resize(&mut self, label: &PetWindowLabel, size: (f64, f64)) -> Result<(), String> {
        use tauri::{LogicalSize, Size};
        // Logical and not physical, which is what the size the host computes is: `inner_size` at
        // creation takes the same unit, so a window opened at 260x320 and then resized to its own
        // size again is the same window on a HiDPI display as on a 1:1 one.
        self.window(label)?
            .set_size(Size::Logical(LogicalSize::new(size.0, size.1)))
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

    fn set_always_on_top(&mut self, label: &PetWindowLabel, on_top: bool) -> Result<(), String> {
        // `tao` sends this to the windowing system as a keep-above request (`WindowRequest::
        // AlwaysOnTop` → `set_keep_above`), so on a session whose compositor ignores it this
        // succeeds and changes nothing — which is exactly the state §7.2's 「置顶」 row describes
        // and why the setting is offered only where that row has been verified.
        self.window(label)?
            .set_always_on_top(on_top)
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
