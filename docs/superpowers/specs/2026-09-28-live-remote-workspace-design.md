# Live SSH workspaces (Linux)

Zed keeps its interface local and accesses the remote project through SSH and a
remote server. NekoWite's vault APIs instead operate on real, confined Linux
paths. For the first live remote slice, mount a remote SSH directory using the
system's SSHFS into a new folder inside a user-opened vault. This reuses the
existing editor read/write, conflict check, attachment, history and path policy.
No credentials are stored; OpenSSH reads the user's configuration and agent.
Import via rsync remains a separate one-way action.

The connection command authorizes the open vault, validates the SSH identity
and remote path, reserves a new empty local directory, runs `sshfs` in the
foreground with batch authentication and reconnect enabled, and waits for the
kernel to report an actual mount before returning. A failed start removes only
the empty directory it created. Disconnect is restricted to mounts created by
this process; it unmounts first, then removes the empty directory. An unavailable
SSHFS executable is a visible error, never a silent local copy. A remote mount
is transient and must be reconnected after restarting the application.

FUSE mounts do not reliably produce inotify events for changes made on the
server. A two-second poll of the remote tree compares metadata and emits the same
filesystem change events as the local watcher, so external edits refresh tabs
and indexes. A failed poll reports connection degradation. A mount that drops
must not permit writes into the now-unmounted local placeholder.

| Task | Files | Acceptance / test | Rollback risk |
| --- | --- | --- | --- |
| Connection lifecycle | `commands/remote_mount.rs`, IPC manifest and capability | Confined connect/disconnect, mount readiness, cleanup on failure, explicit SSHFS errors; `cargo test --test remote_mount_test` | A live mount must never be removed while active |
| External changes | remote mount poll and fs change event | Remote file changes refresh tabs; failures report disconnected; targeted Rust tests | A large remote tree can make metadata scans expensive |
| UI | remote dialog, client, translations, tests | Switch live/import, show connection error and allow disconnect; targeted Vitest | Import remains available |

The SSHFS deployment prerequisite is explicit. This environment has OpenSSH
but no SSHFS or reachable SSH test host, so a real remote edit must be tested
on a Linux host with SSHFS and SSH access before claiming end-to-end remote
connectivity.
