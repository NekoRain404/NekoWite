//! `binary_registry`'s child: what a file at one of the layout's paths is.
//!
//! Split out of `binary_registry.rs` when it passed §13.1's 600-line default (docs/dev.md §5.4.2:
//! 超过 600 行应默认进入拆分 backlog). The seam is "changes when what a release artifact must *be*
//! changes": the digest read in bounded chunks off the async runtime, its lowercase spelling, and
//! the ELF header checks that can be made without running the file.
//!
//! None of these is a judgement about *this app's* willingness to install something — that is the
//! update gate's — so nothing here reads a release record, a profile or the pointer.

use std::fs;
use std::path::Path;

use sha2::{Digest, Sha256};

use super::layout::LayoutError;
use super::platform::EM_X86_64;

// ---------------------------------------------------------------------------
// What a file at one of those paths is
// ---------------------------------------------------------------------------
//
// The same question [`is_launchable`] answers, asked further: a program at a path is a file with an
// execute bit, an ELF built for the one architecture this release claims, and a specific sequence of
// bytes. It lives here rather than with the update gate that asks it because none of these is a
// judgement about *this app's* willingness to install something — they are facts about a file, and
// the module that names the paths is where facts about what is at them belong.

/// The digest of a file, streamed and off the async runtime.
///
/// A release artifact is a hundred-odd megabytes, so this reads in bounded chunks and hashes as it
/// goes; doing it on the runtime's own thread would stall every other task in the app for the
/// duration.
pub async fn digest_of(path: &Path) -> Result<String, LayoutError> {
    let reading = path.to_path_buf();
    let hashed = tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut file = fs::File::open(&reading).map_err(|error| error.to_string())?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 1 << 20];
        loop {
            let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok::<String, String>(hex(&hasher.finalize()))
    })
    .await
    .map_err(|error| LayoutError::Io {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })?;
    hashed.map_err(|detail| LayoutError::Io {
        path: path.to_path_buf(),
        detail,
    })
}

/// Lowercase hexadecimal, which is the spelling every release record and tool prints.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The first bytes of a file, for [`check_elf`].
///
/// A file shorter than a header is not an error here: it is a candidate that `check_elf` refuses with
/// a sentence about what it actually is, rather than a read failure that reads like the filesystem's
/// problem.
pub fn read_elf_header(path: &Path) -> Result<Vec<u8>, LayoutError> {
    use std::io::Read;
    let mut header = vec![0u8; 64];
    let mut file = fs::File::open(path).map_err(|error| LayoutError::Io {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })?;
    let read = file.read(&mut header).map_err(|error| LayoutError::Io {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })?;
    header.truncate(read);
    Ok(header)
}

/// The ELF header, as the checks that can be made without running the file.
///
/// Deliberately the small set §3.3's architecture check needs, and no more: magic, class, byte order,
/// executable-vs-PIE, and the machine. A fuller validation (program headers, dynamic loader) would be
/// a different claim about a file this host is about to run under its own supervision.
pub fn check_elf(header: &[u8]) -> Result<(), String> {
    if header.len() < 20 || &header[..4] != b"\x7fELF" {
        return Err("the file does not begin with an ELF header".to_string());
    }
    if header[4] != 2 {
        return Err(format!("the ELF is class {} rather than 64-bit", header[4]));
    }
    if header[5] != 1 {
        return Err("the ELF is not little-endian".to_string());
    }
    let kind = u16::from_le_bytes([header[16], header[17]]);
    if kind != 2 && kind != 3 {
        return Err(format!(
            "the ELF is of type {kind}: neither an executable nor a position-independent one"
        ));
    }
    let machine = u16::from_le_bytes([header[18], header[19]]);
    if machine != EM_X86_64 {
        return Err(format!(
            "the program is built for machine {machine:#06x}, and this release installs x86-64 \
             ({EM_X86_64:#06x}) only"
        ));
    }
    Ok(())
}
