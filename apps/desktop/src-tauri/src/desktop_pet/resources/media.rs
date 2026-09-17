//! What a file is, from its own bytes.
//!
//! The narrowest responsibility in the module and the one §8's budgets depend on: a sheet's size
//! has to be *measured* before it can be bounded, so the formats this build accepts are exactly
//! the formats whose headers it can read. A format nobody here can measure is a format nobody
//! here can bound, which is why the allow-list is derived from this file rather than chosen
//! beside it — and why `svg`, which is an image by extension and a document by behaviour, is not
//! here at all.
//!
//! Nothing is decoded. A codec defect inside a correctly-typed file is the player's to report;
//! claiming to have checked it would be a claim this build cannot make.

/// The format a file *is*, from its own header, or `None` for one this build cannot name.
///
/// The same four containers [`image_size`] can measure, split out because a downloaded sheet has a
/// second question asked of it that a file on the user's own disk does not: the response said
/// `image/webp`, and the bytes have to agree. One list of magic numbers serves both, so the
/// formats this build accepts and the formats it can measure cannot drift apart — which is the
/// property §8's 「不能校验的就拒绝」 depends on and the reason this is not a second `matches!`.
pub fn image_format(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") && &bytes[12..16] == b"IHDR" {
        return Some("png");
    }
    if bytes.len() >= 10 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        return Some("gif");
    }
    if bytes.len() >= 30 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    if bytes.starts_with(b"\xff\xd8") {
        return Some("jpeg");
    }
    None
}

pub fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    match image_format(bytes)? {
        "png" => Some((be_u32(bytes, 16)?, be_u32(bytes, 20)?)),
        "gif" => Some((le_u16(bytes, 6)? as u32, le_u16(bytes, 8)? as u32)),
        "webp" => webp_size(bytes),
        "jpeg" => jpeg_size(bytes),
        _ => None,
    }
}

/// The three WebP containers, which each store the canvas size differently.
fn webp_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let le_u24 = |at: usize| -> Option<u32> {
        Some(
            *bytes.get(at)? as u32
                | (*bytes.get(at + 1)? as u32) << 8
                | (*bytes.get(at + 2)? as u32) << 16,
        )
    };
    match &bytes[12..16] {
        // Lossy: a 3-byte frame tag, the 0x9d012a start code, then two 14-bit dimensions.
        b"VP8 " if bytes.len() >= 30 && &bytes[23..26] == b"\x9d\x01\x2a" => Some((
            (le_u16(bytes, 26)? & 0x3fff) as u32,
            (le_u16(bytes, 28)? & 0x3fff) as u32,
        )),
        // Lossless: one signature byte, then width-1 and height-1 packed into 28 bits.
        b"VP8L" if bytes.len() >= 25 && bytes[20] == 0x2f => {
            let packed = le_u32(bytes, 21)?;
            Some((packed & 0x3fff, (packed >> 14) & 0x3fff).map_plus_one())
        }
        // Extended: a 24-bit canvas size, stored as one less than the real one.
        b"VP8X" if bytes.len() >= 30 => Some((le_u24(24)? + 1, le_u24(27)? + 1)),
        _ => None,
    }
}

/// Walk JPEG segments to the frame header, which is the only place the size is written.
fn jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if !bytes.starts_with(b"\xff\xd8") {
        return None;
    }
    let mut at = 2usize;
    while at + 3 < bytes.len() {
        if bytes[at] != 0xff {
            return None;
        }
        let marker = bytes[at + 1];
        // Start-of-frame markers, minus the three that share the range and are not frames.
        if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
            let height = be_u16(bytes, at + 5)? as u32;
            let width = be_u16(bytes, at + 7)? as u32;
            return Some((width, height));
        }
        // Every other marker carries its payload length, which is how the walk advances.
        let length = be_u16(bytes, at + 2)? as usize;
        if length < 2 {
            return None;
        }
        at += 2 + length;
    }
    None
}

/// The audio container, from its header.
///
/// Magic only, and deliberately: this module's job is to say what a file *is* so that a
/// mislabelled one does not reach the library, not to decode it. A codec defect inside a
/// correctly-typed file is the player's to report, and pretending otherwise here would be a claim
/// this build cannot make.
pub fn audio_format(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE" {
        return Some("wav");
    }
    if bytes.starts_with(b"OggS") {
        return Some("ogg");
    }
    if bytes.starts_with(b"ID3")
        || (bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0)
    {
        return Some("mp3");
    }
    if bytes.starts_with(b"fLaC") {
        return Some("flac");
    }
    None
}

/// Whether a file is something an engine would run or parse as a document.
///
/// The bytes come first, because that is what decides; the name is consulted second so a file of
/// that shape is refused with the same sentence whatever it is called.
pub(super) fn looks_like_a_document(name: &str, bytes: &[u8]) -> bool {
    let lower = name.to_ascii_lowercase();
    let named = [
        ".svg", ".svgz", ".html", ".htm", ".xhtml", ".xml", ".js", ".mjs", ".cjs", ".css", ".css",
        ".wasm",
    ]
    .iter()
    .any(|extension| lower.ends_with(extension));
    let head = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .map(|at| &bytes[at..])
        .unwrap_or(bytes);
    let shaped = [
        b"<svg".as_slice(),
        b"<?xml",
        b"<!doctype",
        b"<html",
        b"<script",
        b"<style",
    ]
    .iter()
    .any(|opening| {
        head.len() >= opening.len() && head[..opening.len()].eq_ignore_ascii_case(opening)
    });
    named || shaped
}

fn be_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let slice = bytes.get(at..at + 4)?;
    Some(u32::from_be_bytes(slice.try_into().ok()?))
}

fn be_u16(bytes: &[u8], at: usize) -> Option<u16> {
    let slice = bytes.get(at..at + 2)?;
    Some(u16::from_be_bytes(slice.try_into().ok()?))
}

fn le_u16(bytes: &[u8], at: usize) -> Option<u16> {
    let slice = bytes.get(at..at + 2)?;
    Some(u16::from_le_bytes(slice.try_into().ok()?))
}

fn le_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let slice = bytes.get(at..at + 4)?;
    Some(u32::from_le_bytes(slice.try_into().ok()?))
}

/// `(width, height)` with each incremented — the form WebP's lossless header stores.
trait PlusOne {
    fn map_plus_one(self) -> (u32, u32);
}

impl PlusOne for (u32, u32) {
    fn map_plus_one(self) -> (u32, u32) {
        (self.0 + 1, self.1 + 1)
    }
}
