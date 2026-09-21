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
snapshots per file (default 10, from settings). Three things are **not** snapshotted, and
only the first is obvious:

- a **new** file — there is nothing to protect (`storage/history_snapshot.rs` refuses an
  empty relative path);
- a save whose previous content was **empty** (`old_content.is_empty()` returns early) —
  an empty file has no version worth keeping;
- a save whose content is **unchanged** (`storage/save_store.rs`: the snapshot is taken only when
  `!old_content.is_empty() && old_content != content`) — a no-op save does not grow the
  history, which is what keeps a re-save or an autosave tick from pushing real versions out
  of the ten-slot window.

Closed loop:

- `tabs.saveActive` → `fsService.write(vault, path, content, settings.maxHistory)`.
- The gateway snapshots the prior content, bounded by `maxHistory`.
- The `HistoryPanel` lists versions (newest-first), opens a diff against the current
  content, and calls `tabs.restoreHistoryToActive` to restore a selected version.
- Restoring rewrites the file (via `restoreHistory`), updates the tab's `content` /
  `savedContent`, clears `dirty`, and notes the write as self-originated so the fs-watcher
  does not mistake it for an external change.

Tests: `platform/gateways/memory.test.ts` (snapshot + prune + readHistory + restoreHistory),
`stores/tab-recovery.test.ts` `restoreHistoryToActive`, `ui/HistoryPanel.test.ts`.

---

## 2. Trash

Deleting a file moves its content to a trash store rather than destroying it.

Closed loop:

- `tabs.deleteTabFile` → `fsService.deleteFile(vault, path)`. The gateway stores the content
  under a trash key (path-encoded) and returns the trash path. The tab is closed.
- `AppSidebar` (`features/sidebar/components/AppSidebar.vue`) lists trash entries and can
  `restoreFromTrash(vault, trashPath)` — which
  restores the original content to its original path (and refuses if a file already exists
  there). `clearTrash` permanently deletes all entries and returns the count.

Tests: `platform/gateways/memory.test.ts` (deleteFile → trash, restoreFromTrash, clearTrash),
`features/sidebar/composables/use-sidebar-trash.test.ts` (restore + clear wired to the gateway).

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

- **Use disk (discard local)** — `tabs.reloadFromDisk(tabId)` reads the disk content and
  adopts it, clearing `dirty`. **It does not close the dialog**: closing is the caller's
  decision, and `components/ConflictDialog.vue`'s own comment records why ("Deliberately no close
  here") — a component that both performs the reload and dismisses itself cannot be asked
  to reload without dismissing.
- **Keep local** — closes the dialog without touching the tab; the local (unsaved) content
  stays and the tab remains dirty.
- **Later** — closes the dialog; the user can act later (the watcher keeps reporting).
- **Escape** — same as "Later" (closes without action).

The dialog uses `useFocusTrap` to keep keyboard focus inside it while open, restores focus
on close, and is labelled (`role="dialog" aria-modal="true" aria-labelledby`). Focus starts
on the dialog itself rather than its first control, because that control is the destructive
「以磁盘为准」 — see `docs/A11Y.md` §3.

Tests: `services/errors.test.ts` (decideConflict), `components/ConflictDialog.test.ts`
(focus trap, the disk reload asked for rather than performed, keepLocal keeps local, Escape
closes without asking for one).

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
  note's assets dir on first save (`relocate` in `stores/tab-assets.ts`). If a crash happens
  before the first save, the `.tmp` asset is still on disk and the note body still references
  it, so a later save relocates it. Failed/stranded `.tmp` assets do not block saving
  (best-effort).
- **Orphaned `.tmp` scan + auto-GC** (`app/recovery-closed-loop.ts`): on vault open the app
  scans `.tmp`, then partitions the files into *referenced* (still held by an open tab — a
  pending staged asset or a `.tmp` src in the live body) and *orphaned* (crash-litter nobody
  references). Referenced files are left for the normal relocation-on-save. Orphaned files
  surface a **recoverable-versions notice** (Restore moves them into the vault attachment
  library so the image data survives; Dismiss leaves them for the age sweep) and, when older
  than a threshold (7 days), are **auto-GC'd** (moved to the trash, so they stay recoverable)
  provided they are still confirmed untracked. The scan and GC are cancellable and
  non-blocking (fire-and-forget from the bootstrap, never awaiting the vault open), and re-arm
  on each vault switch after cancelling the prior vault's in-flight run.

Tests: `stores/tab-recovery.test.ts` `checkCrashRecovery` (differs → prompt, identical → null,
file newer → null) and crash-recovery prompt + restore, `stores/tab-assets.test.ts` `.tmp`
relocation on first save, `app/recovery-closed-loop.test.ts` (orphan scan → notice +
restore-to-attachments, referenced excluded, GC age threshold, cancel mid-flight).

---

## 5. Unsaved-work guard on close

Closing the app (window close) or switching vaults must not silently drop unsaved edits:

- `tabs.hasUnsavedWork()` returns true if any open tab is dirty.
- **Window close, two routes** (`app/app-lifecycle.ts`, whose header describes both):
  - **Packaged Tauri app** — the window's `close-requested` listener. It **can** await an
    async save, so this is where the placeholders are reconciled and the dirty/untitled
    rescues run before the window is allowed to close. The session is captured and the
    window geometry flushed as part of the same path.
  - **Browser demo** (no Tauri runtime, hence no `close-requested`) — the `beforeunload`
    fallback, which only prompts: `event.preventDefault()` with `returnValue` set when there
    is unsaved work. Nothing async can be awaited there, so the last autosave's history
    snapshot is what makes the work recoverable on reopen.
- On **vault switch** (`app/app-bootstrap.ts` `applyVault`, which hands the work to
  `app/vault-switch.ts`'s `apply`), the app flushes all path'd dirty tabs
  (`tabs.flushDirty()`) before `tabs.removeAllTabs()`, which drops the tab set **without touching the
  filesystem** (`stores/tab-lifecycle.ts`, whose comment states that contract: only for callers that
  have already flushed the dirty tabs and prompted for the untitled ones). The tab-closing *command* the
  user invokes — 「关闭全部」, `stores/tab-close.ts` `closeAll` — does its own flush and prompt first and
  then calls the same `removeAllTabs`. If any save fails
  it aborts the switch (and
  shows a toast) rather than losing the edits. Untitled tabs (no path) are skipped by
  `flushDirty` (they need a Save-As dialog, which a background flush must not open); a switch
  now checks `tabs.untitledDirtyTabs()` and, if any exist, surfaces a **keep-or-discard
  prompt** (`requestUntitledVaultSwitch`) and **blocks the switch** until the user chooses:
  "Restore" saves each via Save-As then proceeds, "Dismiss" discards them then proceeds — so
  unnamed dirty work is never silently dropped by a switch (P0.4).

Tests: `stores/tab-save.test.ts` `hasUnsavedWork` / `flushDirty` (saves path'd dirty tabs,
skips untitled, returns false on save failure), `stores/tab-persistence.test.ts`
`untitledDirtyTabs` / `referencedTmpPaths`; `app/app-lifecycle.test.ts` and
`app/close-requested-unsaved-keystroke.test.ts` (the close-requested route);
`app/recovery-closed-loop.test.ts` `requestUntitledVaultSwitch` (restore → save, dismiss →
discard).

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
   orphaned `.tmp` scan on vault open → recoverable-versions notice + age GC
      │
      ▼
   unsaved-work guard: close-requested (Tauri, can await) /
       beforeunload prompt (browser demo) + vault-switch flushDirty
       + unnamed dirty prompt (keep-or-discard, blocks the switch)
```

Nothing in the above descends into destroying or rewriting the user's Markdown source
without a recoverable copy and a user-visible confirmation.
