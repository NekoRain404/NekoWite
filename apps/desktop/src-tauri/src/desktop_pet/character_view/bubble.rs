//! §5.2's 气泡与消息 as the surface draws it: what the bubble shows, and how.
//!
//! **Why this is a module of its own.** The `message` domain is one reason to change, and both
//! facts this tree reads out of it belong to it: the alpha the bubble is drawn at
//! ([`BubbleOpacity`]) and the content model and layout a row is drawn with ([`BubbleMessage`]).
//! Neither is the character's, and neither is the character *record*'s — a bubble is drawn above a
//! notice and above a sprite alike — so they rode `character_view.rs`'s appearance read for a
//! reason of their own until the file passed the 600-line backlog `docs/dev.md:286` names.
//!
//! **Why reading the domain is done here rather than by the window.** `capabilities/desktop-pet.json`
//! holds no settings read, so a pet window cannot ask for the domain itself; without this the whole
//! of 气泡与消息 was a page whose values were stored and never drawn with. The two `stored_*`
//! functions below are the one read [`super::drawing::appearance`]'s caller performs, and they are
//! functions rather than three lines in the command because a test asserting what a window is handed
//! should go through the same arm — the alternative is a second copy of the rule that the two can
//! drift apart on.
//!
//! It moves when the `message` domain's schema does: a field a surface draws with is added here and
//! in `settings/fields.rs` together, and a field no surface draws with is deliberately not added
//! (§6.1's rule of least — a wire field with no reader is the shape this change exists to avoid).

use serde::Serialize;

use super::super::settings::{PetSettingsDomain, PetSettingsRecord, PetSettingsStore};

/// The bubble's background alpha, from `message.opacity` (§5.2's 气泡与消息).
///
/// The third fact that rides this read and is not the character's, and it rides it for the reason
/// [`super::motion::Motion`] does: the bubble is one of the surfaces in the window that draws the character
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
/// [`super::motion::stored_motion`] is: a test asserting what a window is handed goes through the same arm.
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
/// for the same reason [`super::motion::Motion::DEFAULT`] is: the bubble is drawn either way, and a layout the user
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
    ///
    /// `pub(crate)` rather than private because the behaviour files beside the sibling modules hand
    /// a bubble to [`super::drawing::appearance`] to ask whether *their* fact rides every arm — they
    /// are not about what this value holds, and a second builder in a test helper is the copy that
    /// drifts. Nothing outside this crate can reach it: the wire carries the struct, not the
    /// constructor.
    pub(crate) fn defaults() -> Self {
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
/// The second read of the `message` domain, and a function for the reason [`super::motion::stored_motion`] is: a
/// test asserting what a window is handed goes through the same arm.
pub fn stored_bubble_message(store: &PetSettingsStore) -> BubbleMessage {
    store
        .read(PetSettingsDomain::Message)
        .record()
        .map_or_else(BubbleMessage::defaults, BubbleMessage::of)
}

#[cfg(test)]
mod tests;
