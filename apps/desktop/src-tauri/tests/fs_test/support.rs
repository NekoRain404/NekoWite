//! The fixtures several fs domains share: a temp vault nothing else in the process is using,
//! the separator normaliser the trash assertions compare with, and the mtime pacer the ordering
//! assertions depend on.
//!
//! `b64` and `outside_absolute_dir` are deliberately not here: only the paste-attachment domain
//! needs them, and a fixture one domain needs belongs beside that domain.

use std::path::PathBuf;

pub fn temp_vault(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nekowite-test-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Normalise a path's separators so a test can assert on its trailing
/// components regardless of platform: `restore_from_trash` returns an absolute
/// path, which uses `\` on Windows.
pub fn rel(path: &str) -> String {
    path.replace('\\', "/")
}

/// File mtime granularity is kernel-jiffy coarse, so rapid successive writes
/// can share one timestamp. Pacing the writes that ordering assertions depend
/// on keeps those tests deterministic (no expectation changes).
pub fn tick() {
    std::thread::sleep(std::time::Duration::from_millis(15));
}
