//! The pet's IPC surface: the commands a window may call, and the one place a caller's identity
//! is read.
//!
//! §7.1 puts two rules on this file, and both are about *this* layer rather than the one below
//! it:
//!
//! - 「前端不能自选任意 label 去关闭主窗口」 — a front end chooses no window. Two commands here take
//!   a `tauri::WebviewWindow`, and their first act is `CallerWindow::from_window_label` on the
//!   label the *windowing system* reports for the caller. No command in this file has a
//!   parameter that names a window, so there is nothing to forge: a request body cannot say who
//!   it is, and `PetWindowHost` offers no operation that accepts a label either.
//! - 「仅限制前端按钮或只写 capabilities 文件不能替代自定义命令授权检查」 — the capability file
//!   (`capabilities/desktop-pet.json`) says which *plugin* permissions a pet window has; it says
//!   nothing about these commands, because app commands are not ACL-gated at all (Tauri checks
//!   the ACL for app commands only when the app defines its own permission manifest, which this
//!   app does not). The authorization for every privileged operation is therefore the check
//!   *here* and in `window_host::PetWindowHost::authorized`, and the capability file is the
//!   second, independent layer rather than the only one.
//!
//! **The settings half is `desktop_pet_surface.rs`; what stays here is the pet's own life.** The
//! split is by the rule each half has to be true of. A window operation is authorised *here* — a
//! caller names no window, and the label a request is judged by is the one the windowing system
//! reports — while a settings write is a *record with a revision*: §5.3's four load arms, a
//! submission applied or refused at the revision it was read, and a refusal that names a code
//! instead of rejecting the caller's draft. So [`desktop_pet_read_settings`],
//! [`desktop_pet_update_settings`] and the two appliers an applied write reaches live there, and
//! are re-exported from this path so that `lib.rs`'s handler list, `build.rs`'s `COMMANDS` and the
//! test targets that import `commands::desktop_pet::{...}` name the same commands they always did.
//! Adding a domain, a schema version or a migration touches that file and not this one; adding a
//! window operation touches this one and not that.
//!
//! What is left here is the pet as it is running: its windows and the feature switch (§7.1, §4),
//! what this machine was verified to do (§7.2), what the ledger settled (§8), the character it
//! draws and the task list the runtime's own frames feed (§5.1, §6), and the two links that raise
//! the main window (§5.1, §6.2). [`desktop_pet_care_read`] and [`desktop_pet_tasks`] both answer
//! from state this process already holds, and neither invents a first payload for a window whose
//! subscription is listen-then-read: a host that cannot answer states a refusal rather than
//! leaving a window with a quiet subscription it cannot tell from a pet that has no work.
//!
//! Registering a handler is `lib.rs`'s line and not this file's: every command here and in
//! `desktop_pet_surface.rs` is in that handler list and in `build.rs`'s `COMMANDS`, and a command
//! added to either file is reported to whoever owns those two lists rather than appended to them
//! from here.
//!
//! **Wording.** The refusals below are sentences rather than codes for the reason
//! `commands/agent.rs` gives: they reach the user with no form and no mapper in between.
//!
//! **Why these commands are generic over the runtime**, unlike their neighbours in this
//! directory. The checking above is the thing §7.1 asks for, and testing it means driving the
//! command from a *real* window rather than from a `CallerWindow` a test built — which is
//! `MockRuntime`, which a signature naming `tauri::AppHandle` (i.e. `AppHandle<Wry>`) cannot be
//! called with. What a test in another crate cannot do is register the library's commands, so
//! `tests/desktop_pet_ipc_test/commands.rs` registers one-line wrappers with the same parameter
//! names over these functions; `R: tauri::Runtime` is what lets the wrapper's `MockRuntime`
//! instance reach the body under test. It costs nothing at build time beyond the monomorphisation
//! the app would do anyway, and nothing in these bodies is Wry-specific — the one Wry-specific
//! thing in the pet's backend is `TauriSurfaces`, and it lives in `PetWindowHost`, not here.

use std::path::Path;

use serde::Serialize;

use crate::desktop_pet::settings::DefaultsReason;
use crate::desktop_pet::{
    AdoptionRefusal, CallerWindow, CapabilityReport, CareSummary, CharacterKind, CharacterLibrary,
    Closed, HostAppearance, HostAppearanceWrite, HostRefusal, InstallRequest, LinuxEnvironment,
    PetInstance, PetSettingsDomain, PetSettingsLoad, PetWindowHost, TeardownReport, WindowAction,
};
use crate::state::DesktopPetState;

use super::desktop_pet_surface::settings_store;

// Re-exported from `desktop_pet_surface` so that the paths naming them do not move: `lib.rs`'s
// handler list, `build.rs`'s `COMMANDS`, and the test targets importing `commands::desktop_pet::{…}`.
// A second spelling of one command is how a handler list and the command behind it drift apart.
//
// The two `__cmd__*` and `__tauri_command_name_*` names are `#[tauri::command]`'s own output, and
// they have to travel with the function: `generate_handler!` builds its path from the one written
// in `lib.rs`, renaming only the last segment, so a command that moved without them leaves that
// list failing to compile while the command itself still resolves — the one failure mode a
// re-export is supposed to prevent. They are `#[macro_export]`, which is what makes this `pub use`
// of a macro legal in the first place.
pub use super::desktop_pet_surface::{
    __cmd__desktop_pet_read_settings, __cmd__desktop_pet_update_settings,
    __tauri_command_name_desktop_pet_read_settings,
    __tauri_command_name_desktop_pet_update_settings, apply_feature_switch,
    apply_notification_switch, apply_window_style, desktop_pet_read_settings,
    desktop_pet_update_settings, PET_SETTINGS_CHANGED_CHANNEL, UNSELECTED_CHARACTER,
};

/// The channel a pet window hears a change in the feature's state on (§7.1).
///
/// It exists because of a hole D3 reported and left open: `PetGateway` has `feature()` and
/// `setVisible()`, but its only push channel carried tasks — so a hide performed from the
/// settings page reached the window on its next `feature()` call, which nothing was going to
/// make. §7.1 makes the settings page the way *back* to a hidden pet on a desktop with no tray
/// (「无托盘的 Linux 环境仍能从主设置恢复隐藏桌宠」), and a way back that only works when the
/// window happens to ask again is not one. `tauri-pet.ts` listens on this name; the two
/// spellings are one decision.
pub const PET_FEATURE_CHANNEL: &str = "pet-feature";

/// The channel a pet window's 设置 opens the main window on (§5.1).
///
/// The main window's listener is `platform/pet-settings-request.ts`, which `app/pet-settings-link.ts`
/// attaches from the shell — written, and no longer reported. The payload is a page and nothing
/// else — no section id, no window label, no URL — so the section this app opens is named once, in
/// TypeScript, by `PET_SETTINGS_SECTION`.
pub const PET_SETTINGS_CHANNEL: &str = "pet-open-settings";

/// The channel the host publishes the task list on (§6).
///
/// Declared in `desktop_pet/task_feed.rs`, where the list is published, and re-exported here
/// because this module is where a channel's *name* lives for the two sides to agree on. The window
/// that reads it is `tauri-pet.ts`'s `PET_TASKS_CHANNEL`.
pub use crate::desktop_pet::PET_TASKS_CHANNEL;

/// The channel the pet's click on a task reaches the main window on (§6.2's 点击返回任务).
///
/// The payload is D1's `PetTaskKey` and nothing else — no session URL, no path, no command. §6.3
/// requires a notification's action to be a host-issued, limited target, and the key is exactly
/// that: the main window re-validates it against the sessions it holds, and the pet cannot name
/// anything the host did not mint. Both halves of that sentence are now code rather than intent —
/// `platform/pet-task-request.ts` reads the payload and refuses what is not a key, and
/// `app/pet-task-link.ts` focuses the session only when this window is holding it.
pub const PET_TASK_OPEN_CHANNEL: &str = "pet-open-task";

/// The channel the host relays the app's own appearance on (§1's 「保留现有主题、强调色」).
///
/// The fifth channel of the same shape, and the direction is the one that matters: the *app*
/// publishes over a command (`desktop_pet_publish_host_appearance`, which is §5.3's rule that an
/// event may not be an unauthorised config write), this host holds the value, and a pet window that
/// is already mounted hears the new one here. `tauri-pet.ts` listens on this name; the two
/// spellings are one decision.
pub const PET_HOST_APPEARANCE_CHANNEL: &str = "pet-host-appearance";

/// The main window's label, as the app builds it from `tauri.conf.json`.
///
/// Spelled here rather than taken from a request for the reason the whole file is about: which
/// window the pet's 设置 raises is the host's decision, and `open_file.rs` already names this
/// label for the same purpose (a second launch raises the same window).
const MAIN_WINDOW: &str = "main";

/// §5.1's pet sub-pages, as this side validates them.
///
/// Duplicated from D1's `PET_SETTINGS_PAGES` (`pet-contracts/config.ts`) rather than trusted from
/// the request for the reason above: the value crosses a window boundary, so a string a caller
/// invented would otherwise be handed to the main window's listener as a page to open. The two
/// lists are held together by `the_page_vocabulary_is_the_typescript_one` in
/// `tests/desktop_pet_ipc_test/commands.rs`, which reads the contract off disk — a page added on
/// one side alone fails that test rather than opening nothing.
pub const SETTINGS_PAGES: [&str; 7] = [
    "general",
    "character",
    "bubble",
    "notification",
    "care",
    "project",
    "advanced",
];

/// Whether the feature is on, and whether a pet is on screen right now.
///
/// D1's `PetFeatureState` (`pet-contracts/gateway.ts:29-33`), for the reason it gives for having
/// two fields rather than one: "the feature is off" means no window, no animation and no timers
/// while "hidden" is a pet that is running with its drawing stopped — collapsing them would make
/// a temporary hide indistinguishable from a disable, and the user's way back would be the wrong
/// one.
///
/// `enabled` is answered from the host's own state — a character window exists only because the
/// enable path opened one, and [`desktop_pet_disable`] is what takes them away — and the settings
/// *are* that enable path: [`desktop_pet_update_settings`] turns an applied `general.enabled` into
/// windows through [`apply_feature_switch`], so the two agree because one is the cause of the
/// other and not because they are checked against each other. The direction that is not enforced
/// is the other one: a direct [`desktop_pet_open`] still opens a window while the switch is off,
/// because refusing it would need a refusal arm `HostRefusal` does not have. Reported rather than
/// papered over.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetFeatureState {
    pub enabled: bool,
    pub visible: bool,
}

impl PetFeatureState {
    pub(super) fn of(host: &PetWindowHost) -> Self {
        // A disabled feature has nothing to show, so `visible` is not merely "the flag is set":
        // reporting a hidden-but-enabled pet for a feature with no windows would be a state a
        // window could act on and be wrong about.
        //
        // "Something is showing" counts the ball as well as the character windows. The two are
        // separate surfaces with separate switches (§5.1), so the table can be in the state where
        // 显示角色窗口 is off and 显示悬浮球 is on — the pet is on screen and the feature is on, and a
        // state that answered `enabled: false` there would be this field disagreeing with the
        // switch it is named after. Nothing reads it in that state today (the only subscriber is a
        // *character* window, and there is none), which is why the answer has to be right rather
        // than merely harmless.
        let enabled = !host.instances().is_empty() || host.ball().is_some();
        Self {
            enabled,
            visible: enabled && host.is_visible(),
        }
    }
}

/// A settings page a pet window asked the main window to open.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsRequest {
    page: String,
}

/// What the care ledger settled, or the fact that it settled nothing (§8).
///
/// Two arms, and the second one is the whole design. A ledger nothing has settled into has totals
/// — `xp: 0`, `meals: 0`, no streak, no day — and handing those over would have the surface draw
/// level 0 and an empty bar for a user who has completed five hundred runs. That is §8's
/// 「token 未知不是 0」 one level up: `meals: 0` would read *the absence of a record* as *a record
/// of absence*, when the truth is that nothing has been recorded at all. So the totals are not
/// sent unless something settled, and the caller is told which of the two it is holding.
///
/// The arms this build cannot produce are deliberately not declared. A `read-only` arm — §10.2's
/// newer-record rule — has no producer while the ledger is the process's own: `care_ledger` may
/// not name a file (its `local.rs` test asserts that), so no record from another build can be
/// loaded for one. It arrives with whatever store gives the ledger a disk, and its absence here
/// is a statement about the build rather than a forgotten case.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PetCareRead {
    /// Something has settled: the totals, and nothing about how they got that way.
    Current { summary: CareSummary },
    /// Nothing has settled into the ledger, so there is nothing to draw.
    Empty,
}

/// The window state, or the sentence that says it could not be read.
///
/// A poisoned lock is reported rather than panicked through: a panic in a Tauri command is a
/// rejected promise on the other side with no explanation, and a lock this process poisoned once
/// is a fact the user's next click has to survive.
pub(super) fn host(
    state: &DesktopPetState,
) -> Result<std::sync::MutexGuard<'_, PetWindowHost>, String> {
    state
        .host
        .lock()
        .map_err(|_| "the pet's window state was poisoned by a panic".to_string())
}

/// The current feature state, for a window that is mounting.
#[tauri::command]
pub fn desktop_pet_state(
    state: tauri::State<'_, DesktopPetState>,
) -> Result<PetFeatureState, String> {
    let host = host(&state)?;
    Ok(PetFeatureState::of(&host))
}

/// The character windows that are open.
///
/// Read-only, and the only place a label is handed outward. That is not the rule §7.1 states —
/// a front end that can *read* a label still cannot name one in a request, and no command here
/// accepts one — but it is worth saying, because a future command that took a label would have
/// to justify itself against this.
#[tauri::command]
pub fn desktop_pet_windows(
    state: tauri::State<'_, DesktopPetState>,
) -> Result<Vec<PetInstance>, String> {
    Ok(host(&state)?.instances().to_vec())
}

/// Create the window for a character, on demand (§7.1).
///
/// The caller names a *character*, never a window: the label is minted by the host and never
/// reused, so a character that is closed and re-enabled gets a new identity rather than
/// inheriting the authority of the window that closed. A second request for a character that is
/// already showing returns the window that exists rather than opening another one.
#[tauri::command]
pub fn desktop_pet_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DesktopPetState>,
    character_id: String,
) -> Result<PetInstance, HostRefusal> {
    let (instance, feature) = {
        let mut host =
            host(&state).map_err(|detail| window_state_refusal(WindowAction::Open, detail))?;
        let instance = host.open(&character_id)?;
        (instance, PetFeatureState::of(&host))
    };
    publish_feature(&app, feature);
    Ok(instance)
}

/// The feature switch going off: every pet window closes, and the report says which (§4).
///
/// What it does not do is the point of the return type. `TeardownReport`'s fields are windows
/// and nothing else — no cancelled run, no deleted character, no cleared ledger — and a window
/// the compositor would not close stays in the registry and is reported in `failed` rather than
/// being forgotten.
#[tauri::command]
pub fn desktop_pet_disable<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DesktopPetState>,
) -> Result<TeardownReport, String> {
    let (report, feature) = {
        let mut host = host(&state)?;
        let report = host.disable();
        (report, PetFeatureState::of(&host))
    };
    publish_feature(&app, feature);
    Ok(report)
}

/// Show or hide every pet window, answering with the state the host ended up in.
///
/// It answers rather than returning nothing because that is the contract's own shape (D1): a
/// request to show a disabled feature does nothing, and the caller has to be able to tell. Hide
/// is not disable — every instance stays, the windows stay, and showing them again is this
/// command with `true` from the settings page, which §7.1 makes the way back on a desktop with
/// no tray.
#[tauri::command]
pub fn desktop_pet_set_visible<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DesktopPetState>,
    visible: bool,
) -> Result<PetFeatureState, HostRefusal> {
    let feature = {
        let mut host =
            host(&state).map_err(|detail| window_state_refusal(WindowAction::Show, detail))?;
        host.set_visible(visible)?;
        PetFeatureState::of(&host)
    };
    publish_feature(&app, feature);
    Ok(feature)
}

/// Close the window that is asking, and only that one.
///
/// The `WebviewWindow` is Tauri's, not the request's: it is the window the IPC arrived from, and
/// its label is read for the identity check. No parameter names a window, so §7.1's 「前端不能自选
/// 任意 label 去关闭主窗口」 is not an extra check that a later edit could drop — there is no
/// argument to pass, and a caller from the main window is refused by name
/// (`HostRefusal::UnrecognizedCaller { observed: "main" }`).
#[tauri::command]
pub fn desktop_pet_close_own<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DesktopPetState>,
) -> Result<Closed, HostRefusal> {
    let caller = CallerWindow::from_window_label(window.label());
    let (closed, feature) = {
        let mut host =
            host(&state).map_err(|detail| window_state_refusal(WindowAction::Close, detail))?;
        let closed = host.close_own(&caller)?;
        (closed, PetFeatureState::of(&host))
    };
    publish_feature(&app, feature);
    Ok(closed)
}

/// Whether clicks that land on the caller's own window reach the pet or pass through (§7.2).
///
/// Identity-checked like [`desktop_pet_close_own`] and for the same reason: it is a property of
/// the caller's own window, and a window that could set it on another window could make a
/// different one stop receiving input. Deliberately *not* presented as pixel hit-testing — that
/// is the renderer's business, and §7.2 forbids one standing in for the other.
#[tauri::command]
pub fn desktop_pet_set_click_through<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, DesktopPetState>,
    ignore: bool,
) -> Result<(), HostRefusal> {
    let caller = CallerWindow::from_window_label(window.label());
    let mut host =
        host(&state).map_err(|detail| window_state_refusal(WindowAction::ClickThrough, detail))?;
    host.set_click_through(&caller, ignore)
}

/// What this machine was verified to do, each finding with what happens instead (§7.2).
///
/// The environment is read here rather than stored: `XDG_CURRENT_DESKTOP` and the session type
/// are facts about the process that started, and a cached copy would survive a session the user
/// restarted into something else.
#[tauri::command]
pub fn desktop_pet_capabilities(
    state: tauri::State<'_, DesktopPetState>,
) -> Result<Vec<CapabilityReport>, String> {
    let observations = state
        .observations
        .lock()
        .map_err(|_| "the pet's capability state was poisoned by a panic".to_string())?;
    Ok(crate::desktop_pet::linux_capabilities::report(
        &LinuxEnvironment::observe(),
        &observations,
    ))
}

/// What the ledger settled, for the care page that draws it (§8).
///
/// The read is the *only* way anything outside the ledger's own settlement path reaches these
/// totals: `CareLedger::summary` returns facts, never a level, a stage or a progress bar — those
/// are `pet-care-rules.ts`'s, computed where they are drawn, so there is one level curve in the
/// build and not two.
///
/// Nothing here names a window, a caller or a character. The ledger is the process's own progress
/// (§6.3's one-ledger rule), so every window that asks gets the same answer and there is nothing
/// to address: like the window list and the capability report, this command has no parameter
/// beyond the state, and unlike them it is the only *read* whose answer a page draws numbers
/// from.
#[tauri::command]
pub fn desktop_pet_care_read(
    state: tauri::State<'_, DesktopPetState>,
) -> Result<PetCareRead, String> {
    let ledger = state
        .ledger
        .lock()
        .map_err(|_| "the pet's care ledger was poisoned by a panic".to_string())?;
    // `revision` moves when anything is decided *or* when an import lands, so zero means no
    // decision and no import: the one state in which this ledger holds no record at all. The
    // check is here rather than in the ledger because what to draw from a summary is the
    // surface's question — the ledger's own answer (`summary()`) is what it settled, which for an
    // empty ledger is accurately nothing.
    if ledger.revision() == 0 {
        return Ok(PetCareRead::Empty);
    }
    Ok(PetCareRead::Current {
        summary: ledger.summary(),
    })
}

/// What the runtime is doing, as this window may be told (§6).
///
/// D1's `PetTaskProjection` list, read from the projection D4's state machine built and this
/// process now holds (`desktop_pet/task_feed.rs`). The window's subscription is listen-then-read,
/// so this is both the answer to its first read and what it re-reads on a push — and because the
/// list is complete every time, a push that never arrived costs freshness rather than the task.
///
/// **This command had no backend until the feed landed.** Its absence was not a missing first
/// payload: `tauri-pet.ts`'s `subscribe` releases the listener when the first read rejects, so a
/// window mounted against a host that could not answer this looked exactly like a pet with no
/// work — a quiet subscription rather than a stated failure. The read is now a real one, and the
/// refusal a poisoned lock produces is the caller's to state rather than a silence.
#[tauri::command]
pub fn desktop_pet_tasks(
    state: tauri::State<'_, DesktopPetState>,
) -> Result<Vec<crate::desktop_pet::PetTaskProjection>, String> {
    state.tasks.read()
}

/// What the pet window draws, or why it draws nothing (§5.1's 角色与动画).
///
/// The whole of the window's appearance in one read: which character the `character` settings
/// domain names, where its spritesheet is, the grid to slice it on, and the domain's own values
/// (size, animation mapping, idle playlist) as the store read them. One call rather than four,
/// because the window needs them together to draw one frame, and because the sheet path must be
/// *granted* — [`allow_character_sheet`] below extends the asset protocol by exactly this file,
/// which is the rule `commands/fs.rs` settled for the vault's images: one `allow_file` per
/// resolved file, never a directory, and never a scope entry for the library.
///
/// It reads three domains, and two of them are the ones a pet window cannot read for itself:
/// `general` supplies the motion policy ([`crate::desktop_pet::Motion`]) — §5.2's 「跟随系统/应用设置」,
/// which the 常规与交互 page writes and which nothing on the desktop followed until this read carried
/// it — and `message` supplies the bubble's background alpha
/// ([`crate::desktop_pet::BubbleOpacity`]), which §5.2's 气泡与消息 writes and which the bubble in
/// this window draws with. `capabilities/desktop-pet.json` deliberately holds no
/// `desktop_pet_read_settings`, so a window that asked for a domain would be a window that could
/// read every field of the pet's settings; what it is handed instead is the two policies it draws
/// with, read here from the same store.
#[tauri::command]
pub fn desktop_pet_appearance<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<crate::desktop_pet::PetAppearance, String> {
    use tauri::Manager;
    let store = settings_store(&app)?;
    // A `general` record this build may not read (a newer build's, §10.2) is answered with the
    // schema's own default rather than guessed at: the windows are told the policy this build was
    // built with, which is the arm every other unreadable field takes. The character record below
    // is the one that decides whether there is a window to draw at all, and *its* read-only arm is
    // still an error — a choice exists there and cannot be honoured. The `message` record takes the
    // same arm as `general`: the bubble's alpha is a surface this window can draw with any value,
    // and a schema this build cannot read is not a reason to refuse the character too.
    let motion = crate::desktop_pet::character_view::stored_motion(&store);
    let bubble_opacity = crate::desktop_pet::character_view::stored_bubble_opacity(&store);
    // And the rest of that domain: what the bubble shows and how it lays the rows out. Read through
    // its own arm for the same reason, and on every appearance arm for the same reason the alpha is
    // — this is the read that makes 气泡与消息's phrases and layout reach a surface at all.
    let bubble_message = crate::desktop_pet::character_view::stored_bubble_message(&store);
    // The ball's size, for the one window that draws an orb rather than a whole character: the same
    // arrangement as the two above, and the reason `general.ballSize` reaches a page at all — the pet
    // windows hold no settings read (`capabilities/desktop-pet.json`).
    let ball_size = crate::desktop_pet::stored_ball_size(&store);
    let record = match store.read(PetSettingsDomain::Character) {
        PetSettingsLoad::Current { record } | PetSettingsLoad::Migrated { record, .. } => record,
        // No record: a fresh install. Nothing is chosen, which is a state the window draws as a
        // sentence — and deliberately not an error.
        PetSettingsLoad::Defaults {
            reason: DefaultsReason::Absent,
            ..
        } => {
            return Ok(crate::desktop_pet::PetAppearance::Unset {
                motion,
                bubble_opacity: bubble_opacity.value(),
                // Moved rather than cloned: this arm returns from the command, and the two arms
                // below it are exclusive.
                bubble: bubble_message,
                ball_size,
            });
        }
        // There is a file and it is not a record this build can read. Reported rather than read as
        // "nothing chosen": a corrupt record is not an empty one, and drawing nothing for one
        // would hide the corruption behind a state the user could not tell from a fresh install.
        PetSettingsLoad::Defaults {
            reason: DefaultsReason::Unreadable,
            ..
        } => {
            return Err(
                "the pet's character settings are there and are not readable as a record"
                    .to_string(),
            )
        }
        // §10.2: written by a newer build, so this one reads it and does not touch it. There is no
        // record to draw from, and pretending there is would be reading a future schema's fields
        // by guess.
        PetSettingsLoad::ReadOnly { found_version, .. } => {
            return Err(format!(
                "the pet's character settings are at schema {found_version}, which this build \
                 cannot read"
            ))
        }
    };
    let library = app.try_state::<CharacterLibrary>();
    let appearance = crate::desktop_pet::appearance(
        &record,
        motion,
        bubble_opacity,
        bubble_message,
        ball_size,
        library.as_deref(),
    );
    if let crate::desktop_pet::PetAppearance::Ready { sheet_path, .. } = &appearance {
        allow_character_sheet(&app, Path::new(sheet_path));
    }
    Ok(appearance)
}

/// The *app's* own appearance — its theme, colour scheme, accent, contrast and body size.
///
/// The other half of §1's 「保留现有主题、强调色」, and the only one of the pet's reads that is not
/// about the character. It exists because the app's appearance lives in the main window's store and
/// a pet window may not read it (§7.1; `app/desktop-pet-entry.test.ts` fails on an import graph that
/// reaches `stores/`), so what crosses is a *published* value — see
/// `desktop_pet/host_appearance.rs` for the relay and `app/pet-host-appearance-link.ts` for the
/// publisher.
///
/// No caller identity is checked, and that is deliberate rather than an omission: the permission is
/// what decides who may ask (`capabilities/desktop-pet.json` grants this to `pet-*` only, and
/// `desktop_pet_publish_host_appearance` to `main` alone), this answer holds no path, no window and
/// no character, and every pet window is entitled to the palette it is drawn in.
#[tauri::command]
pub fn desktop_pet_host_appearance(
    state: tauri::State<'_, DesktopPetState>,
) -> Result<HostAppearance, String> {
    let relay = state
        .appearance
        .lock()
        .map_err(|_| "the app's appearance could not be read: the lock was poisoned".to_string())?;
    Ok(relay.current())
}

/// The app publishes what it is drawing, and every mounted pet window hears it.
///
/// The write half, and it is a **command rather than an event** for §5.3's reason: 「事件不能作为
/// 无需授权的配置写入口」. An event is broadcast to whoever happens to listen, while this is
/// authorised per window by the ACL — `capabilities/default.json` grants it to `main` and to no
/// other window, which is exactly the shape of "only the app says what the app looks like".
///
/// Two effects, in this order, and the order is the rule: the value is stored first, so a window
/// that is created *because* of this frame reads the appearance rather than the defaults, and only
/// then is it broadcast, so a window that is already mounted moves without asking. A failed emit is
/// not an error — it means no pet window is listening, which is the state of the whole feature being
/// switched off, and the value remains readable.
///
/// The *normalised* value is what is broadcast rather than the raw write: a window must never be
/// handed something the read would not answer with, or the pushed appearance and the read one would
/// be two answers to one question.
#[tauri::command]
pub fn desktop_pet_publish_host_appearance<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DesktopPetState>,
    appearance: HostAppearanceWrite,
) -> Result<HostAppearance, String> {
    let held = {
        let mut relay = state.appearance.lock().map_err(|_| {
            "the app's appearance could not be published: the lock was poisoned".to_string()
        })?;
        relay.publish(appearance)
    };
    let _ = tauri::Emitter::emit(&app, PET_HOST_APPEARANCE_CHANNEL, held.clone());
    Ok(held)
}

/// One character's spritesheet, and nothing else, through `asset://`.
///
/// The scope cannot be narrowed — `allow_file` only ever appends — so it is never widened by a
/// directory: `commands/fs.rs`'s header is where that rule is argued, and a
/// `desktop-pet/characters/**` entry would hand the whole library to a protocol with no IPC guard
/// in front of it. The residue is the sheets of characters that have been drawn this session,
/// which is exactly what the user was looking at.
fn allow_character_sheet<R: tauri::Runtime>(app: &tauri::AppHandle<R>, path: &Path) {
    use tauri::Manager;
    let _ = app.asset_protocol_scope().allow_file(path);
}

/// Every character the library holds (§8), for the settings page that chooses one.
///
/// Read-only and deliberately not "the chosen one, plus the rest": the page compares this list
/// with the `character` domain's own value (which it is already editing), so the choice stays one
/// fact in one place rather than being reported twice.
#[tauri::command]
pub fn desktop_pet_library<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<crate::desktop_pet::PetCharacterEntry>, String> {
    use tauri::Manager;
    let library = app.try_state::<CharacterLibrary>();
    match library.as_deref() {
        // An app whose library could not be opened at startup (`lib.rs` reports it and carries
        // on). An empty list would be a lie about a library that may hold characters, so the
        // caller is told which of the two it is.
        None => Err("this build has no character library to read".to_string()),
        Some(library) => crate::desktop_pet::entries(library),
    }
}

/// Import one character pack the user picks in the OS dialog (§8's 导入).
///
/// The path is never a parameter: it comes from the dialog, which is a gesture by the user, and
/// nothing here joins a string the renderer sent onto a path — §8's rule for the resource side,
/// and the same shape `commands/fs.rs`'s dialogs have. `Ok(None)` is the user closing the dialog,
/// which is not an error.
///
/// The id and the name are derived from the folder the user picked (`character_view`), because a
/// pack folder is named by a human and an id has to be a path component. A pack that is already
/// installed is suffixed rather than refused — the alternative would be telling a user to delete
/// the character they are importing.
#[tauri::command]
pub async fn desktop_pet_import_character<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<crate::desktop_pet::PetCharacterEntry>, String> {
    use tauri::Manager;
    use tauri_plugin_dialog::DialogExt;
    let Some(source) = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|picked| picked.into_path().ok())
    else {
        return Ok(None);
    };
    let library = app
        .try_state::<CharacterLibrary>()
        .ok_or_else(|| "this build has no character library to import into".to_string())?;
    let name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "character".to_string());
    let character_id = crate::desktop_pet::free_character_id(&library, &name)?;
    let request = InstallRequest {
        character_id,
        name,
        kind: CharacterKind::Imported,
        source,
        installed_at_ms: now_ms(),
    };
    let installed = library
        .install(&request)
        .map_err(|refusal| crate::desktop_pet::refusal_sentence(&refusal))?;
    Ok(Some(crate::desktop_pet::PetCharacterEntry {
        character_id: installed.character_id.clone(),
        // What the library wrote, read back rather than echoed: the entry and the manifest are one
        // fact, and a second spelling of the name here could differ from the one on disk.
        pack_name: installed.name,
        kind: installed.kind,
        files: crate::desktop_pet::PetCharacterFiles::Intact,
        installed_at_ms: installed.installed_at_ms,
    }))
}

/// What the online catalogue offers right now (§8's 在线角色库).
///
/// The read is the whole of browsing: it answers with a state and, when there is one, a list of
/// offers — never an empty list for a failure, which is the defect §3.1 records against the
/// upstream client's `catalog.ts` (「区分离线、空库、损坏」). No URL crosses this boundary in either
/// direction: an offer is a name, a byline and a slug, and the address it would be downloaded from
/// is resolved on the host side from the catalogue the host itself read.
///
/// It is deliberately *not* cached. A browse is a user opening a page, and the alternative — a
/// process-lifetime copy of a document whose whole purpose is to change — would make the page's
/// first paint fast and every install after it resolve a slug against a list that may have moved.
#[tauri::command]
pub async fn desktop_pet_catalogue() -> Result<crate::desktop_pet::CatalogueReading, String> {
    Ok(crate::desktop_pet::read_catalogue().await)
}

/// Download one catalogue offer and install it (§8's 导入, from the network side).
///
/// The parameter is a **slug** and nothing else. §7.1's rule for windows is that a front end names
/// a character and never a window; this is the same rule one layer over, and the reason is the same
/// and stronger — a renderer that could name an address could point this app's downloader at any
/// host on the network. There is no argument to forge, so a catalogue document is the only thing
/// that can decide where a character comes from.
///
/// §8's four transfer rules are [`crate::desktop_pet::resources::remote`]'s, and every one of them
/// is applied before a byte is read: HTTPS, the catalogue's own host and a public address, a size
/// budget, and a content type that is checked against the bytes as well as the header. A refusal is
/// a sentence naming what refused — never a retry, and never a hang.
///
/// The character lands through [`CharacterLibrary::create`], the same transaction a locally made one
/// uses, and is recorded as [`crate::desktop_pet::CharacterKind::Remote`] so that what came from the
/// network is a fact on disk rather than a memory of this process.
#[tauri::command]
pub async fn desktop_pet_adopt_character<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    slug: String,
) -> Result<crate::desktop_pet::PetCharacterEntry, String> {
    use tauri::Manager;
    // Cloned out of the managed state rather than borrowed across the await: the fetch is a
    // suspension point, and a library held by reference through one would be a reference into the
    // app handle for as long as a remote host takes to answer.
    let library = app
        .try_state::<CharacterLibrary>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| "this build has no character library to install into".to_string())?;
    let installed = crate::desktop_pet::install_from_catalogue(&slug, &library, now_ms())
        .await
        .map_err(adoption_sentence)?;
    Ok(crate::desktop_pet::PetCharacterEntry {
        character_id: installed.character_id.clone(),
        // Read back from what the library wrote rather than echoed from the catalogue: the entry
        // and the manifest are one fact, and a second spelling of the name here could differ from
        // the one on disk.
        pack_name: installed.name,
        kind: installed.kind,
        files: crate::desktop_pet::PetCharacterFiles::Intact,
        installed_at_ms: installed.installed_at_ms,
    })
}

/// Why a catalogue install was refused, in the words the user reads.
///
/// Assembled here rather than in the module for the reason `ResourceRefusal` gives — the refusals
/// below are data, and a sentence built where the decision is made is one no page can translate —
/// with the module's own sentence for the library half, so the two cannot drift.
fn adoption_sentence(refusal: AdoptionRefusal) -> String {
    use crate::desktop_pet::resources::CatalogueFailure;
    match refusal {
        AdoptionRefusal::Catalogue(CatalogueFailure::Unconfigured) => {
            "no character catalogue is configured in this build".to_string()
        }
        AdoptionRefusal::Catalogue(CatalogueFailure::Unreachable(detail)) => {
            format!("the catalogue could not be reached: {detail}")
        }
        AdoptionRefusal::Catalogue(CatalogueFailure::Unreadable(detail)) => {
            format!("the catalogue could not be read: {detail}")
        }
        AdoptionRefusal::NoSuchOffer { slug } => {
            format!("the catalogue no longer offers {slug}")
        }
        AdoptionRefusal::Transfer(refusal) => refusal.detail(),
        AdoptionRefusal::Library(refusal) => crate::desktop_pet::refusal_sentence(&refusal),
    }
}

/// Now, in epoch milliseconds, for a manifest's install time.
///
/// Read here rather than injected because there is nothing to test about it at this layer: the
/// value is *recorded*, and every rule about it lives with the library that reads it back.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

/// Bring the main window up on the session one task belongs to (§6.2's 点击返回任务).
///
/// The same two-step shape as [`desktop_pet_open_settings`], and for the same reason: the window
/// is raised first, so the request lands on a listener that is mounted. What crosses is D1's
/// `PetTaskKey` — the six fields that name one run — and nothing else: no URL, no command, no
/// path, and no window label. §6.3 requires a notification's action to be a limited target the
/// host issued, and the host issued this one (the window read it from `desktop_pet_tasks`).
///
/// The key is *not* validated against the projection here, and that is a decision: a run that has
/// been retired still has a session the main window may want to show last known state for, and
/// "this session is gone" is a fact the window that holds sessions can state and this one cannot.
/// What the main window does with a key it does not recognise is that window's business.
#[tauri::command]
pub fn desktop_pet_open_task<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    task: crate::desktop_pet::PetTaskKey,
) -> Result<(), String> {
    raise_main(&app)?;
    tauri::Emitter::emit_to(&app, MAIN_WINDOW, PET_TASK_OPEN_CHANNEL, task)
        .map_err(|error| format!("the task request could not be delivered: {error}"))
}

/// Bring the main window up on one of §5.1's pet pages.
///
/// Two steps, in this order, and the order is the requirement: §5.1's 「主窗口隐藏时先安全唤起，不
/// 依赖 DOM 是否已挂载」. The window is raised first, so the event lands on a listener that is
/// mounted — a request delivered to a hidden window's page is a request answered by nothing.
/// The main window is never *created* here: if it is gone, that is a closed app, and a pet window
/// does not get to reopen it.
#[tauri::command]
pub fn desktop_pet_open_settings<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    page: String,
) -> Result<(), String> {
    if !SETTINGS_PAGES.contains(&page.as_str()) {
        return Err(format!(
            "{page} is not one of the pet's settings pages: {}",
            SETTINGS_PAGES.join(", ")
        ));
    }
    raise_main(&app)?;
    tauri::Emitter::emit_to(
        &app,
        MAIN_WINDOW,
        PET_SETTINGS_CHANNEL,
        SettingsRequest { page },
    )
    .map_err(|error| format!("the settings request could not be delivered: {error}"))
}

/// Raise the main window, or say why it cannot be raised.
///
/// Each step is reported rather than swallowed: "the settings did not open" is a dead-looking
/// right-click, and which of the three failed is what tells the difference between a window that
/// is minimized and one the session manager took away.
fn raise_main<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    use tauri::Manager;
    let window = app.get_webview_window(MAIN_WINDOW).ok_or_else(|| {
        "the main window is not open, so there is nowhere to show the settings".to_string()
    })?;
    window
        .unminimize()
        .map_err(|error| format!("the main window could not be restored: {error}"))?;
    window
        .show()
        .map_err(|error| format!("the main window could not be shown: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("the main window could not be focused: {error}"))
}

/// Tell every window what the feature state is now.
///
/// Broadcast rather than addressed to the pet windows, because the address would be the labels —
/// and a label is the one thing this module does not hand out. The channel is the pet's own, so
/// the frames cost the main window a listener it never registered. A failed emit is not an error:
/// it means no window is listening, which is what the shutdown path looks like, and the state is
/// readable on request in any case.
pub(super) fn publish_feature<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: PetFeatureState,
) {
    let _ = tauri::Emitter::emit(app, PET_FEATURE_CHANNEL, state);
}

/// A poisoned window lock, in the shape the window operations refuse with.
///
/// The lock can only be poisoned by a panic while it was held, and every method it guards returns
/// rather than panics — so this is the "something else went wrong" arm, and it is reported as a
/// failure of *this* operation rather than folded into a success. The action is the caller's, so a
/// refusal names the thing the user asked for and the detail names what actually happened.
fn window_state_refusal(action: WindowAction, detail: String) -> HostRefusal {
    HostRefusal::Window { action, detail }
}
