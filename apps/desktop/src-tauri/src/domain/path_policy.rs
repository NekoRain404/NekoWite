//! Path-confinement policy — the SINGLE implementation of "is a requested path
//! actually inside the vault?".
//!
//! Every path a command receives (a vault `base` and a `requested` path) is
//! verified here before any file-system access. There is no other place in the
//! crate that decides whether a path stays inside a vault; storage modules
//! (`file_store`, `trash_store`, ...) resolve paths through these functions and
//! are therefore traceable to a vault root. All functions here are pure (no
//! Fs I/O except canonicalization, no managed state) so they are unit-testable.

use std::io;
use std::path::{Component, Path, PathBuf};

use crate::errors::fs_error;

/// Resolve `requested` against the vault `base` and prove the result stays
/// inside the vault.
///
/// Both the absolute vault root (as returned by the folder dialog) and
/// vault-relative paths (e.g. `"."` or `"docs/hello.mdx"`) are accepted;
/// anything that canonicalizes outside `base`, or traverses with `..`, is
/// rejected. Live symlinks that resolve back inside `base` are allowed
/// (their canonical target still lies within the vault); any symlink that
/// still appears as a component between `base` and the result — including a
/// dangling symlink whose target is currently absent — is rejected, because
/// its target could be materialized later and redirect the read/write
/// outside the vault at use time.
pub fn resolve_within(base: &str, requested: &str) -> Result<PathBuf, String> {
    resolve_within_rel(base, requested).map(|(resolved, _)| resolved)
}

/// Resolve `requested` against the vault `base` and prove the result stays
/// inside the vault, returning both the resolved absolute path and the
/// canonical vault-relative form.
///
/// Both the absolute vault root (as returned by the folder dialog) and
/// vault-relative paths (e.g. `"."` or `"docs/hello.mdx"`) are accepted;
/// anything that canonicalizes outside `base`, or traverses with `..`, is
/// rejected. Live symlinks that resolve back inside `base` are allowed
/// (their canonical target still lies within the vault); any symlink that
/// still appears as a component between `base` and the result — including a
/// dangling symlink whose target is currently absent — is rejected, because
/// its target could be materialized later and redirect the read/write
/// outside the vault at use time.
///
/// The relative form is what history/trash keys are built from: it is
/// canonical (no `.`/`..` components, symlinks resolved away), so an absolute
/// spelling (what `list_dir` entries carry) and a relative spelling of the
/// same file always produce the same key.
pub fn resolve_within_rel(base: &str, requested: &str) -> Result<(PathBuf, String), String> {
    let base_path = Path::new(base);
    if !base_path.is_absolute() {
        return Err("vault root must be an absolute path".into());
    }
    let canonical_base = base_path
        .canonicalize()
        .map_err(|e| fs_error("open the vault root", base_path, e))?;

    let requested_path = Path::new(requested);
    let combined = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        canonical_base.join(requested_path)
    };

    let mut normalized = PathBuf::new();
    for component in combined.components() {
        match component {
            Component::ParentDir => return Err(format!("path escapes vault: {requested}")),
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }

    let canonical =
        canonicalize_loose(&normalized).map_err(|e| fs_error("resolve", &normalized, e))?;
    if !canonical.starts_with(&canonical_base) {
        return Err(format!("path escapes vault: {requested}"));
    }
    reject_symlink_components(&canonical_base, &canonical)?;
    let relative = canonical
        .strip_prefix(&canonical_base)
        .map_err(|_| format!("path escapes vault: {requested}"))?
        .to_string_lossy()
        .to_string();
    // The relative half is the *vault-relative* form, not an OS path: every
    // caller hands it back to the frontend, which joins it into markdown image
    // URLs, compares it against file-tree paths and encodes it into
    // history/trash keys — all of which assume `/`. Windows joins with `\`, so
    // normalise here once instead of at each of the call sites.
    let relative = if std::path::MAIN_SEPARATOR == '\\' {
        relative.replace('\\', "/")
    } else {
        relative
    };
    Ok((canonical, relative))
}

/// Legacy relative-only guard, kept for callers that work purely on
/// vault-relative names. Absolute paths are handled by [`resolve_within`].
pub fn sanitize_path(p: &str) -> Result<PathBuf, String> {
    let path = Path::new(p);
    if path.is_absolute() || path.components().any(|c| c.as_os_str() == "..") {
        return Err("path escapes workspace".into());
    }
    Ok(path.to_path_buf())
}

/// Reject the resolved path if any component between `base` and `path` is a
/// symlink (lstat — non-following). `canonicalize_loose` resolves *live*
/// symlinks away, so only *dangling* symlinks survive as literal components
/// in its missing-tail re-append; those cannot be proven to stay inside the
/// vault, so they are rejected outright.
fn reject_symlink_components(base: &Path, path: &Path) -> Result<(), String> {
    let Some(relative) = path.strip_prefix(base).ok() else {
        return Err("path escapes vault".into());
    };
    let mut probe = base.to_path_buf();
    for component in relative.components() {
        probe.push(component);
        let is_symlink = probe
            .symlink_metadata()
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false);
        if is_symlink {
            return Err("path escapes vault".into());
        }
    }
    Ok(())
}

/// Canonicalize `path` even when its final segment does not exist yet (e.g.
/// a file about to be written): canonicalize the nearest existing ancestor
/// and re-append the missing tail so symlinks can still be resolved.
fn canonicalize_loose(path: &Path) -> io::Result<PathBuf> {
    if let Ok(canonical) = path.canonicalize() {
        return Ok(canonical);
    }
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        match current.canonicalize() {
            Ok(canonical) => {
                let mut out = canonical;
                for segment in missing.iter().rev() {
                    out.push(segment);
                }
                return Ok(out);
            }
            Err(_) => match current.file_name() {
                Some(name) => {
                    missing.push(name.to_os_string());
                    match current.parent() {
                        Some(parent) => current = parent.to_path_buf(),
                        None => return path.canonicalize(),
                    }
                }
                None => return path.canonicalize(),
            },
        }
    }
}

/// Render an absolute path for the FRONTEND.
///
/// Windows canonicalization yields a verbatim path (`\\?\C:\dir\file.md`), and
/// the watcher reports the same spelling. The vault root the frontend holds
/// comes from the native folder dialog and has NO such prefix, so the two were
/// never equal: the file tree could not find the root node for a top-level
/// entry (renaming a file at the vault root silently did nothing), and
/// `fs-change` events never matched the open tab, so an external edit was not
/// picked up. Stripping the prefix here gives every path the frontend sees one
/// consistent spelling. It is display/IPC only — the real `PathBuf` keeps its
/// canonical form for actual I/O, and Rust re-canonicalizes whatever comes back.
pub fn ipc_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    // `\\?\UNC\server\share` is the verbatim form of `\\server\share`.
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    match raw.strip_prefix(r"\\?\") {
        Some(rest) => rest.to_string(),
        None => raw.into_owned(),
    }
}

/// Canonicalize a vault root, rejecting relative paths the same way the fs
/// layer does.
pub fn canonicalize_vault_root(root: &str) -> Result<PathBuf, String> {
    let p = Path::new(root);
    if !p.is_absolute() {
        return Err("vault root must be an absolute path".into());
    }
    p.canonicalize()
        .map_err(|e| fs_error("open the vault root", p, e))
}

/// Resolve a directory inside the vault's own metadata tree
/// (`.nekowite/...`, `.nekowite-trash/...`), creating missing levels, and
/// refuse to follow a symlink out of the vault.
///
/// History and trash directories are reached by a direct `join` rather than
/// through [`resolve_within`] — they are the app's own bookkeeping, not a path
/// the user asked for. That left a hole: a symlinked `.nekowite` or
/// `.nekowite-trash` (a vault unpacked from a hostile archive that preserved
/// symlinks, or one a plugin created) silently redirected every snapshot
/// write, history read and retention delete to an arbitrary path outside the
/// vault.
///
/// Levels are created one at a time, each checked with `symlink_metadata`
/// first, so a symlink is refused *before* anything is created or written
/// beneath it.
///
/// This closes the realistic case: a symlink that is already there. It is not
/// a defence against an attacker who can swap one in between this check and
/// the caller's next syscall — that needs `openat`/`O_NOFOLLOW`, which is out
/// of scope for a directory tree the user already trusts enough to open.
///
/// Returns `Ok(None)` when a level is missing and `create` is false, so a
/// reader can tell "nothing there yet" from "unreadable" without creating
/// anything as a side effect of merely looking.
pub fn resolve_vault_metadata_dir(
    vault_root: &str,
    parts: &[&str],
    create: bool,
) -> Result<Option<PathBuf>, String> {
    let mut current = canonicalize_vault_root(vault_root)?;
    for part in parts {
        // Each component is one plain name by construction (`encode_rel_path`
        // guarantees it for history keys), so anything else is a programming
        // error or an attempt to smuggle a traversal in.
        if part.is_empty()
            || *part == "."
            || *part == ".."
            || part.contains('/')
            || part.contains('\\')
        {
            return Err(format!("invalid vault metadata component: {part}"));
        }
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!(
                    "vault metadata path is a symlink, refusing to use it: {}",
                    current.display()
                ));
            }
            Ok(meta) if !meta.is_dir() => {
                return Err(format!(
                    "vault metadata path is not a directory: {}",
                    current.display()
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if !create {
                    return Ok(None);
                }
                std::fs::create_dir(&current)
                    .map_err(|e| fs_error("create the vault metadata folder", &current, e))?;
            }
            Err(e) => return Err(fs_error("inspect the vault metadata folder", &current, e)),
        }
    }
    Ok(Some(current))
}

/// [`resolve_vault_metadata_dir`] for a writer: the directory is created when
/// missing and always returned.
pub fn create_vault_metadata_dir(vault_root: &str, parts: &[&str]) -> Result<PathBuf, String> {
    resolve_vault_metadata_dir(vault_root, parts, true)?
        .ok_or_else(|| "the vault metadata folder could not be created".to_string())
}

/// [`resolve_vault_metadata_dir`] for a reader: `None` means "not there yet".
pub fn find_vault_metadata_dir(
    vault_root: &str,
    parts: &[&str],
) -> Result<Option<PathBuf>, String> {
    resolve_vault_metadata_dir(vault_root, parts, false)
}

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

/// True when any path component starts with `.`, i.e. the path is a hidden
/// file or lives under a hidden directory (`.nekowite`, `.nekowite-trash`,
/// `.git`, ...). Only real `Normal` components count, so `.`-relative
/// spellings and the root separator do not trip the filter.
pub fn has_hidden_component(p: &Path) -> bool {
    p.components().any(|c| match c {
        Component::Normal(s) => s.to_str().map(|s| s.starts_with('.')).unwrap_or(false),
        _ => false,
    })
}

#[cfg(test)]
mod metadata_dir_tests {
    use super::{create_vault_metadata_dir, find_vault_metadata_dir, resolve_vault_metadata_dir};
    use std::path::{Path, PathBuf};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nekowite-policy-{}-{}-{tag}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn root(vault: &Path) -> String {
        vault.to_string_lossy().to_string()
    }

    #[test]
    fn creates_each_missing_level_under_the_vault() {
        let vault = temp_dir("create");
        let dir = create_vault_metadata_dir(&root(&vault), &[".nekowite", "history", "a%2Fb.md"])
            .expect("creates the whole chain");
        assert!(dir.is_dir());
        assert!(dir.starts_with(vault.canonicalize().unwrap()));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_missing_level_is_none_for_a_reader_and_creates_nothing() {
        let vault = temp_dir("find");
        let found = find_vault_metadata_dir(&root(&vault), &[".nekowite", "history"]).unwrap();
        assert!(found.is_none());
        assert!(
            !vault.join(".nekowite").exists(),
            "merely looking must not create the metadata tree"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_existing_directory_is_returned_to_a_reader() {
        let vault = temp_dir("found");
        create_vault_metadata_dir(&root(&vault), &[".nekowite", "history"]).unwrap();
        let found = find_vault_metadata_dir(&root(&vault), &[".nekowite", "history"])
            .unwrap()
            .expect("it exists");
        assert!(found.is_dir());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn traversal_and_empty_components_are_refused() {
        let vault = temp_dir("traversal");
        for bad in [
            &["..", "escape"][..],
            &["", "x"][..],
            &["."][..],
            &["a/b"][..],
        ] {
            assert!(
                resolve_vault_metadata_dir(&root(&vault), bad, true).is_err(),
                "must refuse {bad:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// The reason this function exists: a metadata tree that has been replaced
    /// by a symlink must be refused, never followed. Unix-only, because
    /// creating a symlink is not a portable operation (and Windows needs a
    /// privilege for it).
    #[cfg(unix)]
    #[test]
    fn a_symlinked_metadata_directory_is_refused_and_nothing_is_written_through_it() {
        let vault = temp_dir("symlink");
        let outside = temp_dir("symlink-outside");
        std::os::unix::fs::symlink(&outside, vault.join(".nekowite")).unwrap();

        assert!(
            create_vault_metadata_dir(&root(&vault), &[".nekowite", "history"]).is_err(),
            "a symlinked .nekowite must be refused, not followed"
        );
        assert!(
            !outside.join("history").exists(),
            "nothing may be created through the symlink"
        );
        // A reader refuses it too, rather than reporting an empty history.
        assert!(find_vault_metadata_dir(&root(&vault), &[".nekowite", "history"]).is_err());

        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_deeper_in_the_metadata_tree_is_refused_too() {
        let vault = temp_dir("deep-symlink");
        let outside = temp_dir("deep-symlink-outside");
        std::fs::create_dir_all(vault.join(".nekowite")).unwrap();
        std::os::unix::fs::symlink(&outside, vault.join(".nekowite").join("history")).unwrap();

        assert!(
            create_vault_metadata_dir(&root(&vault), &[".nekowite", "history", "key"]).is_err()
        );
        assert!(!outside.join("key").exists());
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
