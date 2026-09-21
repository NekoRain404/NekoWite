//! The one character the pet window draws, or why it draws nothing.
//!
//! **Why this is a module of its own.** The window's whole answer — the spritesheet's path and
//! grid, the rendered size, the animation mapping, and the four states a character can be in — is
//! read by one caller and moves with that wire, while the picker's *list* moves with a page. Both
//! were in `character_view.rs`, and the file passed the 600-line backlog `docs/dev.md:286` names
//! with them; the list is [`super::listing`] and this is the drawing. Its tests are the behaviour
//! file beside it (`character_view/drawing/tests.rs`) for the reason `url_policy/tests.rs` states:
//! the drawing is the largest piece of the split, and its cases are about a state machine of four
//! arms rather than about one function.
//!
//! Three rules are structural here rather than documented, because a rule that lives only in prose
//! is a rule the next component can forget:
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
//! - **A read that could not happen at all is an `Err`, not a fourth arm.** The caller's own
//!   failure is reported by the window's notice, in the host's words, rather than invented here as
//!   a character state.
//!
//! It moves when the pet window's wire shape or the `character` domain's drawing fields do — one
//! field on both sides together, which is why [`Drawing`] and [`PetAppearance::Ready`] are in one
//! file rather than two.

use std::path::PathBuf;

use serde::Serialize;

use super::super::resources::{is_path_component, CharacterLibrary, EntryState};
use super::super::settings::PetSettingsRecord;
use super::bubble::{BubbleMessage, BubbleOpacity};
use super::motion::Motion;
use super::refusal::refusal_sentence;

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
        /// The bubble's content model and layout — see [`super::bubble::BubbleMessage`]. On every arm for the
        /// reason `bubble_opacity` is: the surface is drawn in all three of them.
        bubble: BubbleMessage,
        /// The floating ball's diameter (`general.ballSize`), which is not the character's either:
        /// the ball is a window of its own and it is on the desktop with no character chosen at all.
        /// On every arm for the reason [`super::motion::Motion`] is.
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
        /// [`super::bubble::BubbleOpacity`]. On every arm for the same reason `motion` is: the bubble is drawn by
        /// this window in all three of them, a fresh install included.
        #[serde(rename = "bubbleOpacity")]
        bubble_opacity: f64,
        /// The bubble's content model and layout — see [`super::bubble::BubbleMessage`].
        bubble: BubbleMessage,
        /// See [`PetAppearance::Unset`]'s own pair.
        #[serde(rename = "ballSize")]
        ball_size: f64,
    },
}

/// What the pet window draws for the character a settings record names.
///
/// The whole record rather than just the id, because the drawing facts are fields of it. `library`
/// is `None` when this build could not open one at all, which is the same class of answer as a
/// character that is not installed: the choice exists and cannot be honoured, and the reason
/// differs only in the sentence.
///
/// `motion` is the `general` record's policy rather than a field of this one — see [`super::motion::Motion`] for
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

#[cfg(test)]
mod tests;
