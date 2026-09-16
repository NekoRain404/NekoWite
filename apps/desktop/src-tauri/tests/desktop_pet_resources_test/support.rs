//! The fixtures the five behaviour files share: a library in a temporary directory, small valid
//! files of every type the importer admits, and the pack directories the cases are built from.
//!
//! Every byte here is hand-built rather than sampled, for the same reason D2's tests hand-build
//! sprite sheets: a fixture that came from a real file would make the test depend on a format
//! library this crate does not have, and the header fields under test are the only part of a real
//! file the importer looks at anyway.

use std::path::{Path, PathBuf};

use crate::desktop_pet::resources::{CharacterKind, CharacterLibrary, InstallRequest};

/// A library root nothing else in the process is using.
///
/// Removed first and named after the test, so a leftover from a killed run cannot make the next
/// one pass — the failure mode D3's `windows.rs` avoids by asserting on the listing rather than on
/// counts alone.
pub fn library(label: &str) -> (CharacterLibrary, PathBuf) {
    let data =
        std::env::temp_dir().join(format!("nkw-pet-resources-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).expect("a temporary data directory");
    let library = CharacterLibrary::new(&data).expect("an absolute data directory is in scope");
    (library, data)
}

/// A source directory to build a pack in, outside the library so the import has something to copy.
pub fn pack_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-pet-pack-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temporary pack directory");
    dir
}

/// A PNG header, and nothing after it.
///
/// The importer reads the IHDR chunk and never the pixels, so a signature plus the two dimensions
/// is a PNG as far as this module is concerned — and that is the point: what is under test is
/// whether the *size* a sheet claims is measured and bounded, not whether the image decodes.
pub fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend_from_slice(&13u32.to_be_bytes());
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes
}

/// A GIF, the format with the shortest header of the four.
pub fn gif(width: u16, height: u16) -> Vec<u8> {
    let mut bytes = b"GIF89a".to_vec();
    bytes.extend_from_slice(&width.to_le_bytes());
    bytes.extend_from_slice(&height.to_le_bytes());
    bytes
}

/// A JPEG: an APP0 segment to walk over, then a baseline frame header with the size in it.
pub fn jpeg(width: u16, height: u16) -> Vec<u8> {
    let mut bytes = vec![0xff, 0xd8];
    // APP0, length 4, two bytes of payload: the walk has to advance over a marker it does not
    // care about before it reaches the one it does.
    bytes.extend_from_slice(&[0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
    bytes.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08]);
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes
}

/// A WebP in its extended container, which is the one the catalogue's own sheets use.
pub fn webp(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(b"WEBP");
    bytes.extend_from_slice(b"VP8X");
    bytes.extend_from_slice(&10u32.to_le_bytes());
    bytes.extend_from_slice(&[0, 0, 0, 0]);
    bytes.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
    bytes.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
    bytes
}

/// An Ogg stream header. Audio is magic-checked, so this is a sound as far as the importer knows.
pub fn ogg(payload: usize) -> Vec<u8> {
    let mut bytes = b"OggS".to_vec();
    bytes.extend(std::iter::repeat(0u8).take(payload));
    bytes
}

/// A pack's own `pet.json`, in the pack format the upstream client reads.
pub fn pet_json(extra: &str) -> Vec<u8> {
    format!("{{\"displayName\":\"Cat\",\"description\":\"a cat\"{extra}}}").into_bytes()
}

/// Write one file into a directory, making no attempt to be clever about failure.
pub fn write(dir: &Path, name: &str, bytes: &[u8]) {
    std::fs::write(dir.join(name), bytes).expect("the fixture file is writable");
}

/// The directory listing of a path, sorted, or an empty list when it is not there.
///
/// The transaction cases compare this before and after a refused import: "nothing changed" is a
/// statement about the whole library, and a listing is the only form of it that cannot be satisfied
/// by the library having quietly acquired something.
pub fn listing(path: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(path) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// An install request for one pack directory, with the clock supplied rather than read.
pub fn install_request(character_id: &str, source: &Path) -> InstallRequest {
    InstallRequest {
        character_id: character_id.to_string(),
        name: "Cat".to_string(),
        kind: CharacterKind::Imported,
        source: source.to_path_buf(),
        installed_at_ms: 1_700_000_000_000,
    }
}
