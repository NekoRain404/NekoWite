//! What a pet window draws of its character: the sheet, the grid, and the policies one frame needs
//! (§5.1's 角色与动画, §5.2's motion, bubble and ball).
//!
//! **Why this is a module and not a command on `desktop_pet.rs`.** The parent had reached 814 lines
//! against the 600-line budget `docs/dev.md:286` puts on a business file, and the split is by
//! *reason to change* — the criterion that same section states. What makes this file change is what
//! a frame is: a further field of the `character` domain, another stored policy the window has no
//! permission to read for itself, or a change to how a spritesheet is handed to the asset protocol.
//! A window operation or a library install never touches it.
//!
//! **Why the read is one command rather than four.** The window needs all of it together to draw one
//! frame, and the sheet path must be *granted* in the same motion it is answered — the grant below
//! extends the asset protocol by exactly this file, which is the rule `commands/fs.rs` settled for
//! the vault's images: one `allow_file` per resolved file, never a directory, and never a scope entry
//! for the library. Splitting the read would leave a window able to hold a path it was never granted,
//! which is the state the single command exists to make impossible.
//!
//! **The app's own palette is the file next door.** A pet window also draws *with* the app's theme,
//! accent and contrast, and those are a different subject: they change when the app's palette gains a
//! field or the relay that carries it changes, not when a character does. They are read and published
//! in `host_appearance` beside this file, so that this file is left with the one question it answers —
//! which character, on which grid, with which motion, bubble and ball.

use std::path::Path;

use crate::commands::desktop_pet_surface::settings_store;
use crate::desktop_pet::settings::DefaultsReason;
use crate::desktop_pet::{CharacterLibrary, PetSettingsDomain, PetSettingsLoad};

/// What the pet window draws, or why it draws nothing (§5.1's 角色与动画).
///
/// The whole of the window's appearance in one read: which character the `character` settings
/// domain names, where its spritesheet is, the grid to slice it on, and the domain's own values
/// (size, animation mapping, idle playlist) as the store read them. One call rather than four,
/// because the window needs them together to draw one frame, and because the sheet path must be
/// *granted* — [`allow_character_sheet`] below extends the asset protocol by exactly this file,
/// which is the rule `commands/fs.rs` settled for the vault's images: one `allow_file` per
/// resolved file, never a directory, and never a scope entry for the library.
///
/// It reads three domains, and two of them are the ones a pet window cannot read for itself:
/// `general` supplies the motion policy ([`crate::desktop_pet::Motion`]) — §5.2's 「跟随系统/应用设置」,
/// which the 常规与交互 page writes and which nothing on the desktop followed until this read carried
/// it — and `message` supplies the bubble's background alpha
/// ([`crate::desktop_pet::BubbleOpacity`]), which §5.2's 气泡与消息 writes and which the bubble in
/// this window draws with. `capabilities/desktop-pet.json` deliberately holds no
/// `desktop_pet_read_settings`, so a window that asked for a domain would be a window that could
/// read every field of the pet's settings; what it is handed instead is the two policies it draws
/// with, read here from the same store.
#[tauri::command]
pub fn desktop_pet_appearance<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<crate::desktop_pet::PetAppearance, String> {
    use tauri::Manager;
    let store = settings_store(&app)?;
    // A `general` record this build may not read (a newer build's, §10.2) is answered with the
    // schema's own default rather than guessed at: the windows are told the policy this build was
    // built with, which is the arm every other unreadable field takes. The character record below
    // is the one that decides whether there is a window to draw at all, and *its* read-only arm is
    // still an error — a choice exists there and cannot be honoured. The `message` record takes the
    // same arm as `general`: the bubble's alpha is a surface this window can draw with any value,
    // and a schema this build cannot read is not a reason to refuse the character too.
    let motion = crate::desktop_pet::character_view::stored_motion(&store);
    let bubble_opacity = crate::desktop_pet::character_view::stored_bubble_opacity(&store);
    // And the rest of that domain: what the bubble shows and how it lays the rows out. Read through
    // its own arm for the same reason, and on every appearance arm for the same reason the alpha is
    // — this is the read that makes 气泡与消息's phrases and layout reach a surface at all.
    let bubble_message = crate::desktop_pet::character_view::stored_bubble_message(&store);
    // The ball's size, for the one window that draws an orb rather than a whole character: the same
    // arrangement as the two above, and the reason `general.ballSize` reaches a page at all — the pet
    // windows hold no settings read (`capabilities/desktop-pet.json`).
    let ball_size = crate::desktop_pet::stored_ball_size(&store);
    let record = match store.read(PetSettingsDomain::Character) {
        PetSettingsLoad::Current { record } | PetSettingsLoad::Migrated { record, .. } => record,
        // No record: a fresh install. Nothing is chosen, which is a state the window draws as a
        // sentence — and deliberately not an error.
        PetSettingsLoad::Defaults {
            reason: DefaultsReason::Absent,
            ..
        } => {
            return Ok(crate::desktop_pet::PetAppearance::Unset {
                motion,
                bubble_opacity: bubble_opacity.value(),
                // Moved rather than cloned: this arm returns from the command, and the two arms
                // below it are exclusive.
                bubble: bubble_message,
                ball_size,
            });
        }
        // There is a file and it is not a record this build can read. Reported rather than read as
        // "nothing chosen": a corrupt record is not an empty one, and drawing nothing for one
        // would hide the corruption behind a state the user could not tell from a fresh install.
        PetSettingsLoad::Defaults {
            reason: DefaultsReason::Unreadable,
            ..
        } => {
            return Err(
                "the pet's character settings are there and are not readable as a record"
                    .to_string(),
            )
        }
        // §10.2: written by a newer build, so this one reads it and does not touch it. There is no
        // record to draw from, and pretending there is would be reading a future schema's fields
        // by guess.
        PetSettingsLoad::ReadOnly { found_version, .. } => {
            return Err(format!(
                "the pet's character settings are at schema {found_version}, which this build \
                 cannot read"
            ))
        }
    };
    let library = app.try_state::<CharacterLibrary>();
    let appearance = crate::desktop_pet::appearance(
        &record,
        motion,
        bubble_opacity,
        bubble_message,
        ball_size,
        library.as_deref(),
    );
    if let crate::desktop_pet::PetAppearance::Ready { sheet_path, .. } = &appearance {
        allow_character_sheet(&app, Path::new(sheet_path));
    }
    Ok(appearance)
}

/// One character's spritesheet, and nothing else, through `asset://`.
///
/// The scope cannot be narrowed — `allow_file` only ever appends — so it is never widened by a
/// directory: `commands/fs.rs`'s header is where that rule is argued, and a
/// `desktop-pet/characters/**` entry would hand the whole library to a protocol with no IPC guard
/// in front of it. The residue is the sheets of characters that have been drawn this session,
/// which is exactly what the user was looking at.
fn allow_character_sheet<R: tauri::Runtime>(app: &tauri::AppHandle<R>, path: &Path) {
    use tauri::Manager;
    let _ = app.asset_protocol_scope().allow_file(path);
}
