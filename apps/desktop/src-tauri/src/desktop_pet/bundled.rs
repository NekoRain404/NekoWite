//! The character this build ships, and the one act that puts it in a fresh install.
//!
//! §8's 角色库 describes a library a user fills: import a pack, or (one day) adopt one from a
//! catalogue. Both start from *something the user already has*, and neither answers the state a
//! new install is actually in — an empty library and a settings file that names nothing, which
//! together draw a sentence where the pet should be. This module is that answer, and it is the
//! only place in the pet's tree where a character the user did not bring arrives.
//!
//! **What it ships is a drawing, not a download.** [`SHEET`] is compiled into the binary, and
//! the picture is authored by this repository (`bundled/make_default_character.py` is its whole
//! provenance — see that file's own header). That is the licence position, and it is the reason
//! this is not a catalogue: the two community catalogues this project could reach state no terms
//! for any of their entries, so §8's 「不把下载成功当授权证明」 would refuse every one of them, and a
//! gallery of four thousand un-adoptable rows is not a feature. A character we drew has terms we
//! can state, and it is there on a machine that has never had a network.
//!
//! **Installed through the library, not beside it.** [`seed`] calls
//! [`CharacterLibrary::create`], so the shipped character goes through the same validation, the
//! same budgets, the same manifest and the same single-rename commit as an imported pack (§3.3's
//! rule that a second path is a second answer). Nothing here writes into the library directory
//! itself, and the result is indistinguishable from a character the user made from one sheet —
//! which is also what makes it removable.
//!
//! **Once, and remembered.** [`MARKER`] at the library's root is the whole of "this data
//! directory has been offered its shipped character". Without it a user who removed the pet
//! would find it back the next time the app started, which is §4's unrecoverable shape: a
//! deletion the app quietly undoes. The marker is a file and not a character directory, and
//! [`CharacterLibrary::list`] skips both reserved names and non-directories, so it is invisible
//! to every read of the library — it is not an index of what is installed, which is the second
//! list `resources.rs` refuses to keep.
//!
//! **Why the selection is written here and not in the appearance command.** A fresh install's
//! `character.characterId` is null, and null is also what "use no character" stores — the record
//! cannot tell those apart, but the *file* can: a first run has no record at all. So the write
//! below happens only for [`DefaultsReason::Absent`], and a user who chose no character keeps
//! that choice. Doing it in the appearance read instead would have needed the read to write, and
//! would have had no way to see the difference.

use std::fs;
use std::path::Path;

use serde_json::json;

use super::character_view::free_character_id;
use super::resources::{CharacterKind, CharacterLibrary, CreateRequest};
use super::settings::{
    DefaultsReason, PetSettingsDomain, PetSettingsLoad, PetSettingsStore, PetSettingsUpdate,
    PetSettingsWrite,
};

/// The sheet, as bytes in the binary.
///
/// Compiled in rather than shipped as a Tauri resource: a resource is a path, a path needs a
/// resolver, a resolver fails differently per install layout, and a file on disk would then need
/// an `asset://` grant of its own. Bytes here go through the library and become an ordinary
/// character, so the only `asset://` grant is the one every character already gets.
const SHEET: &[u8] = include_bytes!("bundled/default-character.png");

/// What the sheet is stored as inside the character's directory.
const SHEET_FILE: &str = "spritesheet.png";

/// The grid the sheet is drawn on. Held to the renderer's own by
/// `the_bundled_sheet_is_the_grid_the_renderer_slices`, which reads both off disk.
const SHEET_COLUMNS: u32 = 8;
const SHEET_ROWS: u32 = 9;

/// The id the character is installed under, and the name a user reads.
///
/// `neko` rather than a file name: an id is a path component, and this one is short, stable and
/// something a person would not be surprised to find in their library.
pub const BUNDLED_CHARACTER_ID: &str = "neko";
pub const BUNDLED_CHARACTER_NAME: &str = "Neko";

/// The file whose presence means this data directory has already been offered its character.
///
/// Leading dot, so it is a reserved name and no character can be mistaken for it — the same
/// rule that keeps a character from being mistaken for staging debris.
const MARKER: &str = ".bundled-character";

/// What one call to [`seed`] did, so a test can tell the four outcomes apart rather than
/// inferring them from a directory listing.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Seeded {
    /// The marker was there: this data directory has been offered its character before, and
    /// nothing was read, written or checked.
    AlreadyOffered,
    /// The character was installed and the selection written, because nobody had chosen.
    Installed {
        character_id: String,
        selected: bool,
    },
    /// The character was installed and the selection left alone, because the settings already
    /// held a record — a user who has used the app keeps whatever they chose.
    InstalledOnly { character_id: String },
}

/// Install the shipped character into `library`, once, and choose it on a first run.
///
/// The four things it will not do, each because the alternative is a defect this tree already
/// has a rule against:
///
/// - It does not reinstall over a character the user removed (§4). The marker decides.
/// - It does not adopt an id another character holds: a library that already has a `neko` gets
///   this one under a free id, the way `desktop_pet_import_character` suffixes rather than
///   refusing, so the suffix here can never silently select somebody else's character.
/// - It does not overwrite a selection. Only a settings domain with no record on disk is
///   written, which is what [`DefaultsReason::Absent`] means.
/// - It does not report success it did not have: a failure leaves the marker unwritten, so the
///   next launch tries again rather than the app deciding once and being wrong for ever.
pub fn seed(
    library: &CharacterLibrary,
    data_dir: &Path,
    installed_at_ms: u64,
) -> Result<Seeded, String> {
    let marker = library.root().join(MARKER);
    if marker.exists() {
        return Ok(Seeded::AlreadyOffered);
    }

    let character_id = match install(library, installed_at_ms) {
        Ok(character_id) => character_id,
        Err(detail) => return Err(detail),
    };

    let store = PetSettingsStore::new(data_dir)?;
    let selected = match select(&store, &character_id) {
        Ok(selected) => selected,
        Err(detail) => return Err(detail),
    };

    // The commit point of the whole act. Written last and written atomically, so a launch that
    // failed between the install and here re-runs both next time — and both are idempotent
    // about what they find, which is what makes re-running them the safe answer.
    if let Err(error) = atomic_write(&marker, "1") {
        return Err(format!(
            "the shipped character's marker could not be written: {error}"
        ));
    }

    Ok(if selected {
        Seeded::Installed {
            character_id,
            selected: true,
        }
    } else {
        Seeded::InstalledOnly { character_id }
    })
}

/// Put the sheet into the library, under [`BUNDLED_CHARACTER_ID`] when it is free.
///
/// `AlreadyInstalled` is not a failure: a library that already holds an entry under that id has
/// one because a previous launch installed it, or because the user imported something with the
/// same name — and the two are told apart by taking a free id rather than by assuming.
fn install(library: &CharacterLibrary, installed_at_ms: u64) -> Result<String, String> {
    let character_id = if library
        .list()
        .map_err(|refusal| format!("the character library could not be read: {refusal:?}"))?
        .iter()
        .any(|entry| entry.character_id == BUNDLED_CHARACTER_ID)
    {
        free_character_id(library, BUNDLED_CHARACTER_ID)?
    } else {
        BUNDLED_CHARACTER_ID.to_string()
    };
    library
        .create(&CreateRequest {
            character_id: character_id.clone(),
            name: BUNDLED_CHARACTER_NAME.to_string(),
            kind: CharacterKind::Created,
            installed_at_ms,
            sheet_name: SHEET_FILE.to_string(),
            sheet: SHEET.to_vec(),
            columns: SHEET_COLUMNS,
            rows: SHEET_ROWS,
        })
        .map_err(|refusal| format!("the shipped character could not be installed: {refusal:?}"))?;
    Ok(character_id)
}

/// Choose `character_id` if, and only if, nobody has ever written the character domain.
///
/// Returns whether the write happened. The revision written is the one the absent read
/// produced, because a write is only accepted at the revision it was based on (§5.3) and the
/// defaults record is exactly what this was based on.
fn select(store: &PetSettingsStore, character_id: &str) -> Result<bool, String> {
    let PetSettingsLoad::Defaults {
        reason: DefaultsReason::Absent,
        record,
    } = store.read(PetSettingsDomain::Character)
    else {
        // Current, migrated, unreadable or read-only: all four are somebody else's state, and
        // none of them is a first run. §10.2's read-only arm in particular must not be written.
        return Ok(false);
    };
    // The one field this act is about, set on the values the read produced rather than on a
    // record assembled here: every other field keeps what the schema's own rule gave it, so
    // this cannot become a second place the defaults are written down (§5.3).
    let mut values = record.values.clone();
    values.insert("characterId".to_string(), json!(character_id));
    let write = PetSettingsWrite {
        domain: PetSettingsDomain::Character,
        revision: record.revision as f64,
        values: serde_json::Value::Object(values),
    };
    match store.apply(&write) {
        PetSettingsUpdate::Applied { .. } => Ok(true),
        other => Err(format!(
            "the shipped character could not be selected: {other:?}"
        )),
    }
}

/// Write a file by putting a complete one in its place, never by truncating the target.
///
/// The same shape `settings/store.rs` uses: a reader that sees the path sees either nothing or
/// the whole file, and a process that dies mid-write leaves no half-a-marker that would mean
/// "already offered" to the next launch.
fn atomic_write(path: &Path, text: &str) -> Result<(), String> {
    let temporary = path.with_extension("part");
    fs::write(&temporary, text).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}
