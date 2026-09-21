//! The rules that decide whether a draft is acceptable, and the one redaction of a value that may
//! be printed.
//!
//! A module of its own rather than a section of [`super`], and the split is by what makes each part
//! change. This file moves when a *rule* moves — the id charset §3.2's directory names require, the
//! bytes `execve` cannot carry, which variable names may reach a process at all, and which of those
//! names make a value a credential. Nothing here knows about a registry: the same predicates answer
//! for a definition ([`super::registration`]) and for a profile binding ([`super::table`]), which
//! is why they are not a private section of either.

use std::fs;

use super::error::RegistryError;

const MAX_ID_BYTES: usize = 64;

/// Refuses what `execve` cannot carry, which is the *whole* of argument validation:
/// §3.4.3 forbids concatenating a command line, and this crate keeps that promise
/// structurally rather than textually — no function here takes a command line, so an argument
/// containing spaces has no path through this module that could split it on them. What is left
/// to reject is the NUL byte, the one thing a C string cannot hold.
pub fn validate_args(args: &[String]) -> Result<(), RegistryError> {
    match args.iter().position(|arg| arg.contains('\0')) {
        Some(index) => Err(RegistryError::Argument { index }),
        None => Ok(()),
    }
}

/// Whether a variable can be handed to a process at all (ported from Zed's
/// `util::redact::is_valid_environment_name`).
pub(super) fn is_valid_environment_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('=') && !name.chars().any(char::is_control)
}

/// Whether a value must never be printed — ported from Zed's `util::redact::should_redact`,
/// with the name upper-cased first: `ANTHROPIC_API_KEY` and `anthropic_api_key` are the same
/// variable to the kernel while only one is the conventional spelling, and under-redacting is
/// the dangerous direction (the cost is that a name like `MONKEY` is masked too).
fn is_credential_name(name: &str) -> bool {
    const SUFFIXES: [&str; 7] = [
        "KEY",
        "TOKEN",
        "PASSWORD",
        "SECRET",
        "PASS",
        "CREDENTIALS",
        "LICENSE",
    ];
    let upper = name.to_ascii_uppercase();
    SUFFIXES.iter().any(|suffix| upper.ends_with(suffix))
}

/// An environment with credential-bearing values replaced by `<redacted>`: the one form of
/// `env_extra` that may be printed.
///
/// By *name* here and by *value* in `process::stderr::redact` (which scrubs the engine's stderr of the
/// strings this host injected) — not redundant, since this side knows only what a variable is
/// called and that side only what was sent.
pub fn redacted_env(env: &[(String, String)]) -> Vec<(String, String)> {
    env.iter()
        .map(|(name, value)| {
            let value = if is_credential_name(name) {
                "<redacted>".to_string()
            } else {
                value.clone()
            };
            (name.clone(), value)
        })
        .collect()
}

/// Whether an id can be an identity and a path component.
///
/// §3.2's layout puts a profile id and a vault id into directory names
/// (`agent-profiles/<profile-id>/`), so the charset is the path-component charset: nothing that
/// could leave the managed root, nothing that would hide the directory, nothing a log line
/// would read as syntax.
pub(super) fn validate_id(field: &'static str, value: &str) -> Result<(), RegistryError> {
    let usable = !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value != "."
        && value != ".."
        && !value.starts_with('.')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if usable {
        Ok(())
    } else {
        Err(RegistryError::Id {
            field,
            value: value.to_string(),
        })
    }
}

pub(super) fn is_executable(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}
