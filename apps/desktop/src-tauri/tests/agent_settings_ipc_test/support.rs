use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::agent_runtime::config_edit::ConfigEdit;
use crate::agent_settings::CredentialSubmission;

/// A scratch directory *inside the repository*.
///
/// §3.2 and this task's brief both require that a development profile is never the developer's own:
/// a test that wrote to `$XDG_CONFIG_HOME` would be reading and writing the real OpenCode
/// configuration of whoever ran it. `target/` is inside the crate, is where build output already
/// lives, and is ignored by git — and `$HOME` is never consulted anywhere in this file.
/// The value these tests must never find in a readout, a `Debug` line or a refusal.
pub const SECRET_VALUE: &str = "sk-live-0123456789abcdef-NEVER-PRINTED";

pub fn scratch(label: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/agent-settings-test")
        .join(format!("{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch directory");
    dir
}

/// Every file under `root`, concatenated — the evidence for "this secret is not in that profile".
pub fn tree_text(root: &Path) -> String {
    let mut out = String::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(text) = fs::read_to_string(&path) {
                out.push_str(&text);
                out.push('\n');
            }
        }
    }
    out
}

/// A configuration with everything a real one has and a formatter would eat: two kinds of comment,
/// a trailing comma in a nested object, and a member this build knows nothing about.
pub const CONFIG: &str = r#"{
  // The model this engine starts with.
  "model": "anthropic/claude-sonnet-4",
  /* Provider blocks are keyed by provider id.
     An unreadable member below is kept exactly as written. */
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "sk-not-a-real-key-000000",
      },
    },
  },
  "experimental": { "someFutureFlag": true },
}
"#;

pub fn write_config(root: &Path, relative: &str, text: &str) -> PathBuf {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, text).unwrap();
    path
}

/// The relative path a settings page uses for OpenCode's document. The adapter owns this string
/// (§3.4's last line); this test only needs one that is inside the profile.
pub const RELATIVE: &str = "XDG_CONFIG_HOME/opencode/opencode.jsonc";

pub fn set(name: &str, value: &str) -> CredentialSubmission {
    CredentialSubmission::Set {
        name: name.to_string(),
        value: value.to_string(),
    }
}

pub fn remove(name: &str) -> CredentialSubmission {
    CredentialSubmission::Remove {
        name: name.to_string(),
    }
}

pub fn edit(path: &[&str], value: Value) -> ConfigEdit {
    ConfigEdit::set(path.iter().map(|name| name.to_string()).collect(), value).unwrap()
}
