//! The feature switch, at the two moments this process learns what it is.
//!
//! The pet's two switches — `general.characterWindow` and `general.ball` — are stored values, so the
//! windows follow the *write* that set them — that is [`apply`], and
//! `commands::desktop_pet_surface` reaches it from the one command that applies a settings write.
//! What that leaves out is a launch: the switches are declared with defaults (`settings::fields`,
//! `GENERAL`), and a default that no write ever carried reached no window. A fresh install therefore
//! rendered 「显示桌宠」 checked and drew nothing until the user happened to save an unrelated field on
//! the same page — the defect `bundled-pets.md` reported and this module's [`restore`] closes.
//!
//! **Which windows a record opens, in one sentence.** Each of the pet's two windows exists exactly
//! when its *own* switch is on — `characterWindow` for the window the character is drawn in, `ball`
//! for the floating ball — and nothing above them decides anything. The two are peers and neither is
//! a master, which is what makes 只开悬浮球 a state rather than a special case, and the rule is read
//! in one place (here) so the page's controls and the host cannot disagree about what a field means
//! (§5.3). `general.enabled` is *not* a third input: it is derived from these two
//! (`settings::values::derive_master`), so a record that carries a contradictory one has already
//! been read as the switches say by the time it reaches here.
//!
//! **The rule both moments answer to, stated once.** The window agrees with what the settings page
//! shows for the same record, arm for arm:
//!
//! | the store says | the page shows | the window |
//! | --- | --- | --- |
//! | a record (`current` or `migrated`) | the record's values | what the record says |
//! | no record, or one nothing can read (`defaults`) | this build's defaults | the declared default |
//! | a record from a newer build (`read-only`) | no controls, and says so | nothing |
//!
//! The last row is the one that is a decision rather than a derivation. A newer build's record is
//! the only arm in which a *stated* choice is known to exist and cannot be read, so opening a window
//! for it would be guessing that the user wanted a pet — and the cost of guessing wrong is a pet
//! that came back for someone who had turned it off (a downgrade is exactly when that happens). The
//! two arms above it are not guesses: an absent record is a first run, and an unreadable one is
//! already read as this build's defaults everywhere else, so a window that stayed closed there would
//! be the page and the desktop disagreeing about one file.
//!
//! **Why it lives here rather than beside the command.** The rule is the pet's — which windows a
//! record opens, closes and leaves alone — and both callers need it: the settings command with a
//! record it just applied, and the app's setup with the record it just read. A copy on the command
//! side would be the second answer §9 forbids, so the command half delegates here and this file is
//! the only place the switch is decided.

use serde_json::Value;

use super::settings::{PetSettingsDomain, PetSettingsLoad, PetSettingsRecord, PetSettingsStore};
use super::window_host::{
    stored_always_on_top, stored_ball_size, stored_character_size, PetWindowHost,
};

/// The identity the pet's window is opened under while the character domain names none.
///
/// Not a character id and not a stand-in for one: `character.characterId` is `null` until a
/// character is chosen. The window is opened anyway — `DesktopPetRoot.vue` renders exactly this
/// state ("No character is selected.") — because a master switch whose only effect is a saved file
/// is the inert control the ledger forbids (「不显示可点击但无效果的控件」). The id is the host's own
/// key and no window ever learns it, so all it has to be is stable and non-blank, which is what
/// keeps a second enable from opening a second window. The bundled character is seeded before any
/// window opens, so a fresh install has a real one to name here in almost every case.
pub const UNSELECTED_CHARACTER: &str = "unselected";

/// The character the pet's window is opened for: the one the settings name, or
/// [`UNSELECTED_CHARACTER`] while they name none.
pub fn chosen_character(store: &PetSettingsStore) -> String {
    store
        .chosen_character()
        .unwrap_or_else(|| UNSELECTED_CHARACTER.to_string())
}

/// The `general` record a *start* reads, or `None` when the store holds one this build may not act
/// on.
///
/// `None` is the read-only arm and nothing else — see this module's table. Every other arm carries a
/// record: a stored one, or this build's defaults when there is none or it cannot be read, which is
/// what makes a fresh install's declared default reach the windows.
pub fn stored(store: &PetSettingsStore) -> Option<PetSettingsRecord> {
    match store.read(PetSettingsDomain::General) {
        // The one arm that carries no record, named rather than left to `record()`'s `None`: this
        // is where an unreadable *choice* becomes "no window", and a reader has to be able to see
        // that the other arms are not the same absence.
        PetSettingsLoad::ReadOnly { .. } => None,
        load => load.record().cloned(),
    }
}

/// Apply one applied `general` write to the pet's windows, or answer that it was not the switch.
///
/// `true` when the record carried the pet's two window switches, which is the caller's cue to publish
/// the state that follows — and a `general` record carrying *neither* of them is not the switch:
/// answering `true` for one would let a record this build did not write open a window by being empty,
/// which is the guard the old master-switch read provided, kept where the decision now lives.
///
/// The refusal arms are logged rather than returned, and that is a decision rather than a shrug: the
/// *setting* was saved, and an answer of "refused" would tell the user their preference did not take
/// when what failed was a compositor. What happened is still the user's to see — the state published
/// afterwards says "no window" — and `desktop_pet_open` is the call that hands a page the refusal
/// itself, for a page that wants the sentence.
pub fn apply(host: &mut PetWindowHost, record: &PetSettingsRecord, character: &str) -> bool {
    if record.domain == PetSettingsDomain::Character {
        // The renderer already follows this selection; keep the managed instance's key aligned
        // so the next general save reuses it. Selection alone must not open a disabled window.
        host.select_character(character);
        return false;
    }
    if record.domain != PetSettingsDomain::General {
        return false;
    }
    // `general.enabled` is deliberately not read: it is derived from the two below
    // (`settings::values::derive_master`), so a record that says anything else has already been read
    // as these two say before it got here, and reading it again would be a second answer to the
    // question the pair already answers.
    let (Some(character_window), Some(ball)) = (
        record.value("characterWindow").and_then(Value::as_bool),
        record.value("ball").and_then(Value::as_bool),
    ) else {
        return false;
    };
    // The ball's own switch first, because it is recorded rather than acted on: the host has to know
    // the preference before it is asked for the window that follows it.
    if let Err(refusal) = host.set_ball_enabled(ball) {
        eprintln!("the pet's ball did not follow a saved setting: {refusal:?}");
    }
    // The character window's own switch, and the whole of what decides that window. Off is
    // §5.1's 显示角色窗口 going off rather than §4's rollback: the ball's own switch was recorded a
    // line above and is untouched by this call, so 只开悬浮球 is what is left standing.
    if character_window {
        if let Err(refusal) = host.open_selected(character) {
            eprintln!("the pet's window could not be opened for {character}: {refusal:?}");
        }
    } else {
        for refusal in host.close_characters().failed {
            eprintln!("a character window could not be closed: {refusal:?}");
        }
    }
    // And the ball, which the call above only asked for when it opened a character window: with
    // 显示角色窗口 off this is the one that brings the ball up, and with it on the ball is already
    // there (or was refused, and this is the retry). `Ball::ensure` reads the preference.
    if let Err(refusal) = host.ensure_ball() {
        eprintln!("the pet's ball could not be opened: {refusal:?}");
    }
    true
}

/// The switch as a *launch*: read what is stored, and do to the windows what the write path would
/// have done had the user saved it just now.
///
/// Called once, from `state::DesktopPetState::new`, which is the one moment an app data directory
/// exists and no window does. A store nothing can be read from is not an error here: the windows
/// stay closed and the app runs without a pet, exactly as it does when the switch is off.
pub fn restore(host: &mut PetWindowHost, store: &PetSettingsStore) {
    // The window style first, and before any window exists: one of its flags is a stored preference
    // (`view.alwaysOnTop`, §5.2's 窗口行为) and the windows below are opened *with* it. Nothing is
    // open yet at a launch, so this only writes the host's own value — the applied-write path is
    // where open windows are moved.
    if let Err(refusal) = host.set_always_on_top(stored_always_on_top(store)) {
        eprintln!("the pet's window style could not be applied at startup: {refusal:?}");
    }
    // And the two sizes, for the same reason and at the same moment: a window's geometry is decided
    // when it is created (`character.size` for the character window, `general.ballSize` for the
    // ball), so a host that opened one before this ran would open it at the previous size and have
    // to be resized afterwards. Nothing is open yet, so neither call resizes anything either.
    if let Err(refusal) = host.set_character_size(stored_character_size(store)) {
        eprintln!("the pet's character size could not be applied at startup: {refusal:?}");
    }
    if let Err(refusal) = host.set_ball_size(stored_ball_size(store)) {
        eprintln!("the ball's size could not be applied at startup: {refusal:?}");
    }
    let Some(record) = stored(store) else {
        return;
    };
    // `stored` answers with a record that always carries both switches (this build's defaults when
    // nothing usable is stored), so `apply` cannot answer `false` here — and if a future schema
    // makes it possible, doing nothing is the right answer rather than a panic.
    if !apply(host, &record, &chosen_character(store)) {
        eprintln!("nekowite: the pet's stored switch carried no value to follow");
    }
}
