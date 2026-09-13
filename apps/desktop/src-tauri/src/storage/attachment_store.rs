//! Attachment store: the two ways an image gets into a vault (a base64 paste
//! and a native file picker), the name and size rules both share, and the
//! name-claiming write that publishes them.
//!
//! Both entry points end in [`publish_attachment`], which chooses a free name
//! inside the target directory and CLAIMS it with the create-only write from
//! [`crate::storage::atomic_write`] (roadmap 10.4 step 2). Choosing the name and
//! writing it are therefore one step: a name another writer takes in between is
//! reported as taken and the search simply goes on, instead of two callers
//! being handed the same path and one payload being lost.
//!
//! A picked path is intentionally outside the vault (that is the point of a
//! file picker), so only the DESTINATION is confined: the extension is
//! allowlisted, the size is capped, and the directory is resolved through
//! [`crate::domain::path_policy::resolve_within_rel`].

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use chrono::Local;
use std::io::Read;
use std::path::Path;

use crate::domain::path_policy::{resolve_within, resolve_within_rel};
use crate::errors::fs_error;
use crate::storage::atomic_write::{create_new_bytes, time_nonce, CreateFileError};

/// Decode a standard-base64 attachment payload (frontend paste data).
pub fn decode_base64(data: &str) -> Result<Vec<u8>, String> {
    BASE64_STANDARD
        .decode(data.trim())
        .map_err(|e| format!("attachment data is not valid base64: {e}"))
}

/// Largest image the picker-based import accepts, mirroring the frontend's
/// `MAX_ATTACHMENT_BYTES` so both entry points agree on what "too large" means.
pub const MAX_IMPORT_BYTES: u64 = 10 * 1024 * 1024;

/// Image extensions the import path accepts. A native file picker is a user
/// gesture, but the picked path is still an arbitrary filesystem location, so
/// the set of things we are willing to copy into a vault stays closed: an
/// allowlist of image extensions, no executables, scripts or archives.
pub const IMPORT_IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "ico", "tiff", "tif",
];

/// True when `path`'s extension is on the import allowlist (case-insensitive).
pub fn is_importable_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| IMPORT_IMAGE_EXTENSIONS.contains(&e.as_str()))
}

/// Copy an image the user picked in the native dialog into the vault,
/// returning its vault-relative path.
///
/// Unlike [`save_attachment`] the bytes never round-trip through the frontend
/// as base64: the backend reads the source path directly and writes it into the
/// vault. That keeps a large photo from being encoded (≈4/3 the byte size),
/// shipped over IPC, decoded and written — and it means the file's real name
/// and extension are preserved instead of being re-derived from MIME type.
///
/// The source path is intentionally outside the vault (that is the point of a
/// file picker), so it is NOT passed through `resolve_within`. Instead the
/// destination is confined to the vault by [`resolve_within_rel`] exactly like
/// [`save_attachment`], the extension is allowlisted, and the size is capped.
pub fn import_attachment(vault_root: &str, source_path: &str, dir: &str) -> Result<String, String> {
    let source = Path::new(source_path);
    if !source.is_absolute() {
        return Err("picked file path must be absolute".into());
    }
    let metadata =
        std::fs::metadata(source).map_err(|e| fs_error("read the picked file", source, e))?;
    if !metadata.is_file() {
        return Err("picked path is not a file".into());
    }
    if !is_importable_image(source) {
        return Err("picked file is not a supported image".into());
    }
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err(format!(
            "image is larger than the {} MB import limit",
            MAX_IMPORT_BYTES / (1024 * 1024)
        ));
    }
    let file_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "picked file has no usable name".to_string())?;
    // Reuses the same name sanitizer as the paste path, so an odd source name
    // can never steer the destination out of the target directory.
    let name = sanitize_attachment_name(file_name)?;

    let _root = resolve_within(vault_root, ".")?;
    let dir = dir.trim();
    if Path::new(dir).is_absolute() {
        return Err("attachment dir must be vault-relative".into());
    }
    let dir = if dir.is_empty() || dir == "." {
        ""
    } else {
        dir.trim_matches('/')
    };
    let (dir_abs, dir_rel) = if dir.is_empty() {
        let month = attachment_month_dir();
        let rel = format!("attachments/{month}");
        let abs = resolve_within(vault_root, &rel)?;
        (abs, rel)
    } else {
        resolve_within_rel(vault_root, dir)?
    };
    std::fs::create_dir_all(&dir_abs).map_err(|e| fs_error("create the folder", &dir_abs, e))?;
    // Bound the READ, not just the `metadata` check above: the file can be
    // replaced or grown in between, and `fs::read` would then pull an unbounded
    // amount into memory on the strength of a length that was true a moment
    // ago. One byte past the limit is enough to detect it.
    let mut bytes = Vec::new();
    std::fs::File::open(source)
        .map_err(|e| fs_error("open the picked file", source, e))?
        .take(MAX_IMPORT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| fs_error("read the picked file", source, e))?;
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err(format!(
            "image is larger than the {} MB import limit",
            MAX_IMPORT_BYTES / (1024 * 1024)
        ));
    }
    let unique = publish_attachment(&dir_abs, &name, &bytes)?;
    Ok(format!("{dir_rel}/{unique}"))
}

/// Reduce a pasted/typed attachment name to a bare `stem.ext` file name.
/// Path separators, `..` runs and extension-less names are rejected, so the
/// name can never steer the write out of the attachments directory.
pub fn sanitize_attachment_name(name: &str) -> Result<String, String> {
    let invalid = || "invalid attachment file name".to_string();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(invalid());
    }
    let path = Path::new(name);
    if path.file_name().and_then(|n| n.to_str()) != Some(name) {
        return Err(invalid());
    }
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(invalid)?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .ok_or_else(invalid)?;
    Ok(format!("{stem}.{ext}"))
}

/// Local-calendar month folder for new attachments (`YYYY-MM`).
fn attachment_month_dir() -> String {
    Local::now().format("%Y-%m").to_string()
}

/// How many `-<n>` (and then `-overflow-<n>`) names a new attachment may try
/// before it gives up, so the search cannot spin forever over a directory that
/// holds every candidate.
const ATTACHMENT_NAME_ATTEMPTS: u32 = 1000;

/// `stem.ext` for `n == 0`, `stem-<n>.ext` after that — the collision scheme
/// both attachment entry points promise. Mirrors Memoir's `unique_file_name`.
fn attachment_candidate(stem: &str, ext: &str, n: u32) -> String {
    if n == 0 {
        format!("{stem}.{ext}")
    } else {
        format!("{stem}-{n}.{ext}")
    }
}

/// Publish `bytes` under the first free name derived from `preferred` inside
/// `dir_abs`, returning the name it claimed.
///
/// The name is probed first (cheap, and in the ordinary case the first
/// candidate is free) and then CLAIMED by the create-only write: a name another
/// writer takes in between is reported as taken and the search simply goes on.
/// Choosing the name and writing it are therefore one step, which the previous
/// `unique_attachment_name` + `atomic_write_bytes` pair was not — two pastes of
/// the same file name in the same millisecond both picked `paste.png` and the
/// second overwrote the first, while both callers were handed the same path and
/// only one payload was ever readable.
fn publish_attachment(dir_abs: &Path, preferred: &str, bytes: &[u8]) -> Result<String, String> {
    let path = Path::new(preferred);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("png");
    // `Ok(Some(name))` = claimed, `Ok(None)` = someone else has it.
    let claim = |candidate: String| match create_new_bytes(&dir_abs.join(&candidate), bytes) {
        Ok(()) => Ok(Some(candidate)),
        Err(CreateFileError::AlreadyExists) => Ok(None),
        Err(CreateFileError::Failed(message)) => Err(message),
    };

    for n in 0..ATTACHMENT_NAME_ATTEMPTS {
        let candidate = attachment_candidate(stem, ext, n);
        if !dir_abs.join(&candidate).exists() {
            if let Some(name) = claim(candidate)? {
                return Ok(name);
            }
        }
    }
    for n in 0..ATTACHMENT_NAME_ATTEMPTS {
        let candidate = if n == 0 {
            format!("{stem}-overflow.{ext}")
        } else {
            format!("{stem}-overflow-{n}.{ext}")
        };
        if !dir_abs.join(&candidate).exists() {
            if let Some(name) = claim(candidate)? {
                return Ok(name);
            }
        }
    }
    // A nonce makes the name unique in practice; it is still claimed rather
    // than assumed free, so even this last resort cannot overwrite anything.
    let candidate = format!("{stem}-overflow-{}.{ext}", time_nonce());
    match claim(candidate)? {
        Some(name) => Ok(name),
        None => Err(format!(
            "could not find a free name for {preferred} in {}",
            crate::domain::path_policy::ipc_path(dir_abs)
        )),
    }
}

/// Decode and save a base64 image attachment, deduplicating name collisions
/// with `-<n>` suffixes, and return the vault-relative path (forward slashes)
/// for embedding in markdown.
///
/// When `dir` is non-empty it is treated as a vault-relative target directory
/// (e.g. `notes/foo_assets` or `.tmp`) and the file is written there; when it
/// is empty the legacy `attachments/{YYYY-MM}` layout is used. Traversal and
/// symlink escapes in `dir` are rejected by [`resolve_within_rel`].
pub fn save_attachment(
    vault_root: &str,
    file_name: &str,
    base64: &str,
    dir: &str,
) -> Result<String, String> {
    // The frontend caps a paste at `MAX_ATTACHMENT_BYTES` before it ever
    // encodes, but that is a single caller: a plugin, the chat panel or a
    // future caller can reach this command directly, and the IPC boundary must
    // not trust any of them. Checking the encoded length BEFORE decoding also
    // means an oversized payload is rejected without allocating its bytes.
    //
    // Base64 is 4 characters per 3 bytes, so this bound is the decoded limit
    // rounded up to a whole group — slightly permissive by design, and the
    // exact check follows the decode.
    let encoded_limit = (MAX_IMPORT_BYTES as usize).div_ceil(3) * 4;
    if base64.len() > encoded_limit {
        return Err(format!(
            "attachment is larger than the {} MB limit",
            MAX_IMPORT_BYTES / (1024 * 1024)
        ));
    }
    let bytes = decode_base64(base64)?;
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err(format!(
            "attachment is larger than the {} MB limit",
            MAX_IMPORT_BYTES / (1024 * 1024)
        ));
    }
    let name = sanitize_attachment_name(file_name)?;
    // `sanitize_attachment_name` only constrains the SHAPE of the name, so a
    // rename to `notes.html` used to land an arbitrary file type in the vault.
    // The paste path is for images, so it shares the picker's allowlist.
    if !is_importable_image(Path::new(&name)) {
        return Err(format!("attachment type is not an allowed image: {name}"));
    }
    // Path-confinement guard: validates the vault base resolves inside the
    // vault; the binding is unused (the target dir is resolved below via dir_abs).
    let _root = resolve_within(vault_root, ".")?;
    let dir = dir.trim();
    if Path::new(dir).is_absolute() {
        return Err("attachment dir must be vault-relative".into());
    }
    let dir = if dir.is_empty() || dir == "." {
        ""
    } else {
        dir.trim_matches('/')
    };
    let (dir_abs, dir_rel) = if dir.is_empty() {
        let month = attachment_month_dir();
        let rel = format!("attachments/{month}");
        let abs = resolve_within(vault_root, &rel)?;
        (abs, rel)
    } else {
        resolve_within_rel(vault_root, dir)?
    };
    std::fs::create_dir_all(&dir_abs).map_err(|e| fs_error("create the folder", &dir_abs, e))?;
    let unique = publish_attachment(&dir_abs, &name, &bytes)?;
    Ok(format!("{dir_rel}/{unique}"))
}

#[cfg(test)]
mod create_only_write_tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nekowite-attach-{label}-{}-{}",
            std::process::id(),
            time_nonce()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn overflow_name_is_skipped_when_it_already_exists() {
        let dir = scratch("overflow");
        for n in 0..1000u32 {
            let name = if n == 0 {
                "pic.png".to_string()
            } else {
                format!("pic-{n}.png")
            };
            std::fs::write(dir.join(&name), b"x").unwrap();
        }
        std::fs::write(dir.join("pic-overflow.png"), b"x").unwrap();
        let unique = publish_attachment(&dir, "pic.png", b"new").unwrap();
        assert_eq!(unique, "pic-overflow-1.png");
        assert_eq!(std::fs::read(dir.join(&unique)).unwrap(), b"new");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The claim on a name is the CREATE, not the probe before it: an entry the
    /// probe cannot see (a dangling symlink reads as absent to `exists()`) is
    /// still refused, so a writer that owns the name keeps it.
    #[test]
    #[cfg(unix)]
    fn create_new_bytes_refuses_a_name_a_probe_would_call_free() {
        let dir = scratch("claim");
        let target = dir.join("pic.png");
        std::os::unix::fs::symlink(dir.join("missing.png"), &target).unwrap();
        assert!(!target.exists(), "the probe has to miss this entry");

        assert!(
            matches!(
                create_new_bytes(&target, b"new"),
                Err(CreateFileError::AlreadyExists)
            ),
            "a create-only write must refuse the name the symlink holds"
        );
        assert!(
            std::fs::symlink_metadata(&target)
                .unwrap()
                .file_type()
                .is_symlink(),
            "the existing entry must survive the refused write"
        );

        // And the caller moves on to the next free name instead of failing.
        assert_eq!(
            publish_attachment(&dir, "pic.png", b"new").unwrap(),
            "pic-1.png"
        );
        assert_eq!(std::fs::read(dir.join("pic-1.png")).unwrap(), b"new");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
