/**
 * Tab file operations: adopting an on-disk rename, the app-initiated move
 * claim the external-change service asks about, delete, reload and detaching a
 * tab whose file vanished.
 *
 * The fs gateway, the notification ports and the lifecycle `removeTab` all
 * arrive through `deps` — this module never reaches for a Tauri API or a Pinia
 * store itself.
 */

import type { Ref } from 'vue'
import type { NoteMoveResult } from '../services/note-move'
import { rewriteNoteRefs } from '../services/note-move'
import { deleteNoteWithAssets } from '../services/note-delete'
import type { NoteDeleteResult } from '../services/note-delete'
import type { OpenTab } from './tabs'

/** The slice of the fs gateway the tab file operations use. */
export interface TabFilePort {
  read(vault: string, path: string): Promise<string>
  stat(vault: string, path: string): Promise<unknown>
  deleteFile(vault: string, path: string): Promise<string>
}

export interface TabFileOperationsDeps {
  tabs: Ref<OpenTab[]>
  vault: Ref<string | null>
  files: TabFilePort
  t: (key: string, params?: Record<string, unknown>) => string
  notifyError(message: string): void
  /** Stop the pending autosave timer before a path is detached or reloaded. */
  cancelAutosave(id: string): void
  /** Attribute the app's own writes to us, so the fs watcher does not read
   *  them back as external edits. */
  noteSelfWrite(path: string): void
  /** Remove a tab from the tab set WITHOUT flushing. Lifecycle owns the tab
   *  set; the path-rewrite and delete flows only get to trigger a removal. */
  removeTab(id: string): void
}

export function createTabFileOperations(deps: TabFileOperationsDeps) {
  const { tabs, vault, files, t, notifyError, cancelAutosave, noteSelfWrite, removeTab } = deps

  /**
   * Paths whose rename/move the APP is running right now (see `beginMove`).
   * Unlike the self-write window this is not a timer: it lasts exactly as long
   * as the operation, which is what the external-change service needs to tell
   * "the user renamed this note in the app" from "something deleted it behind
   * our back". Both look identical on disk - the tab's path is momentarily
   * absent - and guessing wrong costs the user the link between an open tab and
   * its file.
   */
  const pendingMoves = new Set<string>()

  function beginMove(from: string): void {
    pendingMoves.add(from)
  }

  function endMove(from: string): void {
    pendingMoves.delete(from)
  }

  /** True while `path` is being moved by the app, or lives under a folder that
   *  is (a folder rename carries every note inside it). */
  function isPendingMove(path: string): boolean {
    if (pendingMoves.size === 0) return false
    const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '')
    const p = norm(path)
    for (const from of pendingMoves) {
      const f = norm(from)
      if (p === f || p.startsWith(`${f}/`)) return true
    }
    return false
  }

  /** Adopt the reference rewrite a note move already wrote to disk. A tab that
   *  is keeping up with disk takes the exact text (the `reloadFromDisk`
   *  pattern); a dirty tab's newer text goes through the same pure rewrite
   *  instead of being clobbered — otherwise its next save would resurrect the
   *  references the move just fixed. */
  function applyMovedContent(tab: OpenTab, from: string, to: string, moved: NoteMoveResult): void {
    const v = vault.value
    if (tab.dirty && v) {
      tab.content = rewriteNoteRefs(tab.content, { vault: v, from, to })
      tab.savedContent = rewriteNoteRefs(tab.savedContent, { vault: v, from, to })
      return
    }
    if (moved.content !== null) {
      tab.content = moved.content
      tab.savedContent = moved.content
    }
  }

  /** Rewrites tab paths after a file/directory rename on disk. Content is left
   * alone unless `moved` says the move also rewrote the note's file-relative
   * references (see `services/noteMove.ts`); tabs keep their dirty state and
   * autosave timers. */
  function retargetAfterRename(from: string, to: string, moved?: NoteMoveResult): void {
    for (const tab of tabs.value) {
      if (!tab.path) continue
      if (tab.path === from) {
        tab.path = to
        if (moved) applyMovedContent(tab, from, to, moved)
        noteSelfWrite(to)
      } else if (tab.path.startsWith(from + '/')) {
        tab.path = to + tab.path.slice(from.length)
        noteSelfWrite(tab.path)
      }
    }
  }

  async function deleteTabFile(id: string): Promise<void> {
    const tab = tabs.value.find((x) => x.id === id)
    if (!tab || !tab.path || !vault.value) return
    const path = tab.path
    let result: NoteDeleteResult
    try {
      // Suppress the delete's own fs-change so the tab is not reloaded from a
      // missing file before deleteTabFile closes it. The note's own
      // `_assets` folder goes to the trash with it: leaving it behind kept the
      // images forever while nothing in the app could list or reclaim them
      // (see services/noteDelete).
      noteSelfWrite(path)
      result = await deleteNoteWithAssets(
        {
          deleteFile: (v, p) => files.deleteFile(v, p),
          exists: async (v, p) => {
            await files.stat(v, p)
            return true
          },
        },
        vault.value,
        path,
      )
    } catch {
      notifyError(t('tabs.deleteFailed'))
      return
    }
    // The note is in the trash; its images are not. Say so rather than report a
    // clean delete - the user has to be able to find them if they want them.
    if (result.assetsFailed) notifyError(t('tabs.deleteAssetsFailed'))
    // Close every tab on that path: autosave from a leftover tab would
    // resurrect the deleted file from stale content.
    for (const open of [...tabs.value]) {
      if (open.path === path) removeTab(open.id)
    }
  }

  /**
   * Detach a tab from a path that no longer exists.
   *
   * A note's folder can be renamed or deleted outside the app, and the backend
   * recreates missing parent directories on write — so leaving the stale path in
   * place meant the next save silently recreated the OLD location, leaving the
   * user with two copies of one note holding different text. Clearing the path
   * turns the tab into an untitled one: the content is kept, the next save asks
   * for a destination (the existing Save-As flow), and the tab is visibly no
   * longer attached to the vanished file. Returns the path it was detached from
   * so the caller can tell the user which file is gone.
   */
  function detachMissingPath(id: string): string | null {
    const tab = tabs.value.find((x) => x.id === id)
    if (!tab || !tab.path) return null
    const gone = tab.path
    cancelAutosave(id)
    tab.path = null
    // The tab now holds text that exists at no path this app knows, so it counts
    // as unsaved work — `content` is the only copy left. Marking it clean (what
    // this did at first) silently disabled every protection that keys off
    // `dirty`: closing the tab, switching vaults, closing the window and the
    // autosave timer all skipped it, so text the user had typed and never
    // written could vanish with no prompt at all. Empty tabs stay clean — there
    // is nothing to protect and prompting over a blank note is pure noise.
    tab.dirty = tab.content.length > 0
    tab.savedContent = tab.dirty ? '' : tab.content
    return gone
  }

  /**
   * Adopt the file's current bytes.
   *
   * `explicit` says WHO asked. The conflict prompt's "use the disk version" is a
   * user decision to throw local edits away, so it must win over everything; the
   * automatic reload that follows an external change must not, because the read
   * takes time and the user may start typing during it — assigning the disk text
   * unconditionally threw those keystrokes away and cleared `dirty`, so the
   * autosave that had already been scheduled found nothing to save and the text
   * was gone with no copy anywhere.
   *
   * **May `explicit` overwrite a dirty tab? Yes — because the user asked, and
   * only because of that.** The overwrite is data loss the user consented to,
   * and the consent is the whole reason this branch exists; anything that
   * reaches it without a person having chosen it is a defect, not a policy
   * difference. Two things hold that line, and both have to keep holding:
   *
   *   - **One caller.** `explicit: true` is passed from exactly one place —
   *     the conflict prompt's reload button (`App.vue` → `ConflictDialog`),
   *     which is also the only path that closes the dialog afterwards. A second
   *     caller appearing is the change to be suspicious of.
   *   - **The prompt must name a real conflict.** `ConflictDialog` styles this
   *     answer as the danger action, puts it first rather than under the hand,
   *     and refuses to focus it on open — so answering it is deliberate. But a
   *     prompt raised where nothing actually changed on disk asks the user to
   *     consent to losing work for no reason, and takes it if they do. That is
   *     why `externalDocSync` identifies the app's own write by its content
   *     before it decides to ask (see `services/external-doc-sync.ts` and
   *     `stores/self-writes.ts`): a false prompt is the only way this branch can
   *     cost the user something they did not agree to.
   *
   * The vault is checked in both cases: the read is asynchronous, and a vault
   * switch in that window must not land another vault's bytes in this tab.
   */
  async function reloadFromDisk(id: string, opts: { explicit?: boolean } = {}): Promise<void> {
    const tab = tabs.value.find((x) => x.id === id)
    if (!tab || !tab.path || !vault.value) return
    cancelAutosave(id)
    const contentAtStart = tab.content
    const path = tab.path
    const vaultAtStart = vault.value
    try {
      const disk = await files.read(vaultAtStart, path)
      if (vault.value !== vaultAtStart || !tabs.value.includes(tab)) return
      if (!opts.explicit && (tab.content !== contentAtStart || tab.dirty)) return
      tab.content = disk
      tab.savedContent = disk
      tab.dirty = false
    } catch {
      notifyError(t('tabs.reloadFailed', { path }))
    }
  }

  return {
    beginMove,
    endMove,
    isPendingMove,
    retargetAfterRename,
    deleteTabFile,
    detachMissingPath,
    reloadFromDisk,
  }
}

export type TabFileOperations = ReturnType<typeof createTabFileOperations>
