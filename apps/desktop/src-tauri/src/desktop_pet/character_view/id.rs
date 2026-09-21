//! The id a new character is installed under: a slug of the name the user picked, made unique.
//!
//! **Why this is a module of its own.** This is a *generator*, and the library's rule for what it
//! *accepts* is a different fact living in a different place
//! (`resources::is_path_component` — any name the filesystem can hold). A caller that brings an id
//! of its own never reaches anything here, so what changes this file is a change to the app's
//! naming policy — which characters survive, how long the result may be, how many suffixed variants
//! one import tries — and never a change to what the library holds. Keeping the two apart is what
//! makes "the validator has its own bound and the generator stays inside it" checkable rather than
//! asserted.
//!
//! **Non-ASCII is kept, and that is the point.** A Chinese-language user's folders are named in
//! Chinese, and an id that dropped every one of those characters would leave this library unable to
//! hold the characters its user has — the exact gap D12's report named. The library is byte-exact
//! (see `resources::is_path_component` on NFC/NFD), so the id a folder gets is the id a second
//! import of the same spelling asks for, and two spellings are two characters.

use super::super::resources::CharacterLibrary;
use super::refusal::refusal_sentence;

/// The id a new character is installed under: a slug of the name the user picked, made unique.
///
/// **This is a generator, not a rule.** What the library *accepts* is
/// [`super::super::resources::is_path_component`] — any name the filesystem can hold — and a caller that brings
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
/// [`super::super::resources::MAX_COMPONENT_BYTES`], so everything this invents is a name the library takes —
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

#[cfg(test)]
mod tests;
