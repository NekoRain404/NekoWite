//! Operating-system integration commands.
//!
//! Today there is exactly one question here - "which accent colour did the user
//! pick in Windows?" - asked by the appearance settings when "follow system
//! accent" is on. The read is Windows-only and best-effort: on any other
//! platform, or when the registry values are missing/unreadable, the command
//! answers `None` and the frontend keeps its own theme-based pick. The settings
//! panel reports which of the two happened, so the option never silently claims
//! to have followed a system colour it could not see.
//!
//! The registry is read by running `reg.exe query` rather than calling the Win32
//! registry API: this crate has no `windows`/`windows-sys` dependency, and one
//! short-lived console-less child process per settings change is a smaller price
//! than adding one. `CREATE_NO_WINDOW` keeps the console from flashing.

use serde::Serialize;

/// `HKCU\...\Explorer\Accent` - written by the Settings app when the user picks
/// an accent colour, as `0xAABBGGRR` (alpha first, then blue, green, red).
/// Verified against a real Windows 11 machine: `0xffd47800` is `#0078d4`.
const EXPLORER_ACCENT_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Accent";
const EXPLORER_ACCENT_VALUE: &str = "AccentColorMenu";

/// `HKCU\...\DWM` - the colour DWM derives for window borders and title bars, as
/// `0xAARRGGBB` (alpha first, then red, green, blue). DWM usually keeps it equal
/// to the accent, so it is the fallback for a user who never picked one
/// explicitly. Verified: `0xc40078d4` is the same `#0078d4`.
const DWM_KEY: &str = r"Software\Microsoft\Windows\DWM";
const DWM_VALUE: &str = "ColorizationColor";

/// The accent colour the operating system reports, plus where it came from.
///
/// The frontend only needs `r`/`g`/`b`; `source` exists because a wrong-looking
/// accent is otherwise impossible to diagnose on a machine a developer cannot
/// inspect ("the accent-menu value was present but stale" reads very differently
/// from "we fell back to DWM").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SystemAccent {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub source: &'static str,
}

/// `0xAABBGGRR` -> `(r, g, b)`: the low byte is red and the alpha byte on top is
/// dropped. This is the byte order the accent menu stores (`0xffd47800` is
/// `#0078d4`, not `#d47800`).
fn decode_abgr(raw: u32) -> (u8, u8, u8) {
    let r = (raw & 0xFF) as u8;
    let g = ((raw >> 8) & 0xFF) as u8;
    let b = ((raw >> 16) & 0xFF) as u8;
    (r, g, b)
}

/// `0xAARRGGBB` -> `(r, g, b)`. The alpha byte is dropped: an accent is opaque.
/// This is DWM's byte order (`0xc40078d4` is also `#0078d4`).
fn decode_argb(raw: u32) -> (u8, u8, u8) {
    let r = ((raw >> 16) & 0xFF) as u8;
    let g = ((raw >> 8) & 0xFF) as u8;
    let b = (raw & 0xFF) as u8;
    (r, g, b)
}

/// Resolves the accent from a `(subkey, value name) -> raw DWORD` reader.
///
/// Split from the registry read itself so the precedence between the two sources
/// and the byte order of each one are covered by tests that never touch a real
/// registry - and therefore cannot be made to pass or fail by however the
/// machine running the tests happens to be themed.
pub fn resolve_system_accent<F>(read: F) -> Option<SystemAccent>
where
    F: Fn(&str, &str) -> Option<u32>,
{
    if let Some(raw) = read(EXPLORER_ACCENT_KEY, EXPLORER_ACCENT_VALUE) {
        let (r, g, b) = decode_abgr(raw);
        return Some(SystemAccent {
            r,
            g,
            b,
            source: "explorer-accent-menu",
        });
    }
    read(DWM_KEY, DWM_VALUE).map(|raw| {
        let (r, g, b) = decode_argb(raw);
        SystemAccent {
            r,
            g,
            b,
            source: "dwm-colorization",
        }
    })
}

/// Reads one `REG_DWORD` out of a `reg.exe query` listing.
///
/// `reg query <key> /v <name>` prints the key path on its own line and then a
/// value line `    <name>    REG_DWORD    0x<hex>`; a missing key or value
/// prints nothing on stdout (the message goes to stderr). Matching the FIRST
/// token keeps the `HKEY_CURRENT_USER\...` echo from being mistaken for a value,
/// and requiring the `0x` prefix means a number we cannot interpret (rather than
/// a bare one we would have to guess the base of) yields `None`.
fn parse_reg_dword(output: &str, name: &str) -> Option<u32> {
    output.lines().find_map(|line| {
        let mut tokens = line.split_whitespace();
        if tokens.next()? != name {
            return None;
        }
        if !tokens.next()?.eq_ignore_ascii_case("REG_DWORD") {
            return None;
        }
        let raw = tokens.next()?;
        let digits = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X"))?;
        u32::from_str_radix(digits, 16).ok()
    })
}

/// The real reader: one `reg.exe query` process per call.
#[cfg(windows)]
fn read_reg_dword(key: &str, name: &str) -> Option<u32> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    // CREATE_NO_WINDOW: `reg.exe` is a console program and this app has no
    // console, so without the flag the child would flash a black window.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // `reg.exe` is not guaranteed to be on PATH; %SystemRoot%\System32 is.
    let program = std::env::var("SystemRoot")
        .map(|root| format!(r"{root}\System32\reg.exe"))
        .unwrap_or_else(|_| "reg".to_string());
    let output = Command::new(program)
        .args(["query", &format!(r"HKCU\{key}"), "/v", name])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_reg_dword(&String::from_utf8_lossy(&output.stdout), name)
}

#[cfg(not(windows))]
fn read_reg_dword(_key: &str, _name: &str) -> Option<u32> {
    None
}

/// The user's accent colour, or `None` when the platform cannot answer.
///
/// Never fails: "no answer" is a normal state the frontend renders honestly
/// ("couldn't read it, using the theme pick instead"), not an error surface.
#[tauri::command]
pub async fn system_accent_color() -> Option<SystemAccent> {
    resolve_system_accent(read_reg_dword)
}

#[cfg(test)]
mod system_accent_tests {
    use super::*;

    /// Both values as they exist on a real Windows 11 machine (read with
    /// `reg query`); each encodes `#0078d4` in its own byte order, so flipping a
    /// decoder's channel order breaks one of these two tests and nothing else.
    const REAL_ACCENT_MENU: u32 = 0xffd4_7800;
    const REAL_COLORIZATION: u32 = 0xc400_78d4;
    const REAL_RGB: (u8, u8, u8) = (0x00, 0x78, 0xd4);

    fn rgb(accent: SystemAccent) -> (u8, u8, u8) {
        (accent.r, accent.g, accent.b)
    }

    #[test]
    fn the_explorer_accent_menu_is_decoded_as_abgr() {
        let raw = |key: &str, name: &str| {
            (key == EXPLORER_ACCENT_KEY && name == EXPLORER_ACCENT_VALUE)
                .then_some(REAL_ACCENT_MENU)
        };
        let accent = resolve_system_accent(raw).expect("the accent menu value is present");
        assert_eq!(rgb(accent), REAL_RGB);
        assert_eq!(accent.source, "explorer-accent-menu");
    }

    #[test]
    fn the_dwm_value_is_decoded_as_argb_and_used_as_a_fallback() {
        let raw = |key: &str, name: &str| {
            (key == DWM_KEY && name == DWM_VALUE).then_some(REAL_COLORIZATION)
        };
        let accent = resolve_system_accent(raw).expect("dwm fallback");
        assert_eq!(rgb(accent), REAL_RGB);
        assert_eq!(accent.source, "dwm-colorization");
    }

    #[test]
    fn the_users_own_pick_wins_over_the_derived_dwm_colour() {
        // Both present and different: the accent menu holds the colour picked in
        // Settings, DWM holds one derived from it (and goes stale when the user
        // turns "show accent colour on title bars" off).
        let raw = |key: &str, _name: &str| {
            if key == EXPLORER_ACCENT_KEY {
                Some(REAL_ACCENT_MENU)
            } else if key == DWM_KEY {
                Some(0xc4ff_0000)
            } else {
                None
            }
        };
        let accent = resolve_system_accent(raw).expect("accent");
        assert_eq!(rgb(accent), REAL_RGB);
        assert_eq!(accent.source, "explorer-accent-menu");
    }

    #[test]
    fn a_machine_without_the_values_yields_none() {
        assert!(resolve_system_accent(|_, _| None).is_none());
    }

    #[test]
    fn the_alpha_byte_never_bleeds_into_the_colour() {
        // Windows stores a meaningless alpha (0xff for the menu, 0xc4 for DWM);
        // only the low three bytes are the colour.
        assert_eq!(decode_abgr(REAL_ACCENT_MENU & 0x00ff_ffff), REAL_RGB);
        assert_eq!(decode_argb(REAL_COLORIZATION & 0x00ff_ffff), REAL_RGB);
    }

    #[test]
    fn a_reg_query_line_yields_its_dword() {
        // Exactly what `reg query HKCU\...\Accent /v AccentColorMenu` prints,
        // CRLF line endings included.
        let output = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Accent\r\n    AccentColorMenu    REG_DWORD    0xffd47800\r\n";
        assert_eq!(
            parse_reg_dword(output, "AccentColorMenu"),
            Some(REAL_ACCENT_MENU)
        );
    }

    #[test]
    fn another_value_in_the_same_output_is_not_mistaken_for_ours() {
        let output = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Accent\r\n    StartColorMenu    REG_DWORD    0xffc06700\r\n    AccentColorMenu    REG_DWORD    0xffd47800\r\n";
        assert_eq!(
            parse_reg_dword(output, "AccentColorMenu"),
            Some(REAL_ACCENT_MENU)
        );
        assert_eq!(parse_reg_dword(output, "StartColorMenu"), Some(0xffc0_6700));
    }

    #[test]
    fn an_error_message_parses_to_none() {
        // `reg query` writes the failure to stderr and exits non-zero, but even
        // if it ever appeared on stdout it must not look like a colour.
        let output =
            "ERROR: The system was unable to find the specified registry key or value.\r\n";
        assert_eq!(parse_reg_dword(output, "AccentColorMenu"), None);
    }

    #[test]
    fn a_value_of_another_type_is_not_read_as_a_colour() {
        let output = "    AccentColorMenu    REG_SZ    #0078d4\r\n";
        assert_eq!(parse_reg_dword(output, "AccentColorMenu"), None);
    }

    #[test]
    fn a_number_without_the_0x_prefix_is_refused() {
        // Guessing the base of a bare number could report a wildly different
        // colour; answering "unknown" makes the frontend say so instead.
        let output = "    AccentColorMenu    REG_DWORD    16742400\r\n";
        assert_eq!(parse_reg_dword(output, "AccentColorMenu"), None);
    }
}
