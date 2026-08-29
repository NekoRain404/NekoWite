use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_mdx: bool,
}

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

pub fn sanitize_path(p: &str) -> Result<PathBuf, String> {
    let path = Path::new(p);
    if path.is_absolute() || path.components().any(|c| c.as_os_str() == "..") {
        return Err("path escapes workspace".into());
    }
    Ok(path.to_path_buf())
}
