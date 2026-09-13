# NekoWrite Agent Instructions

## Shell

- Use Git Bash as the shell for all commands in this repository.
- Prefer plain POSIX syntax: `&&`, `||`, `for`, `export`, `test`, `rg`, `sed`, `python`.
- **In Git Bash, `bash` is already on PATH** (`/usr/bin/bash`; GNU bash 5.3.15). Use it directly.
- If the runner cannot pass commands to a custom shell, write a temporary `.sh` file and execute it with Git Bash:
  - `bash "$TEMP_DIR/script.sh"`
  - Absolute path for Bash: `/c/Program\ Files/Git/bin/bash.exe`
  - No-space alias for PowerShell: `C:\GitBin\bash.exe`
- Do not rely on PowerShell for quoting; when a command is complex, put it in a script file.

## Python

- Use `python` from Git Bash.
- Prefer `pathlib` for precise file edits to avoid quoting issues.

## pnpm

- `pnpm` is not on Bash PATH in this environment.
- Use `npx --yes pnpm <command>` in the repository root.
- Alternatively prepend `$HOME/AppData/Roaming/npm` and `$HOME/AppData/Local/pnpm` to PATH.

## User Preferences

- User is in mainland China; use mirrors when network operations are needed.
- Current accent colors are sufficient and should remain unchanged.
- Continue improving complete color theme palettes independently from accent colors.
- Keep the current light/dark themes as the base.
- **Every user-visible change must be delivered as a portable Windows executable.** Run `bash scripts/package-win.sh` after tests/typecheck/lint/build pass, copy `release/nekowite_<version>_x64.exe`, and report the path plus SHA-256. The user runs it directly without installing; do not make the NSIS installer the default.

## Future Codex Configuration

- If the running Codex version supports `[windows] shell_path`, set it to:
  `/c/Program\ Files/Git/bin/bash.exe`
- Otherwise keep using Git Bash directly as described above.
