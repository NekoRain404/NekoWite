//! The character, as the two windows read it: the library list a settings page chooses from, and
//! the one drawing the pet window needs.
//!
//! §5.2's 角色与动画 puts the character in front of the user in two places — a picker in the main
//! window and a spritesheet in the pet window — and both are reads of the same two facts: what the
//! library holds (`resources.rs`) and what the `character` settings domain says. This module is
//! the join, and nothing here touches a window, a file or the network: it turns what those two
//! already answered into the two shapes a window can draw.
//!
//! Two facts a window is handed alongside them are not the character's: [`Motion`], which the
//! `general` domain stores (§5.2's 「跟随系统/应用设置」), and [`BubbleOpacity`], which `message`
//! stores (§5.2's 气泡与消息). Neither can a pet window read for itself —
//! `capabilities/desktop-pet.json` holds no settings read — and both ride the appearance because
//! the drawings and those two policies are what one frame needs together, which is the same
//! argument this module's own caller makes for handing out the sheet and the size in one answer.
//!
//! Three rules are structural:
//!
//! - **"Nothing is chosen" and "the choice cannot be honoured" are different answers.** A fresh
//!   install names no character (`unset`); a settings file naming one that is not installed, or
//!   whose files are not what the manifest recorded, is a *state* (`missing`) with the reason in
//!   it. Collapsing them would have a user who removed a character see "no character is selected",
//!   which is a different — and wrong — thing to say about a choice they made.
//! - **The sheet's path is built from names that were validated, never from a request.** The
//!   character id comes from the library's own directory listing and the file name from the
//!   manifest that install wrote; both are checked as path components again here
//!   ([`is_path_component`]), because a manifest on disk is a file a user can edit, and a name that
//!   stopped being a component is refused rather than joined onto a path.
//! - **A refusal is data in the library and a sentence here.** `ResourceRefusal` is a closed
//!   vocabulary for a caller to map (`resources.rs` says so), and the caller of *this* path is a
//!   settings page with no mapper of its own — so the sentence is written once, here, next to the
//!   state it is about.

use std::path::PathBuf;

use serde::Serialize;

use super::resources::{
    is_path_component, CharacterKind, CharacterLibrary, EntryState, LibraryEntry, PackageProblem,
    ResourceRefusal,
};
use super::settings::{PetSettingsDomain, PetSettingsRecord, PetSettingsStore};

/// The sheet a pack carried, as the manifest recorded it, and nothing else about the pack.
///
/// Deliberately not `InstalledCharacter`: the window needs the grid to slice with and the file to
/// draw, and handing a window the manifest's file list, digests and install time would be handing
/// it facts it has no use for. §6.1's rule about the pet window is one of *least*: what is not
/// needed to draw is not sent.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetCharacterSheet {
    pub columns: u32,
    pub rows: u32,
}

/// One installed character, as the settings page's picker shows it.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetCharacterEntry {
    pub character_id: String,
    /// The pack's own name, or the id when the directory carries no manifest this build wrote.
    pub pack_name: String,
    pub kind: CharacterKind,
    pub files: PetCharacterFiles,
    pub installed_at_ms: u64,
}

/// What a character's files are, as the library found them.
///
/// Two arms and not `EntryState`'s five: the page's question is "can this be drawn", and the four
/// ways of not being drawable are one answer to it. The detail is kept by the library for whoever
/// needs it (`CharacterLibrary::list`), and what a page says about a damaged character is its own.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PetCharacterFiles {
    /// Every file the manifest lists is there at the recorded size.
    Intact,
    /// Something is missing, changed, or was never describable. Still the user's character.
    Damaged,
}

/// What the pet window draws, or why it draws nothing.
///
/// Four states and never three: `unset` is a choice nobody made, `missing` is a choice this build
/// cannot honour, and a read that could not happen at all is an `Err` rather than a fourth arm —
/// the caller's own failure, which the window's notice reports in the host's words.
///
/// **`ready` carries the drawing facts, not the settings record.** The window needs a size, a
/// sheet, a grid and an animation mapping; handing it the domain's whole value map would make
/// every reader of this wire validate the schema for itself, and §5.3's 「界面和后端使用同一规则」
/// is one rule in one place. The store already normalized this record when it read it
/// (`settings::values::read_stored_values`), so what is below is that same reading, typed — and a
/// window cannot set a size the store would have refused.
#[derive(Clone, PartialEq, Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum PetAppearance {
    /// No character is chosen. The window says so and draws nothing.
    Unset {
        motion: Motion,
        #[serde(rename = "bubbleOpacity")]
        bubble_opacity: f64,
        /// The bubble's content model and layout — see [`BubbleMessage`]. On every arm for the
        /// reason `bubble_opacity` is: the surface is drawn in all three of them.
        bubble: BubbleMessage,
        /// The floating ball's diameter (`general.ballSize`), which is not the character's either:
        /// the ball is a window of its own and it is on the desktop with no character chosen at all.
        /// On every arm for the reason [`Motion`] is.
        #[serde(rename = "ballSize")]
        ball_size: f64,
    },
    /// A character is chosen and cannot be produced, with the reason in the host's words.
    Missing {
        #[serde(rename = "characterId")]
        character_id: String,
        detail: String,
        motion: Motion,
        #[serde(rename = "bubbleOpacity")]
        bubble_opacity: f64,
        /// See [`PetAppearance::Unset`]'s own.
        bubble: BubbleMessage,
        /// See [`PetAppearance::Unset`]'s own pair.
        #[serde(rename = "ballSize")]
        ball_size: f64,
    },
    /// Draw this.
    Ready {
        #[serde(rename = "characterId")]
        character_id: String,
        /// The pack's own name, for a sentence that has to name the character.
        name: String,
        /// The spritesheet's absolute path. The window turns it into an `asset://` URL — the
        /// command that answered this granted exactly this file (`desktop_pet_appearance`).
        #[serde(rename = "sheetPath")]
        sheet_path: String,
        sheet: PetCharacterSheet,
        /// Rendered size in CSS pixels (`character.size`, already in its rule's range).
        size: u64,
        /// Which sheet row each mood plays (`character.bindings`).
        bindings: serde_json::Map<String, serde_json::Value>,
        /// The rows the idle mood cycles through, and how (`character.idleClips`, `idleMode`).
        #[serde(rename = "idleClips")]
        idle_clips: Vec<u64>,
        #[serde(rename = "idleMode")]
        idle_mode: String,
        /// One idle clip's lifetime (`character.idleIntervalSeconds`, in milliseconds so the
        /// renderer's own unit is what crosses the wire — the conversion happens once, here).
        #[serde(rename = "idleIntervalMs")]
        idle_interval_ms: u64,
        motion: Motion,
        /// The bubble's background alpha, which is not the character's either — see
        /// [`BubbleOpacity`]. On every arm for the same reason `motion` is: the bubble is drawn by
        /// this window in all three of them, a fresh install included.
        #[serde(rename = "bubbleOpacity")]
        bubble_opacity: f64,
        /// The bubble's content model and layout — see [`BubbleMessage`].
        bubble: BubbleMessage,
        /// See [`PetAppearance::Unset`]'s own pair.
        #[serde(rename = "ballSize")]
        ball_size: f64,
    },
}

/// How far the pet's windows may move, from `general.motion`.
///
/// The *stored policy* and not a decision: the system's own `prefers-reduced-motion` is a question
/// each window asks its own engine (the ball answers it in CSS today), so what crosses this wire
/// is only what the user chose in the app. A host that answered `Reduced` for a machine whose
/// system asked for less would be inventing a restriction, and one that answered `System` for a
/// user who chose `reduced` would be dropping the one §5.2 requires the pet to follow
/// (「跟随系统/应用设置；桌宠可更保守，不能反向解除全局限制」).
///
/// **On every arm, and not part of [`Drawing`].** The ball is one of the pet's windows whether or
/// not a character is chosen — it draws upstream's plain orb in the `Unset` arm — so a policy that
/// only arrived with `Ready` would leave the one surface this build has that moves unreduced in
/// the state a fresh install is in. It is not the character's, which is why it is not a `Drawing`
/// field: the character record does not hold it and `general` does.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Motion {
    /// Follow the system's own preference, which is the schema's default.
    System,
    /// The user asked for less motion than the system does.
    Reduced,
}

impl Motion {
    /// The member `settings::fields`' `GENERAL` declares as the default, and therefore the reading
    /// of every value this build cannot act on: an absent field on a record an older build wrote,
    /// a member nothing recognises, and a `general` record from a newer build — which §10.2 keeps
    /// this build from reading at all, and which cannot be guessed into `Reduced` because a
    /// restriction the user did not ask for is a change, not a default.
    pub const DEFAULT: Self = Self::System;

    /// The policy a `general` record holds.
    ///
    /// The store normalized the record on the way out of the file (`settings::values`), so a member
    /// other than the one below is either the other declared member or a value nothing wrote —
    /// and both take the schema's default, the arm [`Drawing::of`] takes for its own fields.
    pub fn of(record: &PetSettingsRecord) -> Self {
        match record.value("motion").and_then(serde_json::Value::as_str) {
            Some("reduced") => Self::Reduced,
            _ => Self::DEFAULT,
        }
    }
}

/// The policy a store holds for the pet's windows.
///
/// The one read [`appearance`]'s caller performs, and a function rather than three lines in the
/// command because a test asserting what a window is handed should go through the same arm — the
/// alternative is a second copy of the rule that the two can drift apart on.
///
/// A `general` record this build may not read is answered with [`Motion::DEFAULT`] rather than
/// guessed at. That arm is `store.read`'s `ReadOnly` — a record a newer build wrote, which §10.2
/// keeps this build from reading — and the alternative (`Reduced`) would be inventing a
/// restriction the user never asked for, while the window would still honour the system's own
/// preference through its own engine.
pub fn stored_motion(store: &PetSettingsStore) -> Motion {
    store
        .read(PetSettingsDomain::General)
        .record()
        .map_or(Motion::DEFAULT, Motion::of)
}

/// The bubble's background alpha, from `message.opacity` (§5.2's 气泡与消息).
///
/// The third fact that rides this read and is not the character's, and it rides it for the reason
/// [`Motion`] does: the bubble is one of the surfaces in the window that draws the character
/// (`DesktopPetRoot.vue`), `capabilities/desktop-pet.json` holds no settings read, and §5.2's
/// opacity was a control whose value no window could act on until this carried it.
///
/// Upstream's own value and meaning: `ap_opacity`, a percentage the user picks on the Bubble page,
/// whose alpha goes straight into the bubble's own `--bubble-bg` (`windows/src/main.ts:88-100`).
/// Not the window's opacity — upstream has no such setting, and neither `tauri` nor `tao` exposes a
/// call that could apply one.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct BubbleOpacity(f64);

impl BubbleOpacity {
    /// The member `settings::fields`' `MESSAGE` declares, and therefore the reading of every value
    /// this build cannot act on: an absent field on a record an older build wrote, a value outside
    /// the rule, and a `message` record from a newer build — which §10.2 keeps this build from
    /// reading at all, and which cannot be guessed into a transparency the user never chose.
    pub const DEFAULT: Self = Self(0.92);

    /// The alpha a `message` record holds.
    ///
    /// The store normalized this record on the way out of the file (`settings::values`), so what
    /// reaches the second arm is a record this build did not write — and the schema's own default
    /// is the value the bubble was drawn with before the field existed.
    pub fn of(record: &PetSettingsRecord) -> Self {
        match record.value("opacity").and_then(serde_json::Value::as_f64) {
            Some(value) => Self(value),
            None => Self::DEFAULT,
        }
    }

    pub fn value(self) -> f64 {
        self.0
    }
}

/// The alpha a store holds for the pet's bubble.
///
/// The second read `appearance`'s caller performs, and a function for the reason
/// [`stored_motion`] is: a test asserting what a window is handed goes through the same arm.
///
/// A `message` record this build may not read is answered with [`BubbleOpacity::DEFAULT`] rather
/// than guessed at — the `ReadOnly` arm of `store.read`, which §10.2 keeps this build from reading
/// — because a transparency the user never chose is a change to what they see, not a default.
pub fn stored_bubble_opacity(store: &PetSettingsStore) -> BubbleOpacity {
    store
        .read(PetSettingsDomain::Message)
        .record()
        .map_or(BubbleOpacity::DEFAULT, BubbleOpacity::of)
}

/// The `message` domain as the bubble draws with it: what it shows, and how (§5.2's 气泡与消息).
///
/// The fifth fact riding this read and not the character's, and it rides it for the reason
/// [`BubbleOpacity`] does: the bubble is drawn in the window that draws the character,
/// `capabilities/desktop-pet.json` holds no settings read, so a window cannot ask for the domain
/// itself — and without this the whole of 气泡与消息 was a page whose values were stored and never
/// drawn with. The user's own lines (`message.quickBubbles`) and the layout that decides what a row
/// shows (`layoutMode`, `layoutMaxRows`, `grouping`, `filter`, `separator`, `tokens`) had no
/// production caller at all: the bubble was drawn, so a user who wrote a phrase saw a bubble and
/// not their words.
///
/// **The renderer's names, not the schema's, where the two differ.** `layoutMode`/`layoutMaxRows`
/// cross as `mode`/`maxTasks`, which is the vocabulary `PetBubble` already takes its layout in
/// (`features/desktop-pet/services/pet-bubble-layout.ts`), so the page's own reader
/// (`resolvePetBubbleLayout`) stays the single place a value is judged and the window is handed
/// something it can draw with. The separator crosses as the *name* the schema stores (`dot`,
/// `arrow`, `bar`, `space`) rather than as a character, because the name-to-character table is a
/// drawing rule and that table is on the other side.
///
/// **Only the fields the bubble draws with cross**, which is §6.1's rule of least: `message` holds
/// `fontSize`, `dot` and `bubbleSeconds` as well, and none of them is here because no surface in
/// this window acts on one. Sending them would be a payload a window must ignore, and a wire field
/// with no reader is the shape this whole change is about.
///
/// A `message` record this build may not read — `store.read`'s `ReadOnly` arm, a record a newer
/// build wrote, which §10.2 keeps this build from reading — is answered with the schema's defaults
/// for the same reason [`Motion::DEFAULT`] is: the bubble is drawn either way, and a layout the user
/// never chose is a change to what they see rather than a default.
#[derive(Clone, PartialEq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BubbleMessage {
    /// How the tasks are presented (`message.layoutMode`), under the renderer's own name.
    pub mode: String,
    /// How many rows the surface shows (`message.layoutMaxRows`), under the renderer's own name.
    #[serde(rename = "maxTasks")]
    pub max_tasks: u64,
    /// Whether the rows are gathered under their engine (`message.grouping`).
    pub grouping: String,
    /// What the surface leaves out (`message.filter`).
    pub filter: String,
    /// What stands between two fields (`message.separator`), as the schema's member name.
    pub separator: String,
    /// The row's fields and their visibility (`message.tokens`). Empty means the preset.
    pub tokens: Vec<serde_json::Value>,
    /// The lines the pet says when there is no task to speak of (`message.quickBubbles`).
    pub phrases: Vec<String>,
    /// Whether it says one at all (`message.idle`, upstream's 「Show idle message」).
    pub idle: bool,
    /// The bubble's own text size in px (`message.fontSize`, upstream `ap_font_size`).
    ///
    /// Upstream's `applyBubble` feeds this straight into `--bubble-font-size` on the document root
    /// (`windows/src/main.ts:88-100`), so it is the *bubble's* size and never the app's body size —
    /// which is what the page drew with before this crossed, at whatever `--app-body-size` the
    /// token scale declares.
    #[serde(rename = "fontSize")]
    pub font_size: f64,
    /// Which state-dot style a row draws (`message.dot`): `plain` or `claude`.
    ///
    /// A member name crosses for the reason [`BubbleMessage::theme`]'s does — the glyphs and the
    /// colours are the renderer's — and it rides this payload for the reason the two fields above
    /// it do: the row that draws the dot is in this window, and the setting had no reader at all.
    pub dot: String,
    /// Which palette the bubble is drawn from (`message.theme`): `system`, `light` or `dark`.
    ///
    /// A member name crosses and never a colour: the colours are the application's own tokens, and
    /// the page is where they are selected (`features/desktop-pet/services/pet-bubble-theme.ts`).
    /// It rides this payload for the reason [`BubbleOpacity`] does — the window's own page may not
    /// read a settings domain — and for one more: until it did, the control on 气泡与消息 was read by
    /// the settings page's own preview and by nothing on the desktop, so a user who picked Light saw
    /// the preview change and the bubble they had put on their desktop stay as it was.
    pub theme: String,
}

impl BubbleMessage {
    /// The member `settings::fields`' `MESSAGE` declares for each field, and therefore the reading
    /// of every value this build cannot act on. Spelled here in the same order as the struct, and
    /// checked against the schema on the TypeScript side by `pet-appearance.test.ts`.
    fn defaults() -> Self {
        Self {
            mode: "list".to_string(),
            max_tasks: 5,
            grouping: "by-agent".to_string(),
            filter: "all".to_string(),
            separator: "dot".to_string(),
            tokens: Vec::new(),
            phrases: Vec::new(),
            idle: true,
            font_size: 12.0,
            dot: "plain".to_string(),
            theme: "system".to_string(),
        }
    }

    /// The values a `message` record holds, field by field, with every unusable one defaulted.
    ///
    /// Field by field and not all-or-nothing, which is the rule §5.3 gives a migrated store: a
    /// record whose font size is nonsense still has a layout, and taking the whole payload's
    /// fallback for one bad field would throw away choices the user made.
    pub fn of(record: &PetSettingsRecord) -> Self {
        let defaults = Self::defaults();
        let string = |field: &str, fallback: &str| {
            record
                .value(field)
                .and_then(serde_json::Value::as_str)
                .unwrap_or(fallback)
                .to_string()
        };
        Self {
            mode: string("layoutMode", &defaults.mode),
            max_tasks: record
                .value("layoutMaxRows")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(defaults.max_tasks),
            grouping: string("grouping", &defaults.grouping),
            filter: string("filter", &defaults.filter),
            separator: string("separator", &defaults.separator),
            tokens: record
                .value("tokens")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or(defaults.tokens),
            // A copy, with no filter of its own: `settings::values`' `isLine` already refuses a
            // blank or control-bearing line, and its structured fields are all-or-nothing — so a
            // list that arrived holds lines the schema accepted, and a second rule here would be a
            // rule that can never fire.
            phrases: record
                .value("quickBubbles")
                .and_then(serde_json::Value::as_array)
                .map(|lines| {
                    lines
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or(defaults.phrases),
            idle: record
                .value("idle")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(defaults.idle),
            // Through the field's own rule and not a copy of it: `settings::values` refuses a size
            // outside upstream's three-button span on the way in, so what reaches the second arm is
            // a record this build did not write, and the fallback is what the bubble was drawn at
            // before the field existed.
            font_size: record
                .value("fontSize")
                .and_then(serde_json::Value::as_f64)
                .filter(|value| value.is_finite() && (10.0..=14.0).contains(value))
                .map(|value| value.round())
                .unwrap_or(defaults.font_size),
            dot: string("dot", &defaults.dot),
            // The store normalized this record on the way out of the file (`settings::values`), so
            // what reaches the second arm is a record this build did not write — and the schema's
            // own default is the theme the bubble was drawn with before the field was carried. The
            // *page* is where a name becomes a palette (`pet-bubble-theme.ts`), so nothing here
            // judges which members are drawable.
            theme: string("theme", &defaults.theme),
        }
    }
}

/// What a store holds for the pet's bubble beyond its alpha.
///
/// The second read of the `message` domain, and a function for the reason [`stored_motion`] is: a
/// test asserting what a window is handed goes through the same arm.
pub fn stored_bubble_message(store: &PetSettingsStore) -> BubbleMessage {
    store
        .read(PetSettingsDomain::Message)
        .record()
        .map_or_else(BubbleMessage::defaults, BubbleMessage::of)
}

/// The floating ball's diameter in CSS pixels, from `general.ballSize` (§5.1's 悬浮球).
///
/// The fourth fact that rides this read and is not the character's, and it rides it for the reason
/// [`Motion`] does: the ball is a pet window, `capabilities/desktop-pet.json` holds no settings read
/// for it, and this number is *both* what the orb is drawn at and what the window around it is sized
/// to (`window_host::stored_ball_size` reads the same field for the host's half). One stored number
/// behind the orb and its window, which is the whole of §9's rule here: a page that measured its own
/// window, or a host that guessed the page's size, would be the second answer.
///
/// It is not the character's even though the ball wears the character's face: the ball is on the
/// desktop with no character chosen at all, and its size is not a property of what it wears.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct BallSize(f64);

impl BallSize {
    /// The member `settings::fields`' `GENERAL` declares — upstream's `--ball-size` — and therefore
    /// the reading of every value this build cannot act on: an absent field on a record an older
    /// build wrote, a value outside the rule, and a `general` record from a newer build, which §10.2
    /// keeps this build from reading at all.
    pub const DEFAULT: Self = Self(super::ball::BALL_DEFAULT_SIZE);

    /// The diameter a `general` record holds.
    ///
    /// The store normalized this record on the way out of the file (`settings::values`), so what
    /// reaches the second arm is a record this build did not write — and the schema's own default is
    /// the size this build's ball has always been.
    pub fn of(record: &PetSettingsRecord) -> Self {
        match record.value("ballSize").and_then(serde_json::Value::as_f64) {
            Some(value) => Self(value),
            None => Self::DEFAULT,
        }
    }

    pub fn value(self) -> f64 {
        self.0
    }
}

/// Every character the library holds, oldest install last.
///
/// Sorted by install time, which is the order a page shows them in (D8's policy puts the newest
/// first) — a listing whose order came from the filesystem would move when a directory did.
pub fn entries(library: &CharacterLibrary) -> Result<Vec<PetCharacterEntry>, String> {
    let mut listed = library.list().map_err(|refusal| {
        format!(
            "the character library could not be read: {}",
            refusal_sentence(&refusal)
        )
    })?;
    listed.sort_by_key(|entry| entry.manifest.as_ref().map_or(0, |m| m.installed_at_ms));
    Ok(listed.iter().map(entry_of).collect())
}

/// One library entry as the page reads it.
fn entry_of(entry: &LibraryEntry) -> PetCharacterEntry {
    let manifest = entry.manifest.as_ref();
    PetCharacterEntry {
        character_id: entry.character_id.clone(),
        // An entry with no manifest is one the library cannot describe (a directory from another
        // build, or something the user put there). It is listed — hiding it would make a character
        // that needs attention look like one that was never installed — and named by its id.
        pack_name: manifest.map_or_else(|| entry.character_id.clone(), |m| m.name.clone()),
        kind: manifest.map_or(CharacterKind::Imported, |m| m.kind),
        files: match entry.state {
            EntryState::Intact => PetCharacterFiles::Intact,
            _ => PetCharacterFiles::Damaged,
        },
        installed_at_ms: manifest.map_or(0, |m| m.installed_at_ms),
    }
}

/// What the pet window draws for the character a settings record names.
///
/// The whole record rather than just the id, because the drawing facts are fields of it. `library`
/// is `None` when this build could not open one at all, which is the same class of answer as a
/// character that is not installed: the choice exists and cannot be honoured, and the reason
/// differs only in the sentence.
///
/// `motion` is the `general` record's policy rather than a field of this one — see [`Motion`] for
/// why a window is handed it with its drawing facts instead of asking for it, and
/// `commands::desktop_pet::desktop_pet_appearance` for the read that supplies it. `bubble_opacity`
/// and `bubble_message` are the same arrangement one domain over: the `message` domain's alpha and
/// its content model, which the window draws with and may not read for itself. `ball_size` is a
/// third of the same kind: `general.ballSize`, the ball's own diameter, which the ball's window
/// draws its orb at and which its page may not read for itself either.
pub fn appearance(
    record: &PetSettingsRecord,
    motion: Motion,
    bubble_opacity: BubbleOpacity,
    bubble_message: BubbleMessage,
    ball_size: f64,
    library: Option<&CharacterLibrary>,
) -> PetAppearance {
    let bubble_opacity = bubble_opacity.value();
    let chosen = record
        .value("characterId")
        .and_then(serde_json::Value::as_str);
    let drawing = Drawing::of(record);
    let Some(chosen) = chosen else {
        return PetAppearance::Unset {
            motion,
            bubble_opacity,
            bubble: bubble_message,
            ball_size,
        };
    };
    let Some(library) = library else {
        return PetAppearance::Missing {
            character_id: chosen.to_string(),
            detail: "this build has no character library to read it from".to_string(),
            motion,
            bubble_opacity,
            // Cloned rather than moved: the closure below returns on several arms, and a value
            // taken here would have to be rebuilt for each of them.
            bubble: bubble_message.clone(),
            ball_size,
        };
    };
    let entry = match library.list() {
        Ok(listed) => listed
            .into_iter()
            .find(|entry| entry.character_id == chosen),
        Err(refusal) => {
            return PetAppearance::Missing {
                character_id: chosen.to_string(),
                detail: format!(
                    "the character library could not be read: {}",
                    refusal_sentence(&refusal)
                ),
                motion,
                bubble_opacity,
                bubble: bubble_message.clone(),
                ball_size,
            }
        }
    };
    let Some(entry) = entry else {
        return PetAppearance::Missing {
            character_id: chosen.to_string(),
            detail: "it is not installed in the character library".to_string(),
            motion,
            bubble_opacity,
            bubble: bubble_message.clone(),
            ball_size,
        };
    };
    // The closure owns its own copy: it is called on four different arms and each of them returns
    // its own `Missing`, so the value it draws with cannot be the one the `Ready` arm below takes.
    let for_refusals = bubble_message.clone();
    let unavailable = move |detail: String| PetAppearance::Missing {
        character_id: chosen.to_string(),
        detail,
        motion,
        bubble_opacity,
        bubble: for_refusals.clone(),
        ball_size,
    };
    if let EntryState::Incomplete { missing } = &entry.state {
        return unavailable(format!(
            "its files are missing from the library: {}",
            missing.join(", ")
        ));
    }
    if let EntryState::Resized { changed } = &entry.state {
        return unavailable(format!(
            "its files are not the size the library recorded: {}",
            changed.join(", ")
        ));
    }
    let Some(manifest) = entry.manifest else {
        return unavailable(
            "the library cannot describe it (no manifest this build wrote)".to_string(),
        );
    };
    // Both names are checked as components even though the library wrote them, because the
    // manifest is a file on disk and this is the one place a name from it becomes a path.
    if !is_path_component(&entry.character_id) || !is_path_component(&manifest.sheet.file) {
        return unavailable("its manifest names a file outside the library".to_string());
    }
    let path: PathBuf = library
        .root()
        .join(&entry.character_id)
        .join(&manifest.sheet.file);
    if !path.is_file() {
        return unavailable("its spritesheet is not where the manifest says it is".to_string());
    }
    PetAppearance::Ready {
        character_id: entry.character_id.clone(),
        name: manifest.name.clone(),
        sheet_path: path.to_string_lossy().into_owned(),
        sheet: PetCharacterSheet {
            columns: manifest.sheet.columns,
            rows: manifest.sheet.rows,
        },
        size: drawing.size,
        bindings: drawing.bindings,
        idle_clips: drawing.idle_clips,
        idle_mode: drawing.idle_mode,
        idle_interval_ms: drawing.idle_interval_ms,
        motion,
        bubble_opacity,
        bubble: bubble_message,
        ball_size,
    }
}

/// The `character` domain's fields a window draws with, read out of the record's own values.
///
/// Every read falls back to the schema's default rather than failing: the store normalized this
/// record on the way out of the file, so a field that is absent or of the wrong kind is a record
/// something else wrote — and a character whose size cannot be read is still the character the
/// user chose. The fallbacks are `PET_SETTINGS_DEFAULTS.character`'s, spelled in
/// `settings/values.rs` on this side and in `pet-contracts/config.ts` on the other.
struct Drawing {
    size: u64,
    bindings: serde_json::Map<String, serde_json::Value>,
    idle_clips: Vec<u64>,
    idle_mode: String,
    idle_interval_ms: u64,
}

impl Drawing {
    fn of(record: &PetSettingsRecord) -> Self {
        let size = record
            .value("size")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(160);
        let bindings = record
            .value("bindings")
            .and_then(serde_json::Value::as_object)
            .cloned()
            .unwrap_or_default();
        let idle_clips = record
            .value("idleClips")
            .and_then(serde_json::Value::as_array)
            .map(|clips| clips.iter().filter_map(serde_json::Value::as_u64).collect())
            .unwrap_or_default();
        let idle_mode = record
            .value("idleMode")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("random")
            .to_string();
        let idle_interval_ms = record
            .value("idleIntervalSeconds")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(5)
            .saturating_mul(1000);
        Self {
            size,
            bindings,
            idle_clips,
            idle_mode,
            idle_interval_ms,
        }
    }
}

/// The id a new character is installed under: a slug of the name the user picked, made unique.
///
/// **This is a generator, not a rule.** What the library *accepts* is
/// [`resources::is_path_component`] — any name the filesystem can hold — and a caller that brings
/// an id of its own never reaches this function. What this decides is what the app invents for a
/// folder a human named, and a human names a folder the way humans do: `My Pet!` becomes `my-pet`,
/// and 「喵喵」 becomes 「喵喵」. Lowercased letters and digits of any script survive, every run of
/// anything else collapses to one `-`, and the result is at most [`MAX_ID_CHARS`] bytes.
///
/// **Non-ASCII is kept, and that is the point.** A Chinese-language user's folders are named in
/// Chinese, and an id that dropped every one of those characters would leave this library unable
/// to hold the characters its user has — the exact gap D12's report named. The library is byte-
/// exact (see `resources::is_path_component` on NFC/NFD), so the id a folder gets is the id a
/// second import of the same spelling asks for, and two spellings are two characters.
///
/// A name with nothing usable in it at all — one that is only punctuation or only emoji — has no
/// id and the import is refused: inventing one (`character-1`) would be naming the user's
/// character for them, and the sentence says which folders work rather than only that this one
/// did not.
///
/// Uniqueness is resolved by suffix, because the library refuses an id that is taken and the only
/// other answer available to a user re-importing a pack they already have is "remove the old one
/// first". Nine attempts and then a refusal: at that point the name is not the thing that
/// identifies the character any more, and picking a number for a user is worse than telling them.
pub fn free_character_id(library: &CharacterLibrary, name: &str) -> Result<String, String> {
    let taken: Vec<String> = library
        .list()
        .map_err(|refusal| {
            format!(
                "the character library could not be read: {}",
                refusal_sentence(&refusal)
            )
        })?
        .into_iter()
        .map(|entry| entry.character_id)
        .collect();
    let base = slug(name);
    if base.is_empty() {
        // Not "the name is not ASCII" — that was the old rule and it is gone. What is left is a
        // name with no letter or digit in it at all (`…`, `!!!`, a folder named with an emoji),
        // and the sentence names the requirement the folder can meet rather than the character
        // class it did not.
        return Err(format!(
            "{name} has no letter or digit in it to make a character id from (any script will \
             do — the id is the folder's name with everything that is not a letter or a digit \
             turned into \"-\"): rename the folder, or import it from a folder whose name has one"
        ));
    }
    if !taken.contains(&base) {
        return Ok(base);
    }
    for n in 2..=MAX_ID_ATTEMPTS {
        let candidate = format!("{base}-{n}");
        if !taken.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err(format!(
        "the library already holds {base} and nine variants of it; remove one before importing"
    ))
}

/// How long a generated id may be, in bytes. Well inside
/// [`resources::MAX_COMPONENT_BYTES`], so everything this invents is a name the library takes —
/// which is what makes the two facts separate: the validator has its own bound and the generator
/// stays inside it rather than raising it.
const MAX_ID_CHARS: usize = 48;
/// How many suffixed variants one import will try before it refuses.
const MAX_ID_ATTEMPTS: u32 = 9;

/// A folder name as a path component, or an empty string when nothing survives.
///
/// Letters and digits of every script are kept (`char::is_alphanumeric`, which is the Unicode
/// property and not `[A-Za-z0-9]`), lowercased where a script has case, and everything else is a
/// run of `-`. The result is always a path component: it holds no separator, no control character
/// and no leading dot, and the length is bounded below.
fn slug(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = true;
    for c in name.chars() {
        if c.is_alphanumeric() {
            // Checked before the push and against the character's own width, so the bound is the
            // bound for a name in Chinese (three bytes a character) and not only for an ASCII one.
            if out.len() + c.len_utf8() > MAX_ID_CHARS {
                break;
            }
            out.extend(c.to_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// Why the library refused an operation, as a sentence a user reads.
///
/// One arm per variant of `ResourceRefusal`, and the two that name a rule (`package`, `budget`)
/// say which rule in the library's own words rather than in a code. A refusal is the *last* thing
/// between a user and a character they asked for, and "Budget" alone would be a message about this
/// module's internals.
pub fn refusal_sentence(refusal: &ResourceRefusal) -> String {
    match refusal {
        ResourceRefusal::OutsideManagedScope { root, detail } => {
            format!(
                "{} is not a folder this app may write to: {detail}",
                root.display()
            )
        }
        ResourceRefusal::InvalidName {
            field,
            value,
            detail,
        } => {
            // The reason is `name_problem`'s sentence for the clause that refused, not a
            // restatement of the field's name: "cannot be used as characterId" tells a user
            // nothing they can act on, and this sentence is the last thing between them and a
            // character. A name that was refused because the library could not *read* it never
            // reaches this arm — that is `NoSource` or `Io`, and it says so in its own words.
            format!("{value} cannot be used as {field}: {detail}")
        }
        ResourceRefusal::NoSource { path } => {
            format!(
                "{} is not a file or a folder this app can read",
                path.display()
            )
        }
        ResourceRefusal::Package {
            name,
            problem,
            detail,
        } => format!(
            "{name} cannot be imported ({}): {detail}",
            package_problem(*problem)
        ),
        ResourceRefusal::Unrecognized { name } => {
            format!("{name} is not a file type this app can identify from its own contents")
        }
        ResourceRefusal::Budget { rule, limit, found } => {
            format!("the pack breaks the {rule} budget: {found} where the limit is {limit}")
        }
        ResourceRefusal::MalformedManifest { detail } => {
            format!("the pack's pet.json is not readable as one: {detail}")
        }
        ResourceRefusal::NoSheet => "the pack holds no spritesheet".to_string(),
        ResourceRefusal::AmbiguousSheet { names } => format!(
            "the pack holds more than one spritesheet ({}); a character is drawn from one",
            names.join(", ")
        ),
        ResourceRefusal::AlreadyInstalled { character_id } => {
            format!("a character called {character_id} is already installed")
        }
        ResourceRefusal::NotInstalled { character_id } => {
            format!("no character called {character_id} is installed")
        }
        ResourceRefusal::Unmanaged { character_id } => format!(
            "{character_id} is in the library without a record this build wrote, so it cannot be \
             removed or drawn"
        ),
        ResourceRefusal::Io { path, detail } => {
            format!("{} could not be read or written: {detail}", path.display())
        }
    }
}

/// What a pack refused a file *for*, in a sentence.
fn package_problem(problem: PackageProblem) -> &'static str {
    match problem {
        PackageProblem::Archive => "an archive is not unpacked",
        PackageProblem::Symlink => "a link is not followed",
        // The category, not the reason: which clause refused is in the refusal's own `detail`,
        // and this arm has to stay true for all of them (a separator, a leading dot, a control
        // character, a name that is too long).
        PackageProblem::UnusableName => "its name is not a name the library can hold",
        PackageProblem::Directory => "a pack is a flat set of files",
        PackageProblem::Script => "an executable or document is not carried into the library",
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::desktop_pet::resources::CreateRequest;
    use crate::desktop_pet::settings::PetSettingsDomain;

    /// A library root nothing else in this process is using, and the app data directory it lives
    /// under — the same shape `tests/desktop_pet_resources_test/support.rs` builds, so a leftover
    /// from a killed run cannot make the next one pass.
    fn library(label: &str) -> (CharacterLibrary, PathBuf) {
        let data =
            std::env::temp_dir().join(format!("nkw-pet-view-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(&data).expect("a temporary data directory");
        (
            CharacterLibrary::new(&data).expect("an absolute data directory is in scope"),
            data,
        )
    }

    /// A PNG header, and nothing after it. The library reads the IHDR chunk and never the pixels,
    /// so a signature plus the two dimensions is a sheet as far as it is concerned.
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes
    }

    fn install(library: &CharacterLibrary, id: &str, name: &str) -> PathBuf {
        install_named(library, id, name, "sheet.png")
    }

    /// The same install with the sheet's own file name given, which is the third string a user
    /// chooses: their folder, their character's name, and what they called the image inside it.
    fn install_named(
        library: &CharacterLibrary,
        id: &str,
        name: &str,
        sheet_name: &str,
    ) -> PathBuf {
        library
            .create(&CreateRequest {
                character_id: id.to_string(),
                name: name.to_string(),
                kind: CharacterKind::Created,
                installed_at_ms: 1_700_000_000_000,
                sheet_name: sheet_name.to_string(),
                // Divides into the 6x5 grid below, which the library checks: a sheet that does not
                // divide is refused rather than sliced into cells of different sizes.
                sheet: png(60, 50),
                // Not the build's defaults, so a grid that came from the code rather than from
                // the manifest is visible in the answer.
                columns: 6,
                rows: 5,
            })
            .expect("the pack is well formed")
            .character_id;
        library.root().join(id).join(sheet_name)
    }

    /// The `character` domain as a store would read it: the schema's defaults, with the fields a
    /// case is about replaced. Built through the record's own constructor so a field this build
    /// adds to the schema is defaulted here rather than missing.
    fn record(selected: Option<&str>, size: u64) -> PetSettingsRecord {
        let mut record = PetSettingsRecord::defaults(PetSettingsDomain::Character);
        record.values.insert(
            "characterId".to_string(),
            match selected {
                Some(id) => serde_json::Value::String(id.to_string()),
                None => serde_json::Value::Null,
            },
        );
        record
            .values
            .insert("size".to_string(), serde_json::Value::from(size));
        record
    }

    #[test]
    fn a_folder_name_becomes_a_component_and_loses_its_edges() {
        assert_eq!(slug("My Pet! 2"), "my-pet-2");
        assert_eq!(slug("  ...  "), "");
        assert_eq!(slug("a"), "a");
        // Runs of punctuation collapse rather than becoming runs of dashes, so two folders that
        // differ only in punctuation do not become two characters nobody can tell apart.
        assert_eq!(slug("snake__pet"), "snake-pet");
        assert!(slug(&"x".repeat(200)).len() <= MAX_ID_CHARS);
        // The bound is bytes and a Chinese name costs three of them a character, so a generator
        // that counted characters would write an id three times this long — and a name the
        // library then refuses.
        let long_cjk = slug(&"猫".repeat(200));
        assert!(long_cjk.len() <= MAX_ID_CHARS, "{long_cjk}");
        assert!(is_path_component(&long_cjk));
    }

    #[test]
    fn a_folder_named_in_chinese_has_an_id_in_chinese() {
        let (library, _data) = library("cjk-id");
        // The gap D12's report named: a Chinese folder name was refused because "an id is
        // ASCII". An id is a path component, and `喵喵` is one — so the id is the folder's name.
        assert_eq!(free_character_id(&library, "喵喵").expect("an id"), "喵喵");
        assert_eq!(
            free_character_id(&library, "我的猫 2").expect("an id"),
            "我的猫-2"
        );
        // Scripts with case are still lowercased and still lose their punctuation, so nothing
        // about the ids a library already holds moved.
        assert_eq!(
            free_character_id(&library, "Kitty").expect("an id"),
            "kitty"
        );
    }

    #[test]
    fn a_name_with_no_letter_or_digit_in_it_has_no_id_and_says_which_folders_work() {
        let (library, _data) = library("no-id");
        for name in ["…", "!!!", "🐱"] {
            let refusal = free_character_id(&library, name).expect_err("nothing survives the slug");
            assert!(refusal.contains("no letter or digit"), "{refusal}");
            // The sentence must not restate the rule that was removed: nothing here was refused
            // for being outside ASCII, and a user who reads it must not go renaming a folder that
            // was never the problem.
            assert!(!refusal.contains("ASCII"), "{refusal}");
        }
        // 你好 is not one of those cases, and the difference is which of the two rules refused.
        assert_eq!(
            free_character_id(&library, "你好").expect("letters"),
            "你好"
        );
    }

    #[test]
    fn a_character_whose_folder_and_sheet_are_named_in_chinese_is_drawable() {
        let (library, _data) = library("cjk-ready");
        let sheet = install_named(&library, "喵喵", "喵喵", "精灵图.png");

        let answer = appearance(
            &record(Some("喵喵"), 200),
            Motion::DEFAULT,
            BubbleOpacity::DEFAULT,
            BubbleMessage::defaults(),
            BallSize::DEFAULT.value(),
            Some(&library),
        );

        let PetAppearance::Ready {
            character_id,
            name,
            sheet_path,
            ..
        } = answer
        else {
            panic!("a Chinese-named character is drawable: {answer:?}");
        };
        assert_eq!(character_id, "喵喵");
        assert_eq!(name, "喵喵");
        // The path the window is handed is the real one on disk. Turning it into a URL is
        // `convertFileSrc`'s job on the front end, and that percent-encodes — the protocol decodes
        // before it checks the scope, so a non-ASCII path is served like any other.
        assert_eq!(Path::new(&sheet_path), sheet);
        assert!(sheet.is_file());
    }

    #[test]
    fn an_id_that_is_taken_is_suffixed_rather_than_refused() {
        let (library, _data) = library("taken");
        install(&library, "kitty", "Kitty");

        assert_eq!(
            free_character_id(&library, "Kitty").expect("a free variant"),
            "kitty-2"
        );

        // And the same rule in Chinese, which is the case a user meets by importing the folder
        // they already imported: the second one is a character beside the first, not a refusal —
        // and never a second import over the first.
        install(&library, "喵喵", "喵喵");
        assert_eq!(
            free_character_id(&library, "喵喵").expect("a free variant"),
            "喵喵-2"
        );
        assert_eq!(
            free_character_id(&library, "喵喵-3").expect("a free variant"),
            "喵喵-3"
        );
        assert_eq!(library.list().expect("readable").len(), 2);
    }

    #[test]
    fn a_name_the_library_refuses_and_a_pack_it_cannot_read_are_different_sentences() {
        let absent =
            std::env::temp_dir().join(format!("nkw-pet-view-absent-{}", std::process::id()));
        let named = refusal_sentence(&ResourceRefusal::InvalidName {
            field: "characterId",
            value: "喵/喵".to_string(),
            detail: "a name may not contain \"/\": that is the separator between path components"
                .to_string(),
        });
        let unreadable = refusal_sentence(&ResourceRefusal::NoSource { path: absent });

        // Two claims, and the user acts differently on each: rename the folder, or point at one
        // that is there. A sentence that said the second when the first was true would send a
        // user to fix something that was never wrong.
        assert!(named.contains("cannot be used as"), "{named}");
        assert!(named.contains("separator"), "{named}");
        assert!(unreadable.contains("read"), "{unreadable}");
        assert_ne!(named, unreadable);
    }

    #[test]
    fn nothing_chosen_draws_nothing_and_is_not_a_missing_character() {
        let (library, _data) = library("unset");

        assert_eq!(
            appearance(
                &record(None, 200),
                Motion::DEFAULT,
                BubbleOpacity::DEFAULT,
                BubbleMessage::defaults(),
                BallSize::DEFAULT.value(),
                Some(&library),
            ),
            PetAppearance::Unset {
                motion: Motion::DEFAULT,
                bubble_opacity: BubbleOpacity::DEFAULT.value(),
                bubble: BubbleMessage::defaults(),
                ball_size: BallSize::DEFAULT.value(),
            }
        );
    }

    #[test]
    fn an_installed_character_answers_with_its_sheet_and_its_own_grid() {
        let (library, _data) = library("ready");
        let sheet = install(&library, "kitty", "Kitty");

        let answer = appearance(
            &record(Some("kitty"), 200),
            Motion::DEFAULT,
            BubbleOpacity::DEFAULT,
            BubbleMessage::defaults(),
            BallSize::DEFAULT.value(),
            Some(&library),
        );

        let PetAppearance::Ready {
            character_id,
            name,
            sheet_path,
            sheet: grid,
            size,
            idle_mode,
            idle_interval_ms,
            ..
        } = answer
        else {
            panic!("an installed character is drawable: {answer:?}");
        };
        assert_eq!(character_id, "kitty");
        assert_eq!(name, "Kitty");
        assert_eq!(Path::new(&sheet_path), sheet);
        assert_eq!((grid.columns, grid.rows), (6, 5));
        // The drawing facts come from the record the caller passed, not from the code's own
        // defaults: §5.1's size slider and animation mapping have to reach the sprite.
        assert_eq!(size, 200);
        assert_eq!(idle_mode, "random");
        assert_eq!(idle_interval_ms, 5_000);
    }

    #[test]
    fn a_character_that_is_not_installed_is_named_rather_than_emptied() {
        let (library, _data) = library("absent-character");

        let answer = appearance(
            &record(Some("ghost"), 200),
            Motion::DEFAULT,
            BubbleOpacity::DEFAULT,
            BubbleMessage::defaults(),
            BallSize::DEFAULT.value(),
            Some(&library),
        );

        let PetAppearance::Missing {
            character_id,
            detail,
            ..
        } = answer
        else {
            panic!("a choice that cannot be honoured is not a ready one");
        };
        assert_eq!(character_id, "ghost");
        assert!(detail.contains("not installed"), "{detail}");
    }

    #[test]
    fn a_character_whose_sheet_is_gone_is_missing_and_not_ready() {
        let (library, _data) = library("damaged");
        let sheet = install(&library, "kitty", "Kitty");
        std::fs::remove_file(&sheet).expect("the sheet is there to remove");

        let answer = appearance(
            &record(Some("kitty"), 200),
            Motion::DEFAULT,
            BubbleOpacity::DEFAULT,
            BubbleMessage::defaults(),
            BallSize::DEFAULT.value(),
            Some(&library),
        );

        let PetAppearance::Missing { detail, .. } = answer else {
            panic!("the sheet is not there to draw");
        };
        assert!(detail.contains("sheet.png"), "{detail}");
    }

    #[test]
    fn a_manifest_that_names_a_path_does_not_become_one() {
        let (library, _data) = library("traversal");
        install(&library, "kitty", "Kitty");
        // The manifest is a file on disk, so this is what a hand-edited one looks like: a sheet
        // name that is a path. It is refused as a name, not joined onto the library's root.
        let manifest = library.root().join("kitty").join("manifest.json");
        let mut document: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&manifest).expect("the manifest is there"),
        )
        .expect("it is JSON");
        document["sheet"]["file"] = serde_json::Value::String("../outside.png".to_string());
        std::fs::write(&manifest, document.to_string()).expect("the manifest is writable");

        let answer = appearance(
            &record(Some("kitty"), 200),
            Motion::DEFAULT,
            BubbleOpacity::DEFAULT,
            BubbleMessage::defaults(),
            BallSize::DEFAULT.value(),
            Some(&library),
        );

        let PetAppearance::Missing { detail, .. } = answer else {
            panic!("a name that is a path is not a file");
        };
        assert!(detail.contains("outside the library"), "{detail}");
    }

    #[test]
    fn an_app_with_no_library_still_names_the_character_it_cannot_produce() {
        assert!(
            matches!(
                appearance(
                    &record(Some("kitty"), 200),
                    Motion::DEFAULT,
                    BubbleOpacity::DEFAULT,
                    BubbleMessage::defaults(),
                    BallSize::DEFAULT.value(),
                    None
                ),
                PetAppearance::Missing { .. }
            ),
            "no library is a reason, not an absence of a choice"
        );
    }

    #[test]
    fn the_listing_carries_the_packs_name_and_whether_it_can_be_drawn() {
        let (library, _data) = library("listing");
        let sheet = install(&library, "kitty", "Kitty");

        let intact = entries(&library).expect("the library is readable");
        assert_eq!(intact.len(), 1);
        assert_eq!(intact[0].character_id, "kitty");
        assert_eq!(intact[0].pack_name, "Kitty");
        assert_eq!(intact[0].files, PetCharacterFiles::Intact);
        assert_eq!(intact[0].kind, CharacterKind::Created);
        assert_eq!(intact[0].installed_at_ms, 1_700_000_000_000);

        std::fs::remove_file(sheet).expect("the sheet is there to remove");
        let damaged = entries(&library).expect("the library is readable");
        assert_eq!(damaged[0].files, PetCharacterFiles::Damaged);
    }

    #[test]
    fn the_refusal_sentences_name_the_thing_that_refused() {
        // Two of the refusals a user can actually meet on the import path, so "the wording exists"
        // is asserted rather than assumed: a page shows these strings and nothing maps them.
        let no_sheet = refusal_sentence(&ResourceRefusal::NoSheet);
        assert!(no_sheet.contains("spritesheet"), "{no_sheet}");

        let named = refusal_sentence(&ResourceRefusal::Package {
            name: "evil.png".to_string(),
            problem: PackageProblem::UnusableName,
            detail: "a name may not contain \"/\"".to_string(),
        });
        // The file that was refused, and both halves of why: the category a page groups by, and
        // the clause of the rule that actually refused.
        assert!(named.contains("evil.png"), "{named}");
        assert!(named.contains("the library can hold"), "{named}");
        assert!(named.contains("may not contain"), "{named}");
    }

    /// A `general` record with one motion value written into it, or none.
    fn general(motion: Option<&str>) -> PetSettingsRecord {
        let mut record = PetSettingsRecord::defaults(PetSettingsDomain::General);
        match motion {
            Some(value) => {
                record.values.insert(
                    "motion".to_string(),
                    serde_json::Value::String(value.to_string()),
                );
            }
            // Removed rather than set to the default, because "absent" is a state of its own: a
            // record an older build wrote carries no such field at all.
            None => {
                record.values.remove("motion");
            }
        }
        record
    }

    #[test]
    fn a_policy_a_window_cannot_act_on_is_read_as_the_schemas_default() {
        // The store normalizes a record on the way out of the file, so an unrecognised member is
        // one nothing wrote — and the arm for it is the schema's default rather than a guess. The
        // one that matters: `reduced` invents a restriction if it is wrong, so a value that is
        // *not* `reduced` must never be read as it.
        assert_eq!(Motion::of(&general(Some("reduced"))), Motion::Reduced);
        assert_eq!(Motion::of(&general(Some("system"))), Motion::System);
        assert_eq!(Motion::of(&general_with_ball_size(None)), Motion::System);
        assert_eq!(Motion::of(&general(Some("less"))), Motion::System);
        assert_eq!(Motion::of(&general(Some(""))), Motion::System);
    }

    #[test]
    fn the_policy_rides_every_appearance_arm_because_the_ball_draws_in_all_of_them() {
        let (library, _data) = library("motion-arms");
        install(&library, "kitty", "Kitty");
        let reduced = Motion::Reduced;

        // `Unset` is a fresh install, where the ball draws upstream's plain orb — and the orb is
        // the surface this build has that moves, so a policy that only arrived with `Ready` would
        // leave exactly the state a new user is in unreduced.
        assert!(matches!(
            appearance(
                &record(None, 200),
                reduced,
                BubbleOpacity::DEFAULT,
                BubbleMessage::defaults(),
                BallSize::DEFAULT.value(),
                Some(&library),
            ),
            PetAppearance::Unset { motion, .. } if motion == reduced
        ));
        assert!(matches!(
            appearance(
                &record(Some("ghost"), 200),
                reduced,
                BubbleOpacity::DEFAULT,
                BubbleMessage::defaults(),
                BallSize::DEFAULT.value(),
                Some(&library)
            ),
            PetAppearance::Missing { motion, .. } if motion == reduced
        ));
        assert!(matches!(
            appearance(
                &record(Some("kitty"), 200),
                reduced,
                BubbleOpacity::DEFAULT,
                BubbleMessage::defaults(),
                BallSize::DEFAULT.value(),
                Some(&library)
            ),
            PetAppearance::Ready { motion, .. } if motion == reduced
        ));
    }

    /// A `message` record with one opacity written into it, or none.
    fn message(opacity: Option<f64>) -> PetSettingsRecord {
        let mut record = PetSettingsRecord::defaults(PetSettingsDomain::Message);
        match opacity {
            Some(value) => {
                record
                    .values
                    .insert("opacity".to_string(), serde_json::Value::from(value));
            }
            // Removed rather than set to the default, because "absent" is a state of its own: a
            // record an older build wrote carries no such field at all.
            None => {
                record.values.remove("opacity");
            }
        }
        record
    }

    #[test]
    fn an_alpha_a_window_cannot_act_on_is_read_as_the_schemas_default() {
        // The store normalized this record on the way out of the file (`settings::values`), so a
        // value that is *there* is a value the rule accepted — including the ends, which is what
        // `assert_eq!(…, 1.0)` below is about. What a record cannot carry is a *missing* field
        // (an older build's file, or one this build's schema has not written yet), and that arm is
        // the schema's declared default rather than a guess. The one that matters: the value the
        // user never chose must never be a *clearer* bubble than the one they did.
        assert_eq!(BubbleOpacity::of(&message(Some(0.7))).value(), 0.7);
        assert_eq!(
            BubbleOpacity::of(&message(Some(1.0))).value(),
            1.0,
            "the rule's own ceiling is inside it, and a store read never hands out a value the \
             rule refused — `bubble.rs` covers the file that carries one anyway"
        );
        assert_eq!(
            BubbleOpacity::of(&message(None)).value(),
            BubbleOpacity::DEFAULT.value()
        );
        assert_eq!(
            BubbleOpacity::DEFAULT.value(),
            PetSettingsRecord::defaults(PetSettingsDomain::Message)
                .value("opacity")
                .and_then(serde_json::Value::as_f64)
                .expect("the schema declares a default for it"),
            "the constant is the schema's own default, not a second copy of the number"
        );
    }

    /// A `general` record with one field chosen, and the ball size left out when the caller asks for
    /// that — the same fixture `message` is, one domain over. Named apart from `general` above,
    /// which is the motion policy's fixture and answers a different question.
    fn general_with_ball_size(ball_size: Option<i64>) -> PetSettingsRecord {
        let mut record = PetSettingsRecord::defaults(PetSettingsDomain::General);
        match ball_size {
            Some(size) => {
                record
                    .values
                    .insert("ballSize".to_string(), serde_json::Value::from(size));
            }
            None => {
                record.values.remove("ballSize");
            }
        }
        record
    }

    /// The ball's size at both ends: a value the store read is a value the rule accepted, and a
    /// record without the field — an older build's file — is the schema's own default rather than a
    /// guess.
    #[test]
    fn a_ball_size_a_window_cannot_act_on_is_read_as_the_schemas_default() {
        assert_eq!(
            BallSize::of(&general_with_ball_size(Some(32))).value(),
            32.0
        );
        assert_eq!(
            BallSize::of(&general_with_ball_size(Some(128))).value(),
            128.0,
            "the rule's own ceiling"
        );
        assert_eq!(
            BallSize::of(&general_with_ball_size(None)).value(),
            BallSize::DEFAULT.value()
        );
        assert_eq!(
            BallSize::DEFAULT.value(),
            PetSettingsRecord::defaults(PetSettingsDomain::General)
                .value("ballSize")
                .and_then(serde_json::Value::as_f64)
                .expect("the schema declares a default for it"),
            "the constant is the schema's own default, not a second copy of the number"
        );
        assert_eq!(
            BallSize::DEFAULT.value(),
            super::super::ball::ball_window_size(super::super::ball::BALL_DEFAULT_SIZE).0 - 24.0,
            "and it is the orb upstream's 80 px window was built around"
        );
    }

    /// **The ball's size rides every arm**, for the reason the policy and the alpha do: the ball is
    /// on the desktop whether or not a character is chosen, and its size is neither the character's
    /// nor a fact that arrives with one. A window handed nothing would draw an orb at this build's
    /// constant while the host had built its window around the user's number — the two answers §9
    /// forbids, one field over.
    #[test]
    fn the_ball_size_rides_every_appearance_arm_because_the_ball_is_drawn_in_all_of_them() {
        let (library, _data) = library("ball-size-arms");
        install(&library, "kitty", "Kitty");
        let size = BallSize::of(&general_with_ball_size(Some(96)));

        assert!(matches!(
            appearance(
                &record(None, 200),
                Motion::DEFAULT,
                BubbleOpacity::DEFAULT,
                BubbleMessage::defaults(),
                size.value(),
                Some(&library)
            ),
            PetAppearance::Unset { ball_size, .. } if ball_size == 96.0
        ));
        assert!(matches!(
            appearance(
                &record(Some("ghost"), 200),
                Motion::DEFAULT,
                BubbleOpacity::DEFAULT,
                BubbleMessage::defaults(),
                size.value(),
                Some(&library)
            ),
            PetAppearance::Missing { ball_size, .. } if ball_size == 96.0
        ));
        assert!(matches!(
            appearance(
                &record(Some("kitty"), 200),
                Motion::DEFAULT,
                BubbleOpacity::DEFAULT,
                BubbleMessage::defaults(),
                size.value(),
                Some(&library)
            ),
            PetAppearance::Ready { ball_size, .. } if ball_size == 96.0
        ));
    }

    #[test]
    fn the_bubble_alpha_rides_every_appearance_arm_because_the_bubble_is_drawn_in_all_of_them() {
        let (library, _data) = library("bubble-arms");
        install(&library, "kitty", "Kitty");
        let alpha = BubbleOpacity::of(&message(Some(0.7)));

        // The bubble is drawn above the notice and above a sprite alike — a window with no character
        // is still a window the pet says things in — so an alpha that only arrived with `Ready`
        // would leave a fresh install drawing a bubble the user never chose.
        assert!(matches!(
            appearance(
                &record(None, 200),
                Motion::DEFAULT,
                alpha,
                BubbleMessage::defaults(),
                BallSize::DEFAULT.value(),
                Some(&library)
            ),
            PetAppearance::Unset { bubble_opacity, .. } if bubble_opacity == 0.7
        ));
        assert!(matches!(
            appearance(
                &record(Some("ghost"), 200),
                Motion::DEFAULT,
                alpha,
                BubbleMessage::defaults(),
                BallSize::DEFAULT.value(),
                Some(&library)
            ),
            PetAppearance::Missing { bubble_opacity, .. } if bubble_opacity == 0.7
        ));
        assert!(matches!(
            appearance(
                &record(Some("kitty"), 200),
                Motion::DEFAULT,
                alpha,
                BubbleMessage::defaults(),
                BallSize::DEFAULT.value(),
                Some(&library)
            ),
            PetAppearance::Ready { bubble_opacity, .. } if bubble_opacity == 0.7
        ));
    }
}
