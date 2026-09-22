# Agent Discovery and Settings Design

## Goal

Make the Linux ACP workflow easier to understand and use while keeping the settings surface in a modal dialog. Users should be able to discover known local agent programs, review their launch command, add them to the ACP registry, and distinguish ACP agents from native terminal CLIs.

## Product Shape

The settings dialog keeps its current modal shell and gains a clearer Agents information hierarchy:

1. **Overview** shows the active/default engine and whether the agent panel is enabled.
2. **Installed agents** shows registered ACP definitions and their filesystem state.
3. **Discover** scans safe, known Linux command names from `$PATH` and standard user bin locations. A result is only a candidate until the user chooses Add.
4. **Permissions** keeps the existing structured editor.
5. **Run from terminal** explains and configures native CLI commands separately from ACP registration.

The existing manual registration form remains available from Discover and must continue to accept an explicit absolute program path. Discovered entries are never written automatically.

## Linux Discovery Contract

The backend owns discovery because it is the only layer that can reliably inspect executable files and the process environment. The scanner checks a closed catalog of known commands and returns candidates with:

- stable agent id and display name;
- absolute executable path;
- adapter id (`generic-acp`, `opencode`, or another adapter already supported by the build);
- launch arguments suggested by the catalog;
- detected version when the command supports a safe version probe;
- availability state and a reason when unavailable.

The scanner does not execute arbitrary files, inspect shell aliases, or register unknown commands. It must deduplicate a command found in multiple PATH entries and must not include credentials or full environment values in its response.

## Command-Line Entry Points

The Linux binary supports two explicit modes:

- `nekowite agent <agent-id>` opens a session using a registered ACP agent and reuses the normal registry, profile, permission, and lifecycle checks.
- `nekowite terminal <command> [args...]` opens a terminal-thread style session for a native CLI without pretending that the command is ACP.

The GUI remains the source of truth for registry edits and permissions. CLI parsing must reject missing subcommands, unknown agent ids, and an empty terminal command with a readable exit code and message.

## Error and Safety Rules

Discovery failures are reported as an unavailable discovery state with retry; a partial list is still usable. Adding a candidate uses the existing registry validation and persistence transaction. Running or enabling an agent never happens as a side effect of scanning. The terminal command is passed as an argument vector and is never split from a single shell string.

## Verification

- unit tests cover catalog matching, PATH deduplication, unavailable candidates, and version probe failure;
- IPC tests cover discovery output redaction and retry/error behavior;
- component tests cover candidate add, duplicate handling, and the modal hierarchy;
- CLI tests cover both subcommands and invalid input;
- Linux typecheck, lint, full tests, and Tauri build remain required.

