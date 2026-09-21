/**
 * The note list's delete: the confirmation gate, the once-per-path guard, and
 * the two ways a note reaches the trash.
 *
 * The vault, the setting the gate reads, the tab bookkeeping and the index
 * refresh arrive as parameters, so the flow can be driven without a mounted
 * component and without Pinia.
 */

import { computed, ref, type ComputedRef } from 'vue'
import { fsService } from '../../../platform/gateways/fs'
import { t } from '../../../i18n'
import { deleteNoteWithAssets, noteAssetDirectoryExists } from '../../../services/note-delete'
import { notifyError } from '../../../services/errors'

/** The tab bookkeeping a delete performs. Wired to the tabs store by the
 *  caller; injected so the flow runs without Pinia in a test. */
export interface NoteDeleteTabPort {
  /** The id of the tab open on exactly `path`, or null. */
  tabIdAt(path: string): string | null
  /** The store's own delete-a-file flow: it trashes the file and drops the tab
   *  with the same bookkeeping a manual close uses. */
  deleteTabFile(tabId: string): Promise<void>
}

export interface UseNoteDeleteOptions {
  /** The vault the target note lives in. The delete is aimed at the CURRENT
   *  vault, which is why the vault switch clears a pending question. */
  vault: () => string | null
  /** Whether deleting still asks for a confirmation ("confirm before
   *  deleting"). Read per request: the setting changes under a mounted panel. */
  confirmBeforeDelete: () => boolean
  tabs: NoteDeleteTabPort
  /** Re-run the vault index once the note is gone; the note list is a mirror of
   *  that index (see the caller's `refreshNoteIndex`). */
  refreshIndex: () => Promise<void>
}

export interface NoteDeleteModel {
  /** The note the confirmation step is waiting on, or null. */
  confirmPath: ComputedRef<string | null>
  request(path: string): void
  cancel(): void
  perform(path: string): Promise<void>
}

export function useNoteDelete(options: UseNoteDeleteOptions): NoteDeleteModel {
  /**
   * Paths whose delete is already in flight. One deliberate activation deletes
   * once: a second pick from the menu while the first delete is still running, or
   * a second press on the confirm button, must not aim a second trash entry at a
   * path that is already on its way out. The same guard the file tree keeps.
   */
  const deleting = new Set<string>()

  /** The note the confirmation step is waiting on (never set while the gate is
   *  off — then the menu pick is the whole gesture). */
  const confirmPath = ref<string | null>(null)

  /**
   * Ask for `path` to be deleted.
   *
   * Deleting is destructive, so by default the menu item only arms the card and
   * the following confirm button performs the delete; with "confirm before
   * deleting" switched off that button is the whole gesture, exactly as in the
   * file tree.
   */
  function request(path: string): void {
    if (deleting.has(path)) return
    if (!options.confirmBeforeDelete()) {
      void perform(path)
      return
    }
    confirmPath.value = path
  }

  function cancel(): void {
    confirmPath.value = null
  }

  async function perform(path: string): Promise<void> {
    if (deleting.has(path)) return
    deleting.add(path)
    const vault = options.vault()
    try {
      if (!vault) return
      const tabId = options.tabs.tabIdAt(path)
      if (tabId !== null) {
        // The tabs store deletes the note WITH its `_assets` folder and closes
        // every tab on that path, so the open-note branch owns the whole gesture.
        await options.tabs.deleteTabFile(tabId)
      } else {
        // A note with no tab still owns a `<basename>_assets` folder; leaving it
        // behind kept its images on disk while nothing in the app could list or
        // reclaim them.
        const result = await deleteNoteWithAssets(
          {
            deleteFile: (v, p) => fsService.deleteFile(v, p),
            exists: (v, p) => noteAssetDirectoryExists(fsService, v, p),
          },
          vault,
          path,
        )
        // The note is gone, its images are not: say so rather than report a clean
        // delete — the user has to be able to find them if they want them.
        if (result.assetsFailed) notifyError(t('filetree.deleteAssetsFailed'))
      }
    } catch {
      notifyError(t('filetree.deleteFailed'))
    } finally {
      deleting.delete(path)
      confirmPath.value = null
      await options.refreshIndex()
    }
  }

  return {
    confirmPath: computed(() => confirmPath.value),
    request,
    cancel,
    perform,
  }
}
