# NekoWite Data-Recovery Model

This document describes how NekoWite protects a user's work against loss: version
history, trash, external-edit conflict resolution, crash recovery, and unsaved-work
prompts. Each layer is covered by a unit test (the store/gateway tests) plus the
relevant component test.

The durable source of truth is always the **Markdown/MDX source file on disk**. The
editor model is derived state, never the only copy. Every recovery feature, therefore,
revolves around the on-disk file plus snapshots the gateway records around it.

---

## 1. Version history (snapshot-on-save)

Every successful **save** makes the gateway record a snapshot of the **previous** file
content before overwriting it. The gateway keeps the most recent `maxHistory`
snapshots per file (default 10, from settings). Saving a **new** file does not create a
snapshot (there is nothing to protect).

Closed loop:

- `tabs.saveActive` → `fsService.write(vault, path, content, settings.maxHistory)`.
- The gateway snapshots the prior content, bounded by `maxHistory`.
- The `HistoryPanel` lists versions (newest-first), opens a diff against the current
  content, and calls `tabs.restoreHistoryToActive` to restore a selected version.
- Restoring rewrites the file (via `restoreHistory`), updates the tab's `content` /
  `savedContent`, clears `dirty`, and notes the write as self-originated so the fs-watcher
  does not mistake it for an external change.

Tests: `services/gateways/memory.test.ts` (snapshot + prune + readHistory + restoreHistory),
`stores/tabs.test.ts` `restoreHistoryToActive`, `ui/HistoryPanel.test.ts`.

---

## 2. Trash

Deleting a file moves its content to a trash store rather than destroying it.

Closed loop:

- `tabs.deleteTabFile` → `fsService.deleteFile(vault, path)`. The gateway stores the content
  under a trash key (path-encoded) and returns the trash path. The tab is closed.
- `AppSidebar` lists trash entries and can `restoreFromTrash(vault, trashPath)` — which
  restores the original content to its original path (and refuses if a file already exists
  there). `clearTrash` permanently deletes all entries and returns the count.

Tests: `services/gateways/memory.test.ts` (deleteFile → trash, restoreFromTrash, clearTrash),
`ui/AppSidebar.vue` (restore + clear wired to the gateway).

---

## 3. External-change conflict resolution

The fs-watcher reports changes to a path. When the watched file's on-disk content differs
from what the open tab has, the app must decide whether to reload the disk version or keep
the local (unsaved) version.

Decision function (`services/errors.ts` `decideConflict`):

| Local dirty? | Disk changed? | Decision |
| --- | --- | --- |
| no | yes | `reload` — adopt disk silently |
| yes | yes | `ask` — show the `ConflictDialog` |
| any | no | `none` — nothing to do |

The `ConflictDialog` offers:

- **Use disk (discard local)** — `tabs.reloadFromDisk(tabId)` reads the disk content,
  adopts it, clears `dirty`, and closes the dialog.
- **Keep local** — closes the dialog without touching the tab; the local (unsaved) content
  stays and the tab remains dirty.
- **Later** — closes the dialog; the user can act later (the watcher keeps reporting).
- **Escape** — same as "Later" (closes without action).

The dialog uses `useFocusTrap` to keep keyboard focus inside it while open, restores focus
on close, and is labelled (`role="dialog" aria-modal="true" aria-labelledby`).

Tests: `services/errors.test.ts` (decideConflict), `components/ConflictDialog.test.ts`
(focus trap, reloadDisk adopts disk content, keepLocal keeps local, Escape closes).

---

## 4. Crash recovery

The app never stores unsaved state in a way that is unrecoverable across a hard crash, but
it does lose keystrokes since the last save. The recovery model minimizes that window and
makes the lost window **recoverable** (not silently dropped):

- **Autosave**: a dirty tab schedules a debounced write after the configured
  `autosaveInterval`. Each write becomes a history snapshot, so the last saved version is
  always recoverable.
- **On open**, `openTab` calls `checkCrashRecovery(tabId)`: it lists the file's history and
  stats the current file. If the newest snapshot is **newer** than the file on disk AND
  differs from it, that is the signature of an interrupted write (or an autosave that never
  made it to disk). It surfaces a recovery prompt ("It looks like the app was interrupted
  last time… restore the latest version?"). Restoring calls
  `restoreHistoryToActive`; dismissing leaves the disk file as-is.
- **Temp-asset reconciliation**: paste/drop images are staged in `.tmp` and moved into the
  note's assets dir on first save (`relocatePendingAssets`). If a crash happens before the
  first save, the `.tmp` asset is still on disk and the note body still references it, so a
  later save relocates it. Failed/stranded `.tmp` assets do not block saving (best-effort).

Crash-litter cleanup of orphaned `.tmp` files is **not yet automatic**; it is a known
follow-up. The `.tmp` reference model guarantees no content is silently dropped, only
potentially stranded.

Tests: `stores/tabs.test.ts` `checkCrashRecovery` (differs → prompt, identical → null,
file newer → null), `stores/tabs.test.ts` crash-recovery prompt + restore,
`stores/tabs.test.ts` `.tmp` relocation on first save.

---

## 5. Unsaved-work guard on close

Closing the app (window close) or switching vaults must not silently drop unsaved edits:

- `tabs.hasUnsavedWork()` returns true if any open tab is dirty.
- On `beforeunload`, the app calls `event.preventDefault()` and sets `returnValue` when
  there is unsaved work, so the webview surfaces a native "leave?" confirm. Then it captures
  the session (so tabs are reopened) and flushes window geometry. Because it cannot await an
  async save inside `beforeunload`, the confirm is the guard; the history snapshot from the
  last autosave remains recoverable on reopen.
- On **vault switch** (`App.vue` `applyVault`), the app flushes all path'd dirty tabs
  (`tabs.flushDirty()`) before `closeAll()`. If any save fails it aborts the switch (and
  shows a toast) rather than losing the edits. Untitled tabs are skipped by `flushDirty`
  (they need a Save-As dialog, which a background flush must not open) and are still
  protected by the `beforeunload` prompt on app close.

Tests: `stores/tabs.test.ts` `hasUnsavedWork`, `flushDirty` (saves path'd dirty tabs, skips
untitled, returns false on save failure).

---

## 6. Layout of the recovery layers

```
    Markdown/MDX on disk  ←── the source of truth
      │  save writes + history snapshot
      ▼
   history store (maxHistory per file)  —— restoreHistoryToActive
      │
      ▼
   trash store (deleted content)  —— restoreFromTrash / clearTrash
      │
      ▼
   fs-watcher → decideConflict → ConflictDialog (reload / keep / later)
      │
      ▼
   crash recovery: newest history newer than disk → prompt → restore
      │
      ▼
   unsaved-work guard: beforeunload prompt + vault-switch flushDirty
```

Nothing in the above descends into destroying or rewriting the user's Markdown source
without a recoverable copy and a user-visible confirmation.
