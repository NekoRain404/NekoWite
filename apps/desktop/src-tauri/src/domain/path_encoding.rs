//! The vault-relative path ↔ single-safe-file-name codec, and the safety test
//! the decoded form has to pass before anyone acts on it.
//!
//! Split out of [`super::path_policy`]. That module is the CONFINEMENT policy —
//! is a requested path actually inside the vault — and it is not pure: it
//! canonicalizes, `lstat`s and one of its functions creates directories. This
//! half is pure string work with no filesystem call in it at all, which is what
//! makes it a thing of its own rather than a bag of helpers: history keys and
//! trash keys both stand or fall on the mapping being injective, and that
//! property is checkable without a disk.
//!
//! [`super::path_policy`] re-exports these names, so every caller that reached
//! them through the policy module still does.

/// Encode a vault-relative path into a single safe file name for use under
/// `.nekowite/history/` and `.nekowite-trash/`.
///
/// The mapping is injective, so two distinct paths can never share a history
/// directory or a trash key — the previous `__` scheme collapsed `docs/a.md`
/// and a literal `docs__a.md` (and `.a/b` with `a/b`) onto the same key.
/// `%`, `/`, `_` and a leading `.` are percent-escaped; every other character
/// passes through. Escaping `_` as well keeps the `__` marker out of new
/// keys, which is what lets [`decode_rel_path`] tell legacy keys apart
/// unambiguously. The result never contains `/`, never starts with `.`, and
/// is never `.`/`..`, so it is always exactly one safe filesystem component
/// (a `..` run that merely appears inside the name is harmless — it is part
/// of one component, not a traversal).
pub fn encode_rel_path(p: &str) -> String {
    if p.is_empty() {
        // Not a real path; keep a stable, safe placeholder.
        return "_".into();
    }
    let mut out = String::with_capacity(p.len());
    for (i, c) in p.chars().enumerate() {
        match c {
            '%' => out.push_str("%25"),
            '/' => out.push_str("%2F"),
            '_' => out.push_str("%5F"),
            // A leading dot would make the name hidden (or even `.`/`..`).
            '.' if i == 0 => out.push_str("%2E"),
            c => out.push(c),
        }
    }
    out
}

/// Undo [`encode_rel_path`], recovering the vault-relative path a trash key
/// stands for. Best-effort by design, because trash entries written by the
/// previous `__` encoder must keep working: a name carrying one of our known
/// escape sequences is percent-decoded, a name containing `__` (which the
/// current encoder never emits, since `_` is escaped) is treated as legacy
/// and its `__` markers become `/`, and anything else is itself. A legacy
/// file whose own name contains an uppercase escape sequence can still be
/// mis-decoded — the old scheme was lossy the same way.
pub fn decode_rel_path(encoded: &str) -> String {
    const KNOWN: [&str; 4] = ["%2F", "%25", "%5F", "%2E"];
    if KNOWN.iter().any(|seq| encoded.contains(seq)) {
        return percent_decode(encoded);
    }
    if encoded.contains("__") {
        // Legacy encoder: `/` became `__`.
        let legacy = encoded.replace("__", "/");
        if is_safe_rel(&legacy) {
            return legacy;
        }
    }
    encoded.to_string()
}

/// Unescape exactly the sequences [`encode_rel_path`] emits. `%25` must be
/// replaced last so an escaped `%` is never re-expanded into a fake escape
/// (e.g. the key `%252F` is a literal `%2F`, not a `/`).
fn percent_decode(encoded: &str) -> String {
    const ESCAPES: [(&str, &str); 4] = [("%2F", "/"), ("%5F", "_"), ("%2E", "."), ("%25", "%")];
    let mut out = encoded.to_string();
    for (from, to) in ESCAPES {
        out = out.replace(from, to);
    }
    out
}

/// A decoded relative path is usable only if it is non-empty, not absolute,
/// and has no `.`/`..` components (which the encoding must never produce).
pub fn is_safe_rel(p: &str) -> bool {
    !p.is_empty() && !p.starts_with('/') && !p.split('/').any(|c| c == "." || c == "..")
}
