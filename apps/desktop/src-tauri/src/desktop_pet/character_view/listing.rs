//! Every character the library holds, as the settings page's picker shows it.
//!
//! **Why this is a module of its own.** The picker reads a list and the pet window reads one
//! drawing, and the two answers are not the same shape: a page needs every installed character's
//! name, kind and health, while the window needs one sheet and its grid. Both were in
//! `character_view.rs`, and the file passed the 600-line backlog `docs/dev.md:286` names with them,
//! so the list is here and the drawing is in [`super::drawing`].
//!
//! It moves when the *page's* row changes — a column a picker shows, or the library's per-entry
//! state vocabulary (`EntryState`) — and not when the pet window's drawing facts do. The narrowing
//! is deliberate and is stated once here: two arms and not `EntryState`'s five, because the page's
//! question is "can this be drawn" and the four ways of not being drawable are one answer to it.

use serde::Serialize;

use super::super::resources::{CharacterKind, CharacterLibrary, EntryState, LibraryEntry};
use super::refusal::refusal_sentence;

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

#[cfg(test)]
mod tests;
