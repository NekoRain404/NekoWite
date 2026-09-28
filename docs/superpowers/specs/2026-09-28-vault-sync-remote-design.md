# Vault Git sync and remote workspace design

Status: Git sync and one-way SSH import implemented. Live remote editing is pending. Linux scope only.

The current Sync view is a placeholder. A vault is a user-authorized local directory;
remote development must not silently replace it or grant a second arbitrary root.

## Behavior

- Sync shows repository status, branch, origin, and changed files. An explicit setup
  initializes Git in the current vault. A user enters an SSH or HTTPS origin, then
  explicitly commits, pulls (fast-forward only), or pushes. Authentication uses the
  installed Git/SSH credential setup; NekoWite never stores a password or token.
- A right click on the vault label offers Add Remote. SSH import uses installed rsync
  and OpenSSH on Linux, with rsync required on the remote computer too. It copies a
  remote directory into a fresh folder within the already opened vault. This is an
  explicit one-way import, not SFTP mounting, upload, or live remote development.
  Plain FTP is deferred because it cannot provide a secure authentication channel.
- All IPC operations require an opened vault and run programs with argument vectors,
  bounded output, no terminal password prompts, and failure messages. Git refuses
  pulls with pending changes, so unsaved or uncommitted work cannot be overwritten.

## Tasks

| Task | Files | Acceptance and test | Rollback risk |
| --- | --- | --- | --- |
| Git transport | `commands/vault_git.rs`, handler, ACL, IPC tests | Authorized vault only; initialize/status/configure/commit/pull/push; refusal and failure paths; cargo test vault_git | No existing history removed; Git metadata remains after UI rollback |
| Sync view | `features/sync/*`, notes panel, gateway | Shows status and errors; buttons disabled during operation; cancellation/old vault results discarded; vitest sync tests | No background Git operations |
| Remote entry | sidebar navigation, connection dialog, tests | Right-click opens Add Remote; explicit SSH/SFTP project import and correct missing-tool errors; vitest sidebar tests | Import is a user-triggered copy; no remote deletion |

Review boundary: never run shell interpolation of URL/host/path, never store credentials,
never treat a renderer path as an authorization grant. Git commands have local tests;
the SSH import has simulated success/failure tests, but needs a real SSH server test
before claiming remote connectivity. Upload/conflict handling and continuous remote
development require a separate design and implementation.
