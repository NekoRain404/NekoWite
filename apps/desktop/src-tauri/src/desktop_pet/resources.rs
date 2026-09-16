//! Imported characters: what a pack may contain, and what the library is once it does (§8).
//!
//! This is the one place where files from outside the app become things the app draws, so it is
//! also the place where §8's rules have to hold. Four of them are structural rather than written
//! down, because a rule that lives only in prose is a rule the next edit can drop:
//!
//! - **A pack is a flat set of names, so there is no path to traverse.** Every source is read as
//!   one level of entries in a directory (or one file), each name is checked against
//!   [`pack::is_path_component`], and a subdirectory is refused rather than walked. A traversal is not
//!   detected and refused — it is *unrepresentable*, because nothing here ever joins a name from
//!   the pack onto a path.
//! - **An install's commit point is a single rename.** Everything an import does happens inside
//!   [`library::CharacterLibrary::root`] under a reserved `.staging-<n>` name, and [`library::Staging`]
//!   removes that directory on every path out of the function that did not publish it. A failure
//!   halfway — a bad file, a full disk, a process that never returns — leaves either a complete
//!   character or no trace of one, and never a character made of half a pack.
//! - **The manifest is what a character should be; the directory is what it is.** A disagreement
//!   between them is a *state* ([`EntryState`]) and never resolved by preferring one side: a file
//!   whose size moved is [`EntryState::Resized`], not a file to be re-copied and not a manifest
//!   to be rewritten. This is why there is no library index file beside the directories — a
//!   second list of what is installed could disagree with the directories without either being
//!   wrong, which is the bug class this rule exists to remove.
//! - **Nothing here reaches the network.** The one operation that would — the online catalogue —
//!   has no endpoint in this build, and [`remote::remote_fetch_plan`] refuses before any of §8's transfer
//!   rules are consulted. An installed character is a local directory, and every read here works
//!   with no interface up (§8's 「缓存与离线角色不依赖服务可用性」). The rules themselves are
//!   written and tested rather than left to the task that configures an endpoint, because
//!   "HTTPS only, no private address, bounded size, bounded time" is a specification that belongs
//!   beside the thing it constrains.
//!
//! **The name rule, and the rule that is not one.** Two facts about a character are easy to run
//! together and are kept apart here, because running them together is what made a Chinese folder
//! name unimportable:
//!
//! - **A name that becomes a path component** — a character's directory, a file inside one — is
//!   checked by [`pack::is_path_component`], and that rule is about the *filesystem*: no
//!   separators, no `.`/`..`, no leading dot, nothing invisible or reordering, a bounded length.
//!   It has no opinion about which alphabet, and neither does the filesystem: `喵喵` is a
//!   directory name and `精灵图.png` is a file name exactly as `kitty` and `sheet.png` are.
//! - **The id the app invents for an imported folder** is a *generator's policy*, not a
//!   validation rule, and it lives where it is generated
//!   ([`super::character_view::free_character_id`]): lowercased, separator-free, and inside the
//!   generator's own length bound. A caller that supplies an id of its own is bound by
//!   `is_path_component` and by nothing else — which is why a pack folder named in Chinese gets
//!   an id in Chinese rather than a refusal.
//!
//! **What neither rule does is normalise.** The directory is the identity here (see the manifest
//! rule above), and NFC and NFD are two different byte sequences and therefore two different
//! directories on Linux — see [`pack::is_path_component`]'s own note for why this library does
//! not fold them.
//!
//! What is *not* here: pixels. [`media::image_size`] establishes a sheet's size from its own header and
//! refuses a format whose header it cannot read, so the allow-list is derived from what can be
//! validated rather than from taste — a format nobody here can measure is a format nobody here
//! can bound, and §8's 「不能校验的就拒绝，不凭信任接受」 is the same sentence. Slicing, drawing
//! and hit-testing are `sprite-slicer.ts` and `PetSprite.vue`, from D2.
//!
//! **The split.** This file is the module's vocabulary and its public face; the work is behind
//! four siblings, divided by responsibility rather than by length (§13.1, and §13's 「400 行执行
//! 拆分」): [`library`] owns the transaction that makes a character exist and the one that removes
//! it, [`entries`] is everything a page asks afterwards, [`pack`] decides what may become a
//! character, [`media`] decides what a file is, and [`remote`] holds §8's transfer rules for the
//! download this build does not perform. Nothing moved out of the public surface — the
//! submodules are public, so every name below is still reachable as `desktop_pet::resources::…`,
//! which is why registering this module is one `pub mod resources;` and not a list.
//!
//! Wiring is not here either: `lib.rs` and `commands/desktop_pet.rs` are the integrator's, and
//! this tree is declared by path in `tests/desktop_pet_resources_test.rs` until D12 registers it
//! — the convention D3's tests established.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub mod entries;
pub mod library;
pub mod media;
pub mod pack;
pub mod remote;

pub use library::CharacterLibrary;
pub use pack::{is_path_component, name_problem};
pub use remote::{
    remote_fetch_plan, RemoteRefusal, LIBRARY_ENDPOINT, REMOTE_CONTENT_TYPES, REMOTE_MAX_BYTES,
    REMOTE_TIMEOUT_MS,
};

/// The directory under the app's data directory that holds everything this module owns.
pub const LIBRARY_DIR: &str = "desktop-pet";
/// Inside [`LIBRARY_DIR`]: one directory per installed character.
pub const CHARACTERS_DIR: &str = "characters";
/// The manifest a pack may carry, in the Petdex pet-pack format the upstream client reads.
pub const PACK_MANIFEST: &str = "pet.json";
/// The manifest this module writes, with what the character is and what every file must be.
///
/// Deliberately not [`PACK_MANIFEST`]: the pack's own file is data it supplied and is copied as
/// data, and a record the library trusts has to be one no pack can author.
pub const INSTALLED_MANIFEST: &str = "manifest.json";
/// What a reserved entry in the library starts with (staging and removal debris).
///
/// It is also why [`pack::is_path_component`] refuses a leading dot: the ids a character may carry
/// and the names this module reserves are disjoint, so a character can never be mistaken for
/// debris.
const RESERVED_PREFIX: char = '.';
/// How many bytes one name in the library may have — a character's directory, or a file in one.
///
/// Bytes rather than characters, because that is the unit the filesystem measures in: the same
/// bound holds 64 ASCII characters and at most 21 of a Chinese name. It is well inside NAME_MAX
/// (255), and far past anything a person names a folder, so a name that meets it is one the
/// filesystem will take and the settings page can draw.
pub const MAX_COMPONENT_BYTES: usize = 64;
/// How many staging names one install will try before giving up. See [`Staging::open`].
const STAGING_ATTEMPTS: u32 = 10;

/// §8's package budget. Its numbers are initial values from the plan, to be re-fixed against a
/// fixture rather than argued about.
pub const MAX_PACKAGE_BYTES: u64 = 20 * 1024 * 1024;
/// How many files one pack may hold. Not in §8's list as a number; bounded because §8 asks for
/// the file count to be checked at all.
pub const MAX_PACKAGE_FILES: usize = 64;
/// §8's single-image budget, per edge.
pub const MAX_IMAGE_EDGE: u32 = 4096;
/// §8's single-image budget, in total pixels. Separate from the edge cap because a thin strip can
/// pass one and blow the other.
pub const MAX_IMAGE_PIXELS: u64 = 4096 * 4096;
/// §8's audio budget.
pub const MAX_AUDIO_BYTES: u64 = 5 * 1024 * 1024;
/// How deep the pack's own metadata may nest. Bounded so a document cannot cost unbounded work
/// to walk; a pack whose `pet.json` is deeper than this is refused rather than truncated.
pub const MAX_METADATA_DEPTH: usize = 8;
/// The most frames a sheet can address, which is the renderer's own grid: D2's
/// `FIXED_GRID_COLS * FIXED_GRID_ROWS` (`rendering/sprite-slicer.ts`). A pack that declares a
/// finer grid is refused because the extra cells would be drawn by nobody — the same "silently
/// dropped" shape as a file nobody can validate.
pub const MAX_FRAMES: u64 = 72;
/// The grid assumed when a pack declares none. Held to the TypeScript by
/// `the_sheet_grid_is_the_renderers_own`, which reads it off disk.
pub const DEFAULT_SHEET_COLUMNS: u32 = 8;
pub const DEFAULT_SHEET_ROWS: u32 = 9;

/// §8's budget rows, as the closed vocabulary a refusal and a settings page can both name.
pub const BUDGET_RULES: [&str; 7] = [
    "package-bytes",
    "file-count",
    "image-edge",
    "image-pixels",
    "audio-bytes",
    "frames",
    "metadata-depth",
];
/// Why the library refused an operation. Data only, for the reason `binary_registry::LayoutError`
/// gives: the wording a user reads is the frontend's, and a sentence assembled here would be one
/// no page could translate.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(tag = "reason", rename_all = "kebab-case")]
pub enum ResourceRefusal {
    /// A root the app does not own (§3.3's rule, reached from the resource side).
    OutsideManagedScope { root: PathBuf, detail: String },
    /// A name that cannot be a path component: traversal dressed as configuration.
    ///
    /// `detail` is [`pack::name_problem`]'s own sentence for the clause that refused, so the
    /// reason reaches the user instead of a restatement of the field's name — and it is the same
    /// function that made the decision, so the two cannot disagree.
    InvalidName {
        field: &'static str,
        value: String,
        detail: String,
    },
    /// The source named does not exist, or is neither a file nor a directory.
    NoSource { path: PathBuf },
    /// One file of the pack cannot be carried over. The `problem` is the vocabulary a page maps.
    ///
    /// Also raised when a name read *back* out of a manifest turns out to be a link: the fact is
    /// the same one — a link is not followed — and it has the same consequence, except that what
    /// would depend on a target outside the character is the read rather than the copy.
    Package {
        name: String,
        problem: PackageProblem,
        detail: String,
    },
    /// A file whose type could not be established from its own bytes.
    Unrecognized { name: String },
    /// §8's budgets, named by [`BUDGET_RULES`].
    Budget {
        rule: &'static str,
        limit: u64,
        found: u64,
    },
    /// The pack's own manifest is there and not readable as one.
    MalformedManifest { detail: String },
    /// A pack with no spritesheet in it.
    NoSheet,
    /// A pack with more than one, where the format has one.
    AmbiguousSheet { names: Vec<String> },
    /// A character of that id is already installed. Refused rather than replaced (§8's
    /// 重名覆盖).
    AlreadyInstalled { character_id: String },
    /// Nothing is installed under that id.
    NotInstalled { character_id: String },
    /// A directory in the library that has no manifest this build wrote. Refused rather than
    /// removed: a record the module cannot read is a thing it cannot describe, and a deletion that
    /// cannot say what it destroyed is the shape §4 rules out.
    Unmanaged { character_id: String },
    /// The filesystem said no.
    Io { path: PathBuf, detail: String },
}

/// Why one file in a pack may not be carried over.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PackageProblem {
    /// A container of containers: this build imports a folder or a single file and does not
    /// unpack. Absent rather than supported on faith — §8 is explicit that ordinary file import
    /// does not oblige anyone to add an archive dependency.
    Archive,
    /// A link. Following one would make what gets copied depend on something outside the pack — and
    /// what gets *read*, when the link is one a manifest names and `verify` hashes.
    Symlink,
    /// A name that cannot be one file name inside the character's directory: a separator, a
    /// `.`/`..`, a leading dot, something invisible that reorders it, or no name at all.
    ///
    /// The `detail` beside it is [`pack::name_problem`]'s sentence for the clause that refused —
    /// this arm is the *category* a page groups by, and it is deliberately not the whole story:
    /// a name refused for having a separator and one refused for being over-long are one thing to
    /// a page and two different things to the person who has to rename a folder.
    UnusableName,
    /// A subdirectory. A pack is files.
    Directory,
    /// A file whose bytes an engine would execute or parse as a document — `svg` above all,
    /// which is why it is here rather than in the image list.
    Script,
}

/// A file the library will not copy, with the sentence a page can show.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PackageRefusal {
    pub name: String,
    pub problem: PackageProblem,
    pub detail: String,
}

impl PackageRefusal {
    pub(super) fn new(name: &str, problem: PackageProblem, detail: impl Into<String>) -> Self {
        Self {
            name: name.to_string(),
            problem,
            detail: detail.into(),
        }
    }

    pub(super) fn into_refusal(self) -> ResourceRefusal {
        ResourceRefusal::Package {
            name: self.name,
            problem: self.problem,
            detail: self.detail,
        }
    }
}

/// Where a character came from. Two arms and neither is remote, which is this build's whole
/// online story for characters: an online one would need the licence and data-flow review §8
/// defers to the online sub-plan.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CharacterKind {
    /// The user's own files, validated and copied.
    Imported,
    /// Drawn or assembled in the app from one sheet the user supplied.
    Created,
}

/// The sheet, as the manifest records it: which file, how many pixels, and what grid it slices
/// into.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetRecord {
    pub file: String,
    pub width: u32,
    pub height: u32,
    pub columns: u32,
    pub rows: u32,
}

/// One file of an installed character, and what it must hash to.
///
/// `seed` is what makes an install checkable afterwards: the digest is computed from the bytes
/// that were staged, so [`CharacterLibrary::verify`] compares a stored fact with a fresh one
/// rather than with a copy of itself.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledFile {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}

/// What a manifest records: everything the library knows about one character.
///
/// This is what a character *should* be. It is written once, when the character is published,
/// and after that it is read and compared — never rewritten by a later read, because a manifest
/// updated to match a directory that changed underneath it is a record that can no longer
/// disagree with anything, which is also a record that can no longer tell the user anything.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledCharacter {
    /// The manifest's own version, so a future field is a migration rather than a guess.
    pub schema_version: u32,
    pub character_id: String,
    pub name: String,
    pub kind: CharacterKind,
    /// §10.2's injected clock. Taken as a parameter rather than read here.
    pub installed_at_ms: u64,
    pub sheet: SheetRecord,
    pub files: Vec<InstalledFile>,
}

/// The manifest version this build writes and is willing to read.
pub const CHARACTER_SCHEMA_VERSION: u32 = 1;

/// What is on disk under one character's id, as the library sees it now.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum EntryState {
    /// Every file the manifest lists is there at the recorded size.
    Intact,
    /// Something the manifest lists is not there.
    Incomplete { missing: Vec<String> },
    /// A file is there and is not the size the manifest recorded.
    Resized { changed: Vec<String> },
    /// The manifest names something this library will not open inside the character's directory: a
    /// name that is not a path component (a `..`, an absolute path, a separator, an empty name), or
    /// a link.
    ///
    /// A state of its own rather than one of the three above, because each of those is a claim
    /// about a file somebody looked at, and nothing here looked: the name is refused before any
    /// stat is made. The names are carried so a user can see which entry to fix, and `verify` raises
    /// the reason rather than restating it — [`ResourceRefusal::InvalidName`] carrying
    /// [`pack::name_problem`]'s own sentence for a name that rule refused, and
    /// [`ResourceRefusal::Package`] with [`PackageProblem::Symlink`] for a link, which is a name the
    /// rule accepts and a file the library will not open.
    OutsideDirectory { names: Vec<String> },
    /// The manifest itself could not be read as one.
    UnreadableManifest { detail: String },
    /// A directory in the library with no manifest. Reported, never adopted and never removed:
    /// it is either a character from a build that wrote a different format or something the user
    /// put there, and neither is this module's to delete.
    Unmanaged,
}

/// One directory of the library, with what it currently is.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub character_id: String,
    pub state: EntryState,
    /// The manifest, when there was one to read — absent for [`EntryState::Unmanaged`] and
    /// [`EntryState::UnreadableManifest`], which is how a caller tells "no character" from
    /// "a character we cannot describe" without consulting the state string.
    pub manifest: Option<InstalledCharacter>,
}

/// One file whose contents are not what the manifest recorded.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestMismatch {
    pub character_id: String,
    pub name: String,
    pub recorded: String,
    pub found: String,
}

/// What an import is asked for.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct InstallRequest {
    /// The id the character will live under. Never a path the caller chose beyond that: it is
    /// validated as a component and never joined to anything unvalidated.
    pub character_id: String,
    /// The name the user sees. Free text, stored as data and never used as a path.
    pub name: String,
    pub kind: CharacterKind,
    /// The folder or single file the user picked.
    pub source: PathBuf,
    pub installed_at_ms: u64,
}

/// What creating a character from one sheet is asked for.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CreateRequest {
    pub character_id: String,
    pub name: String,
    pub installed_at_ms: u64,
    /// The file name the sheet is stored under. Validated like every other pack name.
    pub sheet_name: String,
    pub sheet: Vec<u8>,
    /// The grid the user chose, or the build's own when they did not.
    pub columns: u32,
    pub rows: u32,
}

/// What a removal did.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removal {
    pub character_id: String,
    /// Where the directory was moved to before it was emptied, when emptying it failed. The
    /// character is still gone from the library — the rename is the commit point — and this names
    /// what is left over rather than reporting a clean removal that did not happen.
    pub debris: Option<PathBuf>,
}

/// The shared plumbing of the three siblings: a path and a failure, in the shape a refusal takes.
///
/// `pub(super)` rather than private because `resources::library` and `resources::pack` both raise
/// `ResourceRefusal::Io` and both should raise it the same way; a private copy in each would be
/// two spellings of one refusal.
pub(super) fn io_refusal(path: &Path, error: impl std::fmt::Display) -> ResourceRefusal {
    ResourceRefusal::Io {
        path: path.to_path_buf(),
        detail: error.to_string(),
    }
}

pub(super) fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Lowercase hexadecimal — the spelling a digest is compared in.
pub(super) fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
