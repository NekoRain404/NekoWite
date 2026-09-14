/**
 * The one place a note (or a folder) is actually moved, for BOTH the file tree
 * and the note list's rename.
 *
 * This is the file tree's move flow, extracted verbatim rather than copied: the
 * rename menu on a note card does the same move as a tree rename, and a second
 * implementation would drift. What makes that more than tidiness is the
 * bookkeeping around the move, which is invisible in the rename's result and
 * expensive to get wrong:
 *
 *   - `flushEdits()` first. The move is a read-modify-write of the file on disk
 *     (see `noteMove`), while each editor pane coalesces keystrokes before
 *     publishing them to the tab. Without the flush, the note moves and then the
 *     debounced keystrokes are written over the rewrite.
 *   - `noteSelfWrite(from)` and `noteSelfWrite(to)` BEFORE the first mutation.
 *     The fs watcher reports the app's own rename/rewrite back to it; without
 *     the claims a dirty tab raises a bogus keep-or-reload prompt for a file the
 *     user (or the app, on their behalf) just moved.
 *   - `beginMove(from)`/`endMove(from)`. A watcher reports a rename as a change
 *     to the parent folder, so `externalDocSync` looks at every open tab inside
 *     it while the tab still points at the old name — which no longer exists
 *     once the rename has landed and `renamePathInTabs` has not run yet. Without
 *     the claim the tab is detached as if the file had been moved behind the
 *     user's back.
 *
 * Both callers therefore reach the same steps in the same order, and a move can
 * only be written one way. The tabs store is resolved inside the functions (the
 * `export.ts` pattern) so this module has no import-time Pinia dependency and
 * stays usable from a component test that only mounts the panel.
 */

import { fsService } from '../platform/gateways/fs'
import { useTabsStore } from '../stores/tabs'
import { flushEdits } from './editor-ownership'
import { moveNote } from './note-move'
import type { NoteMoveIo } from './note-move'

/** The four fs operations `moveNote` wants, bound to the shared gateway. The
 *  service takes them as plain functions so it stays testable without Tauri
 *  (the injection shape `externalDocSync` / `recoveryClosedLoop` use). */
const noteMoveIo: NoteMoveIo = {
  read: (vault, path) => fsService.read(vault, path),
  // `moveNote` writes the rewritten body and reports its own failures; the
  // warning channel (a history snapshot that could not be kept) is not its to
  // surface — the tab's save does that.
  write: (vault, path, content) => fsService.write(vault, path, content).then(() => undefined),
  rename: (vault, from, to) => fsService.renameEntry(vault, from, to),
  list: (vault, dir) => fsService.list(vault, dir),
}

/**
 * Move a tree entry and keep everything that points at it in step: the note's
 * file-relative references and sibling `_assets` folder (via `moveNote`), the
 * open tab's path, and — when the service rewrote the body on disk — the tab's
 * text.
 *
 * `isDir` moves a folder as a plain rename: it carries its contents, so each
 * note's own `_assets` references still resolve and only the tab paths change.
 * References OUT of the folder (the vault-level `attachments/` tree) would need
 * every note inside to be rewritten; that subtree case is deliberately left as
 * a plain rename.
 */
export async function moveEntry(
  vault: string,
  from: string,
  to: string,
  isDir: boolean,
): Promise<void> {
  const tabs = useTabsStore()
  // Publish pending keystrokes first: the service is a read-modify-write of the
  // file on disk, while each pane coalesces keystrokes before publishing them
  // to the tab (the same reason `saveTab` flushes before it writes).
  await flushEdits()
  // Arm BOTH spellings before the first mutation (see the module header).
  tabs.noteSelfWrite(from)
  tabs.noteSelfWrite(to)
  tabs.beginMove(from)
  try {
    if (isDir) {
      await fsService.renameEntry(vault, from, to)
      tabs.renamePathInTabs(from, to)
      return
    }
    const moved = await moveNote(noteMoveIo, vault, from, to)
    tabs.renamePathInTabs(from, to, moved)
  } finally {
    tabs.endMove(from)
  }
}

/**
 * A move can fail AFTER its rename landed: `moveNote` rewrites the body at the
 * new path and its own rollback is best effort. When that happens the tab is
 * left pointing at a name that no longer exists — the app would then report the
 * user's own rename as an external deletion, detach the note and turn Ctrl+S
 * into a native "save as". Point the tabs at whichever file really exists and
 * let the editor adopt its bytes (a dirty tab keeps the user's text; see
 * `reloadFromDisk`).
 */
async function retargetAfterFailedMove(vault: string, from: string, to: string): Promise<void> {
  const tabs = useTabsStore()
  const exists = async (path: string): Promise<boolean> => {
    try {
      await fsService.read(vault, path)
      return true
    } catch {
      return false
    }
  }
  if (await exists(from)) return
  if (!(await exists(to))) return
  tabs.renamePathInTabs(from, to)
  for (const tab of tabs.tabs) {
    if (tab.path === to) void tabs.reloadFromDisk(tab.id)
  }
}

/**
 * Both ways of moving a note — the inline rename in either list and the tree's
 * drag-and-drop — need the same repair, because both can fail after the rename
 * itself landed. Throws the original error so the caller keeps wording its own
 * message.
 */
export async function moveOrRepair(
  vault: string,
  from: string,
  to: string,
  isDir: boolean,
): Promise<void> {
  try {
    await moveEntry(vault, from, to, isDir)
  } catch (error) {
    await retargetAfterFailedMove(vault, from, to)
    throw error
  }
}
