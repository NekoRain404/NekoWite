//! ACP presets and read-only discovery of their Linux launch dependencies.
//!
//! The closed catalog is always returned, including presets that are not currently installed. A
//! PATH can contain arbitrary executables, so the scan only checks known launch dependencies and
//! never executes them; adding a preset remains an explicit registry action.

use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy)]
struct KnownAgent {
    id: &'static str,
    display_name: &'static str,
    launcher: &'static str,
    required_commands: &'static [&'static str],
    adapter_id: &'static str,
    args: &'static [&'static str],
}

const KNOWN_AGENTS: &[KnownAgent] = &[
    KnownAgent {
        id: "opencode",
        display_name: "OpenCode",
        launcher: "opencode",
        required_commands: &["opencode"],
        adapter_id: "opencode",
        args: &["acp"],
    },
    KnownAgent {
        id: "claude-acp",
        display_name: "Claude Code ACP",
        launcher: "npx",
        required_commands: &["npx", "claude"],
        adapter_id: "generic-acp",
        args: &["--yes", "@agentclientprotocol/claude-agent-acp"],
    },
    KnownAgent {
        id: "codex-acp",
        display_name: "Codex ACP",
        launcher: "npx",
        required_commands: &["npx", "codex"],
        adapter_id: "generic-acp",
        args: &["--yes", "@zed-industries/codex-acp"],
    },
    KnownAgent {
        id: "gemini",
        display_name: "Gemini CLI",
        launcher: "gemini",
        required_commands: &["gemini"],
        adapter_id: "generic-acp",
        args: &["--experimental-acp"],
    },
    KnownAgent {
        id: "qwen",
        display_name: "Qwen Code",
        launcher: "qwen",
        required_commands: &["qwen"],
        adapter_id: "generic-acp",
        args: &["--acp"],
    },
    KnownAgent {
        id: "cursor-agent",
        display_name: "Cursor Agent ACP",
        launcher: "cursor-agent",
        required_commands: &["cursor-agent"],
        adapter_id: "generic-acp",
        args: &["--acp"],
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
    pub available: bool,
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

    discover_in_dirs(&search_dirs)
}

fn discover_in_dirs(search_dirs: &BTreeSet<PathBuf>) -> Vec<DiscoveryCandidate> {
    KNOWN_AGENTS
        .iter()
        .map(|known| {
            let commands: BTreeMap<_, _> = known
                .required_commands
                .iter()
                .filter_map(|command| {
                    find_program(&search_dirs, command).map(|path| (*command, path))
                })
                .collect();
            let available = commands.len() == known.required_commands.len();
            let program = commands
                .get(known.launcher)
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default();
            DiscoveryCandidate {
                agent_id: known.id.to_string(),
                display_name: known.display_name.to_string(),
                command: known.launcher.to_string(),
                program,
                args: known.args.iter().map(|arg| (*arg).to_string()).collect(),
                available,
                adapter_id: known.adapter_id.to_string(),
            }
        })
        .collect()
}

fn find_program(search_dirs: &BTreeSet<PathBuf>, command: &str) -> Option<PathBuf> {
    search_dirs
        .iter()
        .map(|directory| directory.join(command))
        .find(|path| is_executable(path))
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
    use super::discover_in_dirs;
    use std::collections::BTreeSet;
    use std::fs;

    #[test]
    fn finds_only_known_executables_and_deduplicates_path() {
        let root = std::env::temp_dir().join(format!("nekowite-discovery-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("mkdir");
        for command in ["codex", "npx"] {
            let program = root.join(command);
            fs::write(&program, "#!/bin/sh\n").expect("write");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut permissions = fs::metadata(&program).expect("metadata").permissions();
                permissions.set_mode(0o755);
                fs::set_permissions(&program, permissions).expect("chmod");
            }
        }
        let found = discover_in_dirs(&BTreeSet::from([root.clone()]));
        let codex_matches: Vec<_> = found
            .iter()
            .filter(|candidate| candidate.agent_id == "codex-acp")
            .collect();
        assert_eq!(codex_matches.len(), 1);
        assert!(codex_matches[0].available);
        assert_eq!(
            codex_matches[0].args,
            ["--yes", "@zed-industries/codex-acp"]
        );
        assert!(found
            .iter()
            .any(|candidate| candidate.agent_id == "claude-acp" && !candidate.available));
        let _ = fs::remove_dir_all(root);
    }
}
