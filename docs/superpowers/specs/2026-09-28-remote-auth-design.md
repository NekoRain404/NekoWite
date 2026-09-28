# Remote SSH authentication

The existing dialog only uses OpenSSH configuration and ssh-agent with
BatchMode enabled. Add explicit agent, private-key and password choices to
both live SSHFS editing and rsync import. Agent remains the default for old
IPC callers. The UI sends only the selected authentication variant and clears
the password after each attempt and when the mode changes.

Reuse SSHFS password_stdin for live connections and sshpass -d 0 for imports.
Secrets are written to the child's pipe, never command arguments, environment,
files, saved state or debug output. Password import requires installed sshpass;
a missing executable returns an actionable error. Private keys must be existing
absolute file paths with no option delimiters; encrypted keys can be unlocked
through ssh-agent. Strict known-host verification stays enabled.
The SSHFS readiness check reads the mounted directory after the SSH handshake,
since mountinfo alone can appear before authentication. Imports use a dedicated
process group so a timed-out sshpass cannot leave rsync writing to staging.

| Task | Files | Acceptance and test | Rollback risk |
| --- | --- | --- | --- |
| Authentication transport | remote_auth.rs, remote_workspace.rs, remote_mount_process.rs | Defaults, invalid values, password stdin and no secret in args; cargo test --test remote_auth_test | Incorrect options can prevent SSH authentication |
| Authentication dialog | RemoteImportDialog.vue, client, translations, tests | Conditional fields, selected variant only, password cleared on failure; targeted Vitest | Old agent behavior must remain the default |
| Release | existing package scripts | typecheck, lint, tests, build, Tauri release and two portable/Arch editions | Existing release is replaced only after successful compile |

Use an isolated loopback SSH server if the installed system tools and FUSE
allow it; report the actual connection evidence separately from unit tests.
