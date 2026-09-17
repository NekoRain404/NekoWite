//! What the pet's stored settings are, and what a window reaches them through.
//!
//! This is the other half of `desktop_pet.rs`, split by the rule each half has to be true of. A
//! settings write is a *record with a revision*: §5.3's four load arms (a current record, a
//! migrated one, a default, and one this build will not touch), a submission applied or refused at
//! the revision it was read, and a refusal that names a code rather than rejecting the caller's
//! draft — and an applied write is the one moment the process learns a preference changed, which is
//! why the feature switch and the notification ledger are applied from here. The parent's rule is
//! the window's: a caller names no window, and every privileged operation is authorised there.
//! Neither rule can be stated in the other's terms: adding a domain, a schema version or a
//! migration touches only this file, and a window operation touches only the parent's.
//!
//! What crosses the boundary is deliberate and one-way. This half reaches into the parent for
//! [`super::desktop_pet::host`], [`super::desktop_pet::publish_feature`] and
//! [`super::desktop_pet::PetFeatureState`], because an applied `general` write *is* the switch
//! (§5.1) and a store cannot know that. The parent reaches back for exactly one thing —
//! `settings_store`, which `desktop_pet_appearance` uses to read the `character` domain — so a
//! change to how settings are stored lands here and a change to what is drawn lands there.

use serde::Serialize;

use crate::desktop_pet::{
    feature_switch, PetSettingsDomain, PetSettingsLoad, PetSettingsRecord, PetSettingsStore,
    PetSettingsUpdate, PetSettingsWrite, PetTaskFeed, PetWindowHost,
};
use crate::state::DesktopPetState;

/// The switch rule itself lives in the pet's own tree (`desktop_pet::feature_switch`), because the
/// start path needs it as much as this one does and a second copy of "which windows does this
/// record open" is the second answer §9 forbids. What is re-exported here is the name the command
/// surface and its tests have always used.
pub use crate::desktop_pet::feature_switch::{chosen_character, UNSELECTED_CHARACTER};

use super::desktop_pet::{host, publish_feature, PetFeatureState};

/// The channel a *settings write* is published on, so a window drawing from settings hears it.
///
/// The gap it closes is the same shape as the one D3 reported about the feature state: the pet
/// window draws the character the `character` domain names, and a user changing that character in
/// the main window's settings had no way to reach a window that was already open — the window
/// would have had to poll a file for a change it can be *told* about. Published from
/// [`desktop_pet_update_settings`] after a write is applied, with the domain and the revision, so
/// a listener re-reads only what it draws.
///
/// A separate name from [`PET_SETTINGS_CHANNEL`], which is the deep link *into* the main window:
/// one is a request a pet window makes, this is news a pet window receives, and one channel
/// carrying both would be a listener that cannot tell which it is holding.
pub const PET_SETTINGS_CHANGED_CHANNEL: &str = "pet-settings-changed";

/// One applied settings write, as a window that draws from settings hears about it.
///
/// The domain and the revision and nothing else: a listener decides for itself whether it draws
/// from this domain, and shipping the values too would make each subscriber a second copy of the
/// record §5.3 keeps in exactly one place.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsChanged {
    domain: &'static str,
    revision: i64,
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
    // The window that draws from settings hears about the write here, and only here: a window with
    // a spritesheet on screen has no way to notice that the `character` domain moved, and a poll
    // is the thing §7.3's budget and this feature's own rule both refuse. Published after the
    // store applied it, so a listener that re-reads sees the new record rather than the old one
    // twice — the ordering the reference client's archive store uses, read the other way round.
    if let PetSettingsUpdate::Applied { record } = &outcome {
        let _ = tauri::Emitter::emit(
            &app,
            PET_SETTINGS_CHANGED_CHANNEL,
            SettingsChanged {
                domain: record.domain.id(),
                revision: record.revision,
            },
        );
    }
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
        // The other reader of a saved setting, and the one that is not a window: §6.3's ledger
        // decides a notice from the switches, and it is the only place they can be applied while
        // the app runs. A write to another domain answers `false` here and changes neither.
        apply_notification_switch(&state.tasks, record);
        // And the window *style*, which is the third thing an applied write reaches: the windows
        // that are already open are moved by the same call the launch path makes, so the checkbox
        // acts on the pet on screen rather than on the next one. A poisoned lock is logged the same
        // way and for the same reason as above — the setting *was* saved, and what could not follow
        // it is a window.
        if let Err(detail) = host(&state).map(|mut host| apply_window_style(&mut host, record)) {
            eprintln!("the pet's windows did not follow a saved style: {detail}");
        }
    }
    Ok(outcome)
}

/// The feature switch, as the three things it does to the windows: §5.1's 启用 and §4's rollback,
/// and the two per-window switches on the same record — 显示角色窗口 (`general.characterWindow`) and
/// 悬浮球 (`general.ball`).
///
/// `general.enabled` is a settings *value*, so the windows follow the write that set it rather than
/// a watcher on a file — and an applied `general` write is one of the two moments the answer is
/// known to this process (the other is a launch, `desktop_pet::feature_switch::restore`). A write
/// to any other domain touches no window and answers `None`.
///
/// The rule is `desktop_pet::feature_switch::apply`'s, and this is the command half of it: the
/// pet's own tree decides which windows a record opens, closes and leaves alone, and what is left
/// here is the state a window listens for — which only a running app can publish.
pub fn apply_feature_switch(
    host: &mut PetWindowHost,
    record: &PetSettingsRecord,
    character: &str,
) -> Option<PetFeatureState> {
    feature_switch::apply(host, record, character).then(|| PetFeatureState::of(host))
}

/// §5.2's 窗口行为, as an applied `view` write delivers it to the windows that are open.
///
/// The same shape as [`apply_feature_switch`], one domain over: a preference in the `view` record
/// reaches a window that is already on screen through the write that saved it, and through nothing
/// else. `view.alwaysOnTop` is upstream's *absence* as much as its value — upstream hardcoded
/// `.always_on_top(true)` at every one of its builder sites and its page had no such row — so what
/// this closes is not a porting gap but §5.2's own rule: the control on 常规与交互 stored a value
/// the window host never read, and a control that lies is the defect the rule names.
///
/// A write to another domain answers `false` and touches no window. A refusal from the compositor is
/// logged rather than returned, for the reason [`apply_feature_switch`] gives about its own: the
/// *setting* was saved, and what failed is a windowing system — §7.2's 「置顶」 row is where a user
/// reads what this desktop does instead, and the next window opens with the preference either way
/// (the host keeps it).
pub fn apply_window_style(host: &mut PetWindowHost, record: &PetSettingsRecord) -> bool {
    if record.domain != PetSettingsDomain::View {
        return false;
    }
    let Some(on_top) = record
        .value("alwaysOnTop")
        .and_then(serde_json::Value::as_bool)
    else {
        // A `view` record with no readable value is one this build did not write. The host keeps
        // what it has, which is the schema's own default and what upstream asked for.
        return false;
    };
    if let Err(refusal) = host.set_always_on_top(on_top) {
        eprintln!("a pet window did not follow the saved style: {refusal:?}");
    }
    true
}

/// The notification switches, as an applied write delivers them to the ledger that reads them.
///
/// The same gap [`apply_feature_switch`] closes, one domain over and one layer down: the eight
/// switches on the notification page are written by `desktop_pet_update_settings`, and the thing
/// they decide — whether a notice is attempted at all — is §6.3's ledger, which
/// `state::DesktopPetState::new` reads them into exactly once, at startup, because a file read on
/// the driver's task for every frame is what that read exists to avoid. An applied write is the
/// *other* moment the answer is known to this process, and without this hook a switch flipped by
/// the user took effect at the next start: §5.3's 「保存后立即生效」, on the page whose every control
/// is a switch.
///
/// A record that is not the notification domain's, or whose values are not switches this build can
/// read, changes nothing and says so by answering `false` — the ledger keeps the switches it has,
/// for the reason [`settings::notification_preferences`] gives about deciding a notice from half a
/// record. A poisoned lock is logged and never returned: the setting *was* saved, and a user whose
/// preference did not take is better told by the page's own state than by a refusal invented here.
pub fn apply_notification_switch(tasks: &PetTaskFeed, record: &PetSettingsRecord) -> bool {
    let Some(preferences) = crate::desktop_pet::settings::notification_preferences(record) else {
        return false;
    };
    match tasks.notifications() {
        Ok(mut policy) => {
            policy.set_preferences(preferences);
            true
        }
        Err(detail) => {
            eprintln!(
                "nekowite: a saved notification switch did not reach the pet's ledger: {detail}"
            );
            false
        }
    }
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
pub(super) fn settings_store<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PetSettingsStore, String> {
    use tauri::Manager;
    let data = app.path().app_data_dir().map_err(|error| {
        format!("the pet's settings have no data directory to live in: {error}")
    })?;
    PetSettingsStore::new(data)
}
