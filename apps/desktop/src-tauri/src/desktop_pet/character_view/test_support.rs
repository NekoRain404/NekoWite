//! The fixtures the behaviour file beside each module shares: a character library in a temporary
//! directory, a PNG header a pack can carry, and the settings records the appearance read is handed.
//!
//! **Why one file rather than a copy per module.** The split put each subject in a module of its own
//! with its cases beside it, and the fixtures did not divide that way: four of the seven behaviour
//! files need an installed character, three need a `character` record and two need a `general` one.
//! A copy per file would be four descriptions of what an installed character is, and a fixture is
//! exactly the helper whose second copy drifts. `library` below is deliberately the shape
//! `tests/desktop_pet_resources_test/support.rs` builds — removed first and named after the case —
//! so a directory left behind by a killed run cannot make the next one pass.
//!
//! `#[cfg(test)]` and not an ordinary module: nothing in a release build reads a fixture, and the
//! declaration in `character_view.rs` is what keeps this file in the module tree
//! `tests/module_tree_test.rs` walks — a test-only file no `mod` names is a file no `cargo check`
//! compiles, which is the defect that test exists for.

use std::path::PathBuf;

use crate::desktop_pet::resources::{CharacterKind, CharacterLibrary, CreateRequest};
use crate::desktop_pet::settings::{PetSettingsDomain, PetSettingsRecord};

/// A library root nothing else in this process is using, and the app data directory it lives
/// under — the same shape `tests/desktop_pet_resources_test/support.rs` builds, so a leftover
/// from a killed run cannot make the next one pass.
pub(crate) fn library(label: &str) -> (CharacterLibrary, PathBuf) {
    let data = std::env::temp_dir().join(format!("nkw-pet-view-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).expect("a temporary data directory");
    (
        CharacterLibrary::new(&data).expect("an absolute data directory is in scope"),
        data,
    )
}

/// A PNG header, and nothing after it. The library reads the IHDR chunk and never the pixels,
/// so a signature plus the two dimensions is a sheet as far as it is concerned.
pub(crate) fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend_from_slice(&13u32.to_be_bytes());
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes
}

pub(crate) fn install(library: &CharacterLibrary, id: &str, name: &str) -> PathBuf {
    install_named(library, id, name, "sheet.png")
}

/// The same install with the sheet's own file name given, which is the third string a user
/// chooses: their folder, their character's name, and what they called the image inside it.
pub(crate) fn install_named(
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
pub(crate) fn record(selected: Option<&str>, size: u64) -> PetSettingsRecord {
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

/// A `general` record with one motion value written into it, or none.
pub(crate) fn general(motion: Option<&str>) -> PetSettingsRecord {
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

/// A `message` record with one opacity written into it, or none.
pub(crate) fn message(opacity: Option<f64>) -> PetSettingsRecord {
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

/// A `general` record with one field chosen, and the ball size left out when the caller asks for
/// that — the same fixture `message` is, one domain over. Named apart from `general` above,
/// which is the motion policy's fixture and answers a different question.
pub(crate) fn general_with_ball_size(ball_size: Option<i64>) -> PetSettingsRecord {
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
