//! The character this build ships, and what a fresh install does with it.
//!
//! The complaint this answers is about what a user *sees*, so the cases below are about the three
//! states a user can be in rather than about the drawing:
//!
//! - **A fresh install draws something.** Not "the library has a row" — the appearance read a
//!   window performs is asserted to come back `Ready` with a path that is a real file, because a
//!   library entry and a drawn pet are different claims and only the second is the feature.
//! - **A user's choice is theirs.** Three separate states have to survive a launch: a character
//!   the user removed is not put back, a selection the user made is not overwritten, and an id the
//!   user already used is not taken away from them. Each has a case, and each is reached by doing
//!   the thing through the public API first and then starting the app again.
//! - **The sheet is the one the renderer slices.** The grid is read off `sprite-slicer.ts` rather
//!   than restated here, the way `the_sheet_grid_is_the_renderers_own` reads it: two constants
//!   that have to agree, written in one language each, is the defect the assertion removes. The
//!   sheet's own pixels are measured from its IHDR, so a generator that changed the cell size
//!   without changing the grid fails here rather than drawing one frame out of alignment.
//!
//! Nothing here reaches `lib.rs`'s startup. `seed` is called directly, which is what makes the
//! once-only rule testable at all: a test that started the whole app could only observe the first
//! launch.

use std::path::{Path, PathBuf};

use nekowite_lib::desktop_pet::bundled::{seed, Seeded, BUNDLED_CHARACTER_ID};
use nekowite_lib::desktop_pet::character_view::{
    appearance, entries, stored_bubble_message, stored_bubble_opacity, stored_motion,
};
use nekowite_lib::desktop_pet::resources::{
    CharacterKind, CharacterLibrary, EntryState, InstallRequest,
};
use nekowite_lib::desktop_pet::settings::{
    PetSettingsDomain, PetSettingsLoad, PetSettingsRecord, PetSettingsStore, PetSettingsWrite,
};
use nekowite_lib::desktop_pet::window_host::stored_ball_size;

/// The cell the shipped sheet is drawn at, which is the sprite box `PetSprite.vue` mounts.
const CELL: (u32, u32) = (160, 180);

/// A data directory nothing else in the process is using.
///
/// Named after the test and removed first, so a leftover from a killed run cannot make the next
/// one pass — the failure mode the resources suite's own helper avoids the same way.
fn data_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-pet-bundled-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temporary data directory");
    dir
}

fn library_in(dir: &Path) -> CharacterLibrary {
    CharacterLibrary::new(dir).expect("an absolute data directory is in scope")
}

/// The PNG's own header, as `resources::media` reads it: the two dimensions, and nothing else.
fn png_size(bytes: &[u8]) -> (u32, u32) {
    assert_eq!(
        &bytes[..8],
        b"\x89PNG\r\n\x1a\n",
        "the shipped sheet is a PNG"
    );
    assert_eq!(&bytes[12..16], b"IHDR", "the shipped sheet has an IHDR");
    (
        u32::from_be_bytes(bytes[16..20].try_into().expect("four bytes")),
        u32::from_be_bytes(bytes[20..24].try_into().expect("four bytes")),
    )
}

/// The renderer's grid, read off the TypeScript rather than restated here.
fn renderer_grid() -> (u32, u32) {
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/features/desktop-pet/rendering/sprite-slicer.ts");
    let text = std::fs::read_to_string(&source)
        .unwrap_or_else(|error| panic!("{} is the renderer's slicer: {error}", source.display()));
    let read = |name: &str| -> u32 {
        let at = text
            .find(&format!("{name} = "))
            .unwrap_or_else(|| panic!("{name} is not in the slicer"))
            + name.len()
            + 3;
        text[at..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .unwrap_or_else(|error| panic!("{name} is not a number: {error}"))
    };
    (read("FIXED_GRID_COLS"), read("FIXED_GRID_ROWS"))
}

/// The character id the library ended up holding, when it holds exactly one.
fn only_character(library: &CharacterLibrary) -> String {
    let listed = entries(library).expect("the library reads");
    assert_eq!(listed.len(), 1, "exactly one character, found {listed:?}");
    listed[0].character_id.clone()
}

#[test]
fn a_fresh_install_has_a_character_to_draw() {
    let dir = data_dir("fresh");
    let library = library_in(&dir);

    assert_eq!(
        entries(&library).expect("an empty library reads").len(),
        0,
        "nothing is in a library nobody has written to"
    );

    let outcome = seed(&library, &dir, 1_700_000_000_000).expect("the shipped character installs");
    assert_eq!(
        outcome,
        Seeded::Installed {
            character_id: BUNDLED_CHARACTER_ID.to_string(),
            selected: true
        },
        "a first run installs the shipped character and chooses it"
    );

    // The claim that matters: the read a pet window performs answers with a sheet, not a
    // sentence. A library entry and a drawn pet are different things and only this is the fix.
    let store = PetSettingsStore::new(&dir).expect("the settings store opens");
    let record = store
        .read(PetSettingsDomain::Character)
        .record()
        .expect("a record after the selection")
        .clone();
    // The motion policy rides the same answer, and this read is the one the command performs:
    // `general` is the domain a pet window may not read for itself, so the appearance carries it.
    // Nothing has written `general` here, so it is the schema's own default.
    let motion = stored_motion(&store);
    // And the bubble's alpha, which `message` stores and this window draws with: nothing has
    // written that domain either, so it is the schema's own default — the same arm the motion
    // policy takes, because both are facts a pet window may not read for itself.
    let bubble = stored_bubble_opacity(&store);
    // And the rest of that domain — the bubble's content model and layout, which the same window
    // draws with and may not read for itself either. Nothing has written `message` here, so this is
    // the schema's own default.
    let bubble_message = stored_bubble_message(&store);
    // And the ball's size, the third fact of that kind: `general.ballSize`, which the ball's page
    // draws its orb at. Nothing has written `general` here, so this is the schema's own default too.
    let ball_size = stored_ball_size(&store);
    match appearance(
        &record,
        motion,
        bubble,
        bubble_message,
        ball_size,
        Some(&library),
    ) {
        nekowite_lib::desktop_pet::PetAppearance::Ready { sheet_path, .. } => {
            assert!(
                Path::new(&sheet_path).is_file(),
                "{sheet_path} is the sheet the window was handed"
            );
        }
        other => panic!("a fresh install draws nothing: {other:?}"),
    }
}

#[test]
fn the_shipped_sheet_is_the_grid_the_renderer_slices() {
    let dir = data_dir("grid");
    let library = library_in(&dir);
    seed(&library, &dir, 1).expect("the shipped character installs");

    let character_id = only_character(&library);
    let sheet = library.root().join(&character_id).join("spritesheet.png");
    let bytes = std::fs::read(&sheet).expect("the sheet is on disk");
    let (width, height) = png_size(&bytes);
    let (cols, rows) = renderer_grid();

    // Every cell exactly the sprite box, so a frame is drawn at the size it was authored at and
    // the slicer's arithmetic lands on cell boundaries.
    assert_eq!(
        (width, height),
        (cols * CELL.0, rows * CELL.1),
        "the sheet is {cols}x{rows} cells of {}x{}",
        CELL.0,
        CELL.1
    );

    // And the manifest the library wrote records the same grid, which is what the appearance read
    // hands the window. A sheet of the right size with the wrong recorded grid slices the right
    // pixels into the wrong clips.
    let listed = library.list().expect("the library reads");
    let manifest = listed[0]
        .manifest
        .as_ref()
        .expect("the library wrote a manifest");
    assert_eq!((manifest.sheet.columns, manifest.sheet.rows), (cols, rows));
    assert_eq!(
        (manifest.sheet.width, manifest.sheet.height),
        (width, height)
    );
}

#[test]
fn a_second_start_does_not_install_a_second_copy() {
    let dir = data_dir("twice");
    let library = library_in(&dir);
    seed(&library, &dir, 1).expect("a first run");

    let before = library.list().expect("the library reads");
    assert_eq!(
        seed(&library, &dir, 2).expect("a second run"),
        Seeded::AlreadyOffered,
        "the second start recognises the first"
    );
    assert_eq!(
        library.list().expect("the library reads").len(),
        before.len()
    );
}

#[test]
fn a_removed_character_is_not_put_back_by_the_next_start() {
    let dir = data_dir("removed");
    let library = library_in(&dir);
    seed(&library, &dir, 1).expect("a first run");
    let character_id = only_character(&library);

    // The user's act, through the same call the ✕ on a library row makes.
    library
        .remove(&character_id)
        .expect("the user removes the shipped character");

    assert_eq!(
        seed(&library, &dir, 2).expect("the next start"),
        Seeded::AlreadyOffered,
        "the app does not undo a deletion it was asked to make (§4)"
    );
    assert!(
        entries(&library).expect("the library reads").is_empty(),
        "the character the user removed is gone"
    );
}

#[test]
fn a_choice_the_user_already_made_survives() {
    let dir = data_dir("chosen");
    // A user who has been here before and chose "use no character": a record on disk that names
    // none. This is the state a fresh install does *not* have, and the two are told apart by the
    // record's presence rather than by the value it holds.
    let store = PetSettingsStore::new(&dir).expect("the settings store opens");
    let defaults = PetSettingsRecord::defaults(PetSettingsDomain::Character);
    let applied = store.apply(&PetSettingsWrite {
        domain: PetSettingsDomain::Character,
        revision: defaults.revision as f64,
        values: serde_json::Value::Object(defaults.values.clone()),
    });
    assert!(
        matches!(
            applied,
            nekowite_lib::desktop_pet::PetSettingsUpdate::Applied { .. }
        ),
        "{applied:?}"
    );

    let library = library_in(&dir);
    assert_eq!(
        seed(&library, &dir, 1).expect("the shipped character installs anyway"),
        Seeded::InstalledOnly {
            character_id: BUNDLED_CHARACTER_ID.to_string()
        },
        "the character is installed, the selection is left alone"
    );

    let record = store
        .read(PetSettingsDomain::Character)
        .record()
        .expect("a record")
        .clone();
    assert_eq!(
        record
            .value("characterId")
            .and_then(serde_json::Value::as_str),
        None,
        "the user's 'no character' is still what the settings say"
    );
    assert!(
        matches!(
            store.read(PetSettingsDomain::Character),
            PetSettingsLoad::Current { .. }
        ),
        "and the record is still the one the user wrote"
    );
}

#[test]
fn the_shipped_character_does_not_take_an_id_a_user_already_used() {
    let dir = data_dir("taken");
    let library = library_in(&dir);

    // A pack the user imported whose folder happened to be named `neko`.
    let source = dir.join("from-the-user");
    std::fs::create_dir_all(&source).expect("a pack directory");
    let mut sheet = b"\x89PNG\r\n\x1a\n".to_vec();
    sheet.extend_from_slice(&13u32.to_be_bytes());
    sheet.extend_from_slice(b"IHDR");
    sheet.extend_from_slice(&160u32.to_be_bytes());
    sheet.extend_from_slice(&180u32.to_be_bytes());
    std::fs::write(source.join("theirs.png"), &sheet).expect("their sheet");
    library
        .install(&InstallRequest {
            character_id: BUNDLED_CHARACTER_ID.to_string(),
            name: "Their Cat".to_string(),
            kind: CharacterKind::Imported,
            source,
            installed_at_ms: 1,
        })
        .expect("their character installs");

    let outcome = seed(&library, &dir, 2).expect("the shipped character still installs");
    let Seeded::Installed {
        character_id,
        selected,
    } = outcome
    else {
        panic!("a library with a free id takes the shipped character: {outcome:?}");
    };
    assert_ne!(
        character_id, BUNDLED_CHARACTER_ID,
        "the shipped character took an id a user was already using"
    );

    // Theirs is untouched and still under its own id, and it is theirs that was chosen — the
    // shipped character must never be selected by pointing at somebody else's entry.
    let listed = library.list().expect("the library reads");
    let theirs = listed
        .iter()
        .find(|entry| entry.character_id == BUNDLED_CHARACTER_ID)
        .expect("their character is still there");
    assert_eq!(
        theirs.manifest.as_ref().map(|m| m.name.as_str()),
        Some("Their Cat")
    );
    assert_eq!(theirs.state, EntryState::Intact);
    assert!(selected);

    let store = PetSettingsStore::new(&dir).expect("the settings store opens");
    assert_eq!(
        store
            .read(PetSettingsDomain::Character)
            .record()
            .and_then(|record| record.value("characterId").cloned()),
        Some(serde_json::json!(character_id)),
        "the selection names the character that was actually installed"
    );
}
