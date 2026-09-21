//! §8's character library as a window reaches it: what it holds, the two ways a character arrives,
//! and the sentence a refused install is answered with.
//!
//! **Why this is a module and not commands on `desktop_pet.rs`.** The parent had reached 814 lines
//! against the 600-line budget `docs/dev.md:286` puts on a business file, and the split is by
//! *reason to change* — the criterion that same section states. What makes this file change is where
//! a character can come from and what the library does with it: a new import source, a change to the
//! install transaction, a catalogue field or refusal. A window operation does not touch it, and
//! neither does a change to what a window draws.
//!
//! **The two sources are one subject, which is why they share a file.** A locally picked folder and a
//! catalogue offer are the same act one layer apart — the character lands through the same
//! `CharacterLibrary` transaction and is answered with the entry the library wrote, never one this
//! layer echoed back — and their refusals are assembled by the same rule: a code from below becomes a
//! sentence the user reads. `adoption_sentence` and the dialog path are beside each other so that a
//! refusal added to one source cannot be spelled differently in the other.
//!
//! **The clock is here because these are its only two callers.** `now_ms` is not a general helper:
//! the manifest's install time is the one value either path has to mint, and every rule about that
//! value lives with the library that reads it back. A third caller would be a third thing this layer
//! decides about a stored record, which is the boundary this file exists to keep.

use crate::desktop_pet::{AdoptionRefusal, CharacterKind, CharacterLibrary, InstallRequest};

/// Every character the library holds (§8), for the settings page that chooses one.
///
/// Read-only and deliberately not "the chosen one, plus the rest": the page compares this list
/// with the `character` domain's own value (which it is already editing), so the choice stays one
/// fact in one place rather than being reported twice.
#[tauri::command]
pub fn desktop_pet_library<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<crate::desktop_pet::PetCharacterEntry>, String> {
    use tauri::Manager;
    let library = app.try_state::<CharacterLibrary>();
    match library.as_deref() {
        // An app whose library could not be opened at startup (`lib.rs` reports it and carries
        // on). An empty list would be a lie about a library that may hold characters, so the
        // caller is told which of the two it is.
        None => Err("this build has no character library to read".to_string()),
        Some(library) => crate::desktop_pet::entries(library),
    }
}

/// Import one character pack the user picks in the OS dialog (§8's 导入).
///
/// The path is never a parameter: it comes from the dialog, which is a gesture by the user, and
/// nothing here joins a string the renderer sent onto a path — §8's rule for the resource side,
/// and the same shape `commands/fs.rs`'s dialogs have. `Ok(None)` is the user closing the dialog,
/// which is not an error.
///
/// The id and the name are derived from the folder the user picked (`character_view`), because a
/// pack folder is named by a human and an id has to be a path component. A pack that is already
/// installed is suffixed rather than refused — the alternative would be telling a user to delete
/// the character they are importing.
#[tauri::command]
pub async fn desktop_pet_import_character<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<crate::desktop_pet::PetCharacterEntry>, String> {
    use tauri::Manager;
    use tauri_plugin_dialog::DialogExt;
    let Some(source) = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|picked| picked.into_path().ok())
    else {
        return Ok(None);
    };
    let library = app
        .try_state::<CharacterLibrary>()
        .ok_or_else(|| "this build has no character library to import into".to_string())?;
    let name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "character".to_string());
    let character_id = crate::desktop_pet::free_character_id(&library, &name)?;
    let request = InstallRequest {
        character_id,
        name,
        kind: CharacterKind::Imported,
        source,
        installed_at_ms: now_ms(),
    };
    let installed = library
        .install(&request)
        .map_err(|refusal| crate::desktop_pet::refusal_sentence(&refusal))?;
    Ok(Some(crate::desktop_pet::PetCharacterEntry {
        character_id: installed.character_id.clone(),
        // What the library wrote, read back rather than echoed: the entry and the manifest are one
        // fact, and a second spelling of the name here could differ from the one on disk.
        pack_name: installed.name,
        kind: installed.kind,
        files: crate::desktop_pet::PetCharacterFiles::Intact,
        installed_at_ms: installed.installed_at_ms,
    }))
}

/// What the online catalogue offers right now (§8's 在线角色库).
///
/// The read is the whole of browsing: it answers with a state and, when there is one, a list of
/// offers — never an empty list for a failure, which is the defect §3.1 records against the
/// upstream client's `catalog.ts` (「区分离线、空库、损坏」). No URL crosses this boundary in either
/// direction: an offer is a name, a byline and a slug, and the address it would be downloaded from
/// is resolved on the host side from the catalogue the host itself read.
///
/// It is deliberately *not* cached. A browse is a user opening a page, and the alternative — a
/// process-lifetime copy of a document whose whole purpose is to change — would make the page's
/// first paint fast and every install after it resolve a slug against a list that may have moved.
#[tauri::command]
pub async fn desktop_pet_catalogue() -> Result<crate::desktop_pet::CatalogueReading, String> {
    Ok(crate::desktop_pet::read_catalogue().await)
}

/// Download one catalogue offer and install it (§8's 导入, from the network side).
///
/// The parameter is a **slug** and nothing else. §7.1's rule for windows is that a front end names
/// a character and never a window; this is the same rule one layer over, and the reason is the same
/// and stronger — a renderer that could name an address could point this app's downloader at any
/// host on the network. There is no argument to forge, so a catalogue document is the only thing
/// that can decide where a character comes from.
///
/// §8's four transfer rules are [`crate::desktop_pet::resources::remote`]'s, and every one of them
/// is applied before a byte is read: HTTPS, the catalogue's own host and a public address, a size
/// budget, and a content type that is checked against the bytes as well as the header. A refusal is
/// a sentence naming what refused — never a retry, and never a hang.
///
/// The character lands through [`CharacterLibrary::create`], the same transaction a locally made one
/// uses, and is recorded as [`crate::desktop_pet::CharacterKind::Remote`] so that what came from the
/// network is a fact on disk rather than a memory of this process.
#[tauri::command]
pub async fn desktop_pet_adopt_character<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    slug: String,
) -> Result<crate::desktop_pet::PetCharacterEntry, String> {
    use tauri::Manager;
    // Cloned out of the managed state rather than borrowed across the await: the fetch is a
    // suspension point, and a library held by reference through one would be a reference into the
    // app handle for as long as a remote host takes to answer.
    let library = app
        .try_state::<CharacterLibrary>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| "this build has no character library to install into".to_string())?;
    let installed = crate::desktop_pet::install_from_catalogue(&slug, &library, now_ms())
        .await
        .map_err(adoption_sentence)?;
    Ok(crate::desktop_pet::PetCharacterEntry {
        character_id: installed.character_id.clone(),
        // Read back from what the library wrote rather than echoed from the catalogue: the entry
        // and the manifest are one fact, and a second spelling of the name here could differ from
        // the one on disk.
        pack_name: installed.name,
        kind: installed.kind,
        files: crate::desktop_pet::PetCharacterFiles::Intact,
        installed_at_ms: installed.installed_at_ms,
    })
}

/// Why a catalogue install was refused, in the words the user reads.
///
/// Assembled here rather than in the module for the reason `ResourceRefusal` gives — the refusals
/// below are data, and a sentence built where the decision is made is one no page can translate —
/// with the module's own sentence for the library half, so the two cannot drift.
fn adoption_sentence(refusal: AdoptionRefusal) -> String {
    use crate::desktop_pet::resources::CatalogueFailure;
    match refusal {
        AdoptionRefusal::Catalogue(CatalogueFailure::Unconfigured) => {
            "no character catalogue is configured in this build".to_string()
        }
        AdoptionRefusal::Catalogue(CatalogueFailure::Unreachable(detail)) => {
            format!("the catalogue could not be reached: {detail}")
        }
        AdoptionRefusal::Catalogue(CatalogueFailure::Unreadable(detail)) => {
            format!("the catalogue could not be read: {detail}")
        }
        AdoptionRefusal::NoSuchOffer { slug } => {
            format!("the catalogue no longer offers {slug}")
        }
        AdoptionRefusal::Transfer(refusal) => refusal.detail(),
        AdoptionRefusal::Library(refusal) => crate::desktop_pet::refusal_sentence(&refusal),
    }
}

/// Now, in epoch milliseconds, for a manifest's install time.
///
/// Read here rather than injected because there is nothing to test about it at this layer: the
/// value is *recorded*, and every rule about it lives with the library that reads it back.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}
