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
//! **The settings half and the care read are here; the task list is the one call that refuses
//! loudly instead.** D1's `PetGateway` reads and writes the settings domains (§5.3), lists the
//! tasks and reads the care ledger, and the settings and care calls have their backend: the two
//! settings commands are the surface a window reaches `desktop_pet/settings.rs` through, and
//! [`desktop_pet_care_read`] is the one read-only view of what §8's ledger settled.
//! `desktop_pet_tasks` — the third — has no backend yet (`task_projection.rs` is D4's and no state
//! in this process holds its projection), so no command is invented for it, and a window calling it
//! is answered by Tauri itself — "command desktop_pet_tasks not found" — which names the call that
//! is missing and needs no error code invented here to say so. The seam is already on the front end
//! (`tauri-pet.ts`), so the day it lands only this side changes.
//!
//! Registering a handler is `lib.rs`'s line and not this file's, so the commands written here are
//! reported to whoever owns the handler list rather than added to it from here. (Two of them are
//! still waiting there: `desktop_pet_read_settings` and `desktop_pet_update_settings` landed with
//! the store and are not yet in the list.)
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

use serde::Serialize;

use crate::desktop_pet::{
    CallerWindow, CapabilityReport, CareSummary, Closed, HostRefusal, LinuxEnvironment,
    PetInstance, PetSettingsDomain, PetSettingsLoad, PetSettingsRecord, PetSettingsStore,
    PetSettingsUpdate, PetSettingsWrite, PetWindowHost, TeardownReport, WindowAction,
};
use crate::state::DesktopPetState;

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
/// The main window's listener is the integrator's other half (reported, not written: it lands
/// with the `desktop-pet` settings section). The payload is a page and nothing else — no section
/// id, no window label, no URL — so the section this app opens is named once, in TypeScript, by
/// `PET_SETTINGS_SECTION`.
pub const PET_SETTINGS_CHANNEL: &str = "pet-open-settings";

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
    fn of(host: &PetWindowHost) -> Self {
        // A disabled feature has nothing to show, so `visible` is not merely "the flag is set":
        // reporting a hidden-but-enabled pet for a feature with no windows would be a state a
        // window could act on and be wrong about.
        let enabled = !host.instances().is_empty();
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
fn host(state: &DesktopPetState) -> Result<std::sync::MutexGuard<'_, PetWindowHost>, String> {
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
/// to address, which is why this command takes no parameter at all — the only command in this
/// file whose request body is nothing.
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

/// One settings domain, as a record, a default, or the reason this build will not read it (§5.3).
///
/// The four arms are four things the caller does with the answer — `defaults` and `migrated` may
/// be written back, `current` need not be, and `read-only` must not be — so nothing here flattens
/// them into a record with a flag. A store that cannot be read is not an error either: a missing
/// file, an unreadable one and a record from a newer build are three of the four arms, because a
/// settings page has something to say about each and a rejected promise would replace that with
/// nothing. What *is* refused is a domain that is not one of the seven: no page sends one, and a
/// refusal naming the seven is worth more than a `defaults` answer for a typo.
#[tauri::command]
pub fn desktop_pet_read_settings<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    domain: String,
) -> Result<PetSettingsLoad, String> {
    let domain = PetSettingsDomain::parse(&domain).ok_or_else(|| {
        format!(
            "{domain} is not one of the pet's settings domains: {}",
            PetSettingsDomain::ids().join(", ")
        )
    })?;
    Ok(settings_store(&app)?.read(domain))
}

/// One domain's write, applied or refused at the revision the caller read (§5.3).
///
/// The store decides everything about the record; this adds the one thing a store cannot know,
/// which is that an applied `general` write *is* the feature switch (§5.1): the windows follow it,
/// and the state a pet window listens for is published on the channel the window commands publish
/// on. That is what gives [`desktop_pet_open`] its caller — the enable path is a settings write,
/// and there is no other one.
///
/// A submission this build cannot accept comes back as `refused` rather than as a rejection, with
/// the reason as a code list: the page has to keep the user's draft on screen and say what was
/// wrong with it (§5.3's 「保存失败展示错误并保持可重试状态，不伪装成功」). A *domain* the contract
/// does not have never gets that far — deserializing the request refuses it while naming the
/// variants it would have accepted.
#[tauri::command]
pub fn desktop_pet_update_settings<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DesktopPetState>,
    write: PetSettingsWrite,
) -> Result<PetSettingsUpdate, String> {
    let store = settings_store(&app)?;
    let outcome = store.apply(&write);
    if let PetSettingsUpdate::Applied { record } = &outcome {
        // A poisoned window lock does not turn a saved setting into a failed one: the write did
        // happen, and this call's answer is what the caller asked for. What could not be applied
        // is the window, which is logged here and stated in the state the channel then carries.
        let feature = host(&state)
            .map(|mut host| apply_feature_switch(&mut host, record, &chosen_character(&store)))
            .unwrap_or_else(|detail| {
                eprintln!("the pet's windows did not follow a saved setting: {detail}");
                None
            });
        if let Some(feature) = feature {
            publish_feature(&app, feature);
        }
    }
    Ok(outcome)
}

/// The identity the pet's window is opened under while the character domain names none.
///
/// Not a character id and not a stand-in for one: `character.characterId` is `null` until a
/// character is chosen, and nothing can choose one until D8's library commands land. The window is
/// opened anyway — `DesktopPetRoot.vue` renders exactly this state ("No character is selected.") —
/// because a master switch whose only effect is a saved file is the inert control the ledger
/// forbids (「不显示可点击但无效果的控件」). The id is the host's own key and no window ever learns
/// it, so all it has to be is stable and non-blank, which is what keeps a second enable from
/// opening a second window.
pub const UNSELECTED_CHARACTER: &str = "unselected";

/// The feature switch, as the two things it does to the windows: §5.1's 启用 and §4's rollback.
///
/// `general.enabled` is a settings *value*, so the windows follow the write that set it rather than
/// a watcher on a file — and an applied `general` write is the one moment the answer is known to
/// this process. `true` opens the character window; `false` closes every window with
/// [`PetWindowHost::disable`], which is the rollback §4 defines as "the switch, which deletes
/// nothing". A write to any other domain touches no window and answers `None`.
///
/// The two refusals are logged rather than returned, and that is a decision rather than a shrug:
/// the *setting* was saved, and an answer of "refused" would tell the user their preference did not
/// take when what failed was a compositor. What happened is still the user's to see — the state
/// published afterwards says "no window" — and [`desktop_pet_open`] is the call that hands a page
/// the refusal itself, for a page that wants the sentence.
pub fn apply_feature_switch(
    host: &mut PetWindowHost,
    record: &PetSettingsRecord,
    character: &str,
) -> Option<PetFeatureState> {
    if record.domain != PetSettingsDomain::General {
        return None;
    }
    let enabled = record.value("enabled")?.as_bool()?;
    if enabled {
        if let Err(refusal) = host.open(character) {
            eprintln!("the pet's window could not be opened for {character}: {refusal:?}");
        }
    } else {
        for refusal in host.disable().failed {
            eprintln!("a pet window could not be closed: {refusal:?}");
        }
    }
    Some(PetFeatureState::of(host))
}

/// The pet's settings, resolved for one call.
///
/// Per call and not managed state: `DesktopPetState` holds the windows and the capability
/// evidence, and a store is a path with nothing to keep in memory — so what would be installed in
/// it is a copy of an answer, and §5.3's revision rule is the one thing that cannot survive two
/// answers to "what is stored". `storage::key_store::data_dir` resolves the same directory for the
/// rest of the app and is not called here: it is typed for the real runtime, while these commands
/// are generic over `R` so that a test can drive them the way `tests/desktop_pet_ipc_test` drives
/// the rest of this surface.
fn settings_store<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PetSettingsStore, String> {
    use tauri::Manager;
    let data = app.path().app_data_dir().map_err(|error| {
        format!("the pet's settings have no data directory to live in: {error}")
    })?;
    PetSettingsStore::new(data)
}

/// The character the pet's window is opened for: the one the settings name, or
/// [`UNSELECTED_CHARACTER`] while they name none.
fn chosen_character(store: &PetSettingsStore) -> String {
    store
        .chosen_character()
        .unwrap_or_else(|| UNSELECTED_CHARACTER.to_string())
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
fn publish_feature<R: tauri::Runtime>(app: &tauri::AppHandle<R>, state: PetFeatureState) {
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
