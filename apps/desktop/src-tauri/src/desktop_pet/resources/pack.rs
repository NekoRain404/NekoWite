//! What a pack may contain, and what happens to one that may not (§8).
//!
//! This is the admitting half of the library: a source is read one level deep, every entry is
//! classified by its own bytes, §8's budgets are applied, and the pack's declared grid is read
//! out of its `pet.json`. Nothing here touches the library's directories — it answers "may this
//! become a character" and hands back files, which is what keeps the transaction in `library.rs`
//! the only thing that writes.

use std::fs;
use std::path::Path;

use super::media::{audio_format, image_size, looks_like_a_document};
use super::{
    display_name, io_refusal, PackageProblem, PackageRefusal, ResourceRefusal, SheetRecord,
    BUDGET_RULES,
    DEFAULT_SHEET_COLUMNS, DEFAULT_SHEET_ROWS, MAX_AUDIO_BYTES, MAX_FRAMES, MAX_IMAGE_EDGE,
    MAX_IMAGE_PIXELS, MAX_METADATA_DEPTH, MAX_PACKAGE_BYTES, MAX_PACKAGE_FILES, PACK_MANIFEST,
    RESERVED_PREFIX,
};

pub(super) struct RawFile {
    pub(super) name: String,
    pub(super) bytes: Vec<u8>,
}

/// A pack's files once every one of them passed, and which of them is the sheet.
pub(super) struct ClassifiedPack {
    pub(super) files: Vec<RawFile>,
    pub(super) sheet: SheetRecord,
}

/// The grid a pack asked to be sliced on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) struct Grid {
    pub(super) columns: u32,
    pub(super) rows: u32,
}

/// Read a source into a flat pack and refuse anything the format forbids.
pub(super) fn read_pack(source: &Path) -> Result<Vec<RawFile>, ResourceRefusal> {
    let meta = fs::symlink_metadata(source).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => ResourceRefusal::NoSource {
            path: source.to_path_buf(),
        },
        _ => io_refusal(source, error),
    })?;
    if meta.file_type().is_symlink() {
        return Err(PackageRefusal::new(
            &display_name(source),
            PackageProblem::Symlink,
            "the import follows no links: what is copied has to be inside the pack",
        )
        .into_refusal());
    }
    if meta.is_file() {
        let name = display_name(source);
        let bytes = fs::read(source).map_err(|error| io_refusal(source, error))?;
        check_archive(&name, &bytes)?;
        return Ok(vec![RawFile { name, bytes }]);
    }
    if !meta.is_dir() {
        return Err(ResourceRefusal::NoSource {
            path: source.to_path_buf(),
        });
    }

    let entries = fs::read_dir(source).map_err(|error| io_refusal(source, error))?;
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|error| io_refusal(&path, error))?;
        if meta.file_type().is_symlink() {
            return Err(PackageRefusal::new(
                &name,
                PackageProblem::Symlink,
                "a link would make what is copied depend on a target outside the pack",
            )
            .into_refusal());
        }
        if meta.is_dir() {
            return Err(PackageRefusal::new(
                &name,
                PackageProblem::Directory,
                "a pack is a flat set of files: a subdirectory is refused rather than walked, so nothing here ever joins a pack's name onto a path",
            )
            .into_refusal());
        }
        if !is_component(&name) {
            return Err(PackageRefusal::new(
                &name,
                PackageProblem::NestedPath,
                "a pack entry's name has to be a plain file name",
            )
            .into_refusal());
        }
        if files.len() >= MAX_PACKAGE_FILES {
            return Err(budget("file-count", MAX_PACKAGE_FILES as u64, (files.len() + 1) as u64));
        }
        let bytes = fs::read(&path).map_err(|error| io_refusal(&path, error))?;
        check_archive(&name, &bytes)?;
        files.push(RawFile { name, bytes });
    }
    Ok(files)
}

/// Refuse a container, by its bytes first and its name second.
///
/// The bytes decide because a renamed archive is the ordinary way one arrives; the name is
/// consulted only so a corrupt `.zip` gets the archive sentence rather than "unrecognised".
fn check_archive(name: &str, bytes: &[u8]) -> Result<(), ResourceRefusal> {
    let archive = bytes.starts_with(b"PK\x03\x04")
        || name.to_ascii_lowercase().ends_with(".zip");
    if archive {
        return Err(PackageRefusal::new(
            name,
            PackageProblem::Archive,
            "this build imports a folder or a single file; unpacking an archive is a separate feature with its own dependency and its own traversal rules",
        )
        .into_refusal());
    }
    Ok(())
}

/// Classify every file, apply §8's budgets, and pick the sheet.
///
/// Classification is by content, not by extension: a file's own bytes decide what it is, and a
/// name that disagrees with them changes only the sentence in the refusal.
pub(super) fn classify_pack(files: Vec<RawFile>, grid: Option<Grid>) -> Result<ClassifiedPack, ResourceRefusal> {
    let mut total: u64 = 0;
    let mut sheet: Option<SheetRecord> = None;
    let mut images: Vec<String> = Vec::new();
    let mut grid = grid;

    for file in &files {
        total += file.bytes.len() as u64;
        if total > MAX_PACKAGE_BYTES {
            return Err(budget("package-bytes", MAX_PACKAGE_BYTES, total));
        }

        if file.name.eq_ignore_ascii_case(PACK_MANIFEST) {
            grid = grid.or(read_pack_grid(&file.bytes)?);
            continue;
        }
        if let Some((width, height)) = image_size(&file.bytes) {
            if width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE {
                return Err(budget(
                    "image-edge",
                    MAX_IMAGE_EDGE as u64,
                    width.max(height) as u64,
                ));
            }
            let pixels = width as u64 * height as u64;
            if pixels > MAX_IMAGE_PIXELS {
                return Err(budget("image-pixels", MAX_IMAGE_PIXELS, pixels));
            }
            images.push(file.name.clone());
            sheet = Some(SheetRecord {
                file: file.name.clone(),
                width,
                height,
                columns: DEFAULT_SHEET_COLUMNS,
                rows: DEFAULT_SHEET_ROWS,
            });
            continue;
        }
        if audio_format(&file.bytes).is_some() {
            if file.bytes.len() as u64 > MAX_AUDIO_BYTES {
                return Err(budget("audio-bytes", MAX_AUDIO_BYTES, file.bytes.len() as u64));
            }
            continue;
        }
        if looks_like_a_document(&file.name, &file.bytes) {
            return Err(PackageRefusal::new(
                &file.name,
                PackageProblem::Script,
                "a pack holds images, sound and one pet.json; a file a browser would execute or parse as a document is never carried into the library",
            )
            .into_refusal());
        }
        return Err(ResourceRefusal::Unrecognized {
            name: file.name.clone(),
        });
    }

    let Some(mut sheet) = sheet else {
        return Err(ResourceRefusal::NoSheet);
    };
    if images.len() > 1 {
        return Err(ResourceRefusal::AmbiguousSheet { names: images });
    }
    if let Some(grid) = grid {
        let frames = grid.columns as u64 * grid.rows as u64;
        if frames > MAX_FRAMES || grid.columns == 0 || grid.rows == 0 {
            return Err(budget("frames", MAX_FRAMES, frames));
        }
        if sheet.width % grid.columns != 0 || sheet.height % grid.rows != 0 {
            return Err(ResourceRefusal::MalformedManifest {
                detail: format!(
                    "a {}x{} sheet does not divide into {}x{} cells",
                    sheet.width, sheet.height, grid.columns, grid.rows
                ),
            });
        }
        sheet.columns = grid.columns;
        sheet.rows = grid.rows;
    }
    Ok(ClassifiedPack { files, sheet })
}

/// The grid a pack declares, if it declares one.
///
/// `columns`/`rows` is the form the format documents; `frameWidth`/`frameHeight` is the other way
/// the same fact is written down, and both are accepted only as positive integers. A field that
/// is there and is not one is a malformed manifest rather than an ignored key: a pack whose grid
/// was dropped would be sliced on a grid nobody asked for.
fn read_pack_grid(bytes: &[u8]) -> Result<Option<Grid>, ResourceRefusal> {
    let text = std::str::from_utf8(bytes).map_err(|error| ResourceRefusal::MalformedManifest {
        detail: error.to_string(),
    })?;
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|error| ResourceRefusal::MalformedManifest {
            detail: error.to_string(),
        })?;
    let depth = json_depth(&value);
    if depth > MAX_METADATA_DEPTH {
        return Err(budget(
            "metadata-depth",
            MAX_METADATA_DEPTH as u64,
            depth as u64,
        ));
    }
    let positive = |key: &str| -> Result<Option<u64>, ResourceRefusal> {
        match value.get(key) {
            None => Ok(None),
            Some(found) => found.as_u64().filter(|n| *n > 0).map(Some).ok_or_else(|| {
                ResourceRefusal::MalformedManifest {
                    detail: format!("{key} is present and is not a positive whole number"),
                }
            }),
        }
    };
    match (positive("columns")?, positive("rows")?) {
        (None, None) => Ok(None),
        (Some(columns), Some(rows)) => Ok(Some(Grid {
            columns: clamp_u32(columns),
            rows: clamp_u32(rows),
        })),
        _ => Err(ResourceRefusal::MalformedManifest {
            detail: "columns and rows are one fact and have to be given together".to_string(),
        }),
    }
}

/// How deep a JSON value nests. Bounded work for a document this module did not write.
/// A whole number narrowed to the width the record stores.
///
/// A pack's declared grid is read as a `u64` and the manifest records a `u32`; the bound is applied
/// before this, so the narrowing cannot lose a value that mattered.
fn clamp_u32(value: u64) -> u32 {
    value.min(u32::MAX as u64) as u32
}

fn json_depth(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::Array(items) => 1 + items.iter().map(json_depth).max().unwrap_or(0),
        serde_json::Value::Object(fields) => 1 + fields.values().map(json_depth).max().unwrap_or(0),
        _ => 0,
    }
}

pub fn is_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value != "."
        && value != ".."
        && !value.starts_with(RESERVED_PREFIX)
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// The size of an image, from its header, or `None` when this build cannot read it.
///
fn budget(rule: &'static str, limit: u64, found: u64) -> ResourceRefusal {
    debug_assert!(BUDGET_RULES.contains(&rule));
    ResourceRefusal::Budget {
        rule,
        limit,
        found,
    }
}
