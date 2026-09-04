//! Vault-domain rules: predicates about vault *content* that the storage layer
//! applies while listing, searching and opening files. These know nothing about
//! paths, disk layout or Tauri — they only answer "is this a note?" and "should
//! this entry be hidden from listings?".

use std::path::Path;

/// True when `p` is a Markdown/MDX note path. Paths under `node_modules` are
/// never treated as notes (the references library may live alongside build
/// deps, but a node module is not openable content).
pub fn is_mdx_path(p: &str) -> bool {
    let path = Path::new(p);
    let has_node_modules = path
        .components()
        .any(|c| c.as_os_str() == "node_modules");
    if has_node_modules {
        return false;
    }
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("mdx") | Some("md") | Some("markdown")
    )
}

/// Decide whether an entry should be hidden from listings: hidden files and
/// dirs (name starts with `.`), build output directories (exact dir name),
/// and symlinks. Files whose name merely carries a build-dir prefix (e.g.
/// `dist.md`) are kept — only the exact directory name matches.
pub fn should_skip_entry(name: &str, is_symlink: bool) -> bool {
    if is_symlink {
        return true;
    }
    if name.starts_with('.') {
        return true;
    }
    matches!(name, "node_modules" | "dist" | "build" | "target" | "out")
}
