//! Read-only discovery of known Linux agent entry points.
//!
//! Discovery deliberately uses a closed catalog. A PATH can contain arbitrary executables, so
//! treating every filename as an agent would both surprise users and turn a settings scan into
//! process execution. The catalog only reports files that are already present and executable;
//! adding one remains an explicit registry action.

use serde::Serialize;
use std::collections::BTreeSet;
use std::env;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy)]
struct KnownAgent {
    id: &'static str,
    display_name: &'static str,
    command: &'static str,
    kind: &'static str,
    adapter_id: &'static str,
    args: &'static [&'static str],
}

const KNOWN_AGENTS: &[KnownAgent] = &[
    KnownAgent {
        id: "opencode",
        display_name: "OpenCode",
        command: "opencode",
        kind: "acp",
        adapter_id: "opencode",
        args: &[],
    },
    KnownAgent {
        id: "claude",
        display_name: "Claude Code",
        command: "claude",
        kind: "terminal",
        adapter_id: "generic-acp",
        args: &[],
    },
    KnownAgent {
        id: "codex",
        display_name: "Codex",
        command: "codex",
        kind: "terminal",
        adapter_id: "generic-acp",
        args: &[],
    },
    KnownAgent {
        id: "gemini",
        display_name: "Gemini CLI",
        command: "gemini",
        kind: "terminal",
        adapter_id: "generic-acp",
        args: &[],
    },
    KnownAgent {
        id: "qwen",
        display_name: "Qwen Code",
        command: "qwen",
        kind: "terminal",
        adapter_id: "generic-acp",
        args: &[],
    },
    KnownAgent {
        id: "cursor-agent",
        display_name: "Cursor Agent",
        command: "cursor-agent",
        kind: "terminal",
        adapter_id: "generic-acp",
        args: &[],
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryCandidate {
    pub agent_id: String,
    pub display_name: String,
    pub command: String,
    pub program: String,
    pub args: Vec<String>,
    pub kind: String,
    pub adapter_id: String,
}

pub fn discover_known_agents(path_var: Option<&str>) -> Vec<DiscoveryCandidate> {
    let mut search_dirs = BTreeSet::new();
    if let Some(path) = path_var {
        for dir in env::split_paths(path) {
            if !dir.as_os_str().is_empty() {
                search_dirs.insert(dir);
            }
        }
    }
    for dir in ["/usr/local/bin", "/usr/bin", "/bin"] {
        search_dirs.insert(PathBuf::from(dir));
    }

    KNOWN_AGENTS
        .iter()
        .filter_map(|known| {
            let program = search_dirs
                .iter()
                .map(|dir| dir.join(known.command))
                .find(|path| is_executable(path))?;
            Some(DiscoveryCandidate {
                agent_id: known.id.to_string(),
                display_name: known.display_name.to_string(),
                command: known.command.to_string(),
                program: program.to_string_lossy().into_owned(),
                args: known.args.iter().map(|arg| (*arg).to_string()).collect(),
                kind: known.kind.to_string(),
                adapter_id: known.adapter_id.to_string(),
            })
        })
        .collect()
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::discover_known_agents;
    use std::fs;

    #[test]
    fn finds_only_known_executables_and_deduplicates_path() {
        let root = std::env::temp_dir().join(format!("nekowite-discovery-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("mkdir");
        let codex = root.join("codex");
        fs::write(&codex, "#!/bin/sh\n").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&codex).expect("metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&codex, permissions).expect("chmod");
        }
        let path = format!("{}:{}", root.display(), root.display());
        let found = discover_known_agents(Some(&path));
        let codex_matches: Vec<_> = found.iter().filter(|candidate| candidate.agent_id == "codex").collect();
        assert_eq!(codex_matches.len(), 1);
        assert_eq!(codex_matches[0].kind, "terminal");
        let _ = fs::remove_dir_all(root);
    }
}
