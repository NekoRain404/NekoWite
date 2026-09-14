/**
 * The trash section: the entries a vault is holding, the two commands that act
 * on them, and the armed state of the two-step clear (§13.4).
 *
 * The vault arrives as a getter because it is switched under a mounted sidebar;
 * every command here is vault-scoped, and so is the one reset this state needs
 * — a new vault cannot inherit the previous one's armed clear.
 *
 * The reads go through the fs gateway, which is where the trash lives: nothing
 * here touches the disk directly (§13.5).
 */

import { ref, watch } from 'vue'
import { fsService } from '../../../platform/gateways/fs'
import type { TrashEntry } from '../../../platform/gateways/contracts'
import { announce } from '../../../services/announcer'
import { notifyError } from '../../../services/errors'
import { baseName } from '../../../services/paths'
import { t } from '../../../i18n'

export interface UseSidebarTrashOptions {
  vault: () => string
}

export function useSidebarTrash(options: UseSidebarTrashOptions) {
  const trashEntries = ref<TrashEntry[]>([])
  /**
   * Set when the last read of the trash FAILED. "The trash is empty" and "the
   * trash could not be read" must never render the same: the second one is the
   * answer a user gets when a permission problem hides their deleted notes, and
   * calling it empty says those notes are gone.
   */
  const trashUnreadable = ref(false)
  const clearingTrash = ref(false)

  /**
   * Every read takes a ticket; only the newest one may write.
   *
   * `refreshTrash` runs on open, after a restore and after a clear, and the
   * sidebar survives a vault switch — so a read can be overtaken while it is in
   * flight, and the reads do not have to settle in the order they started.
   * Without the ticket the later-RESOLVING list won: the vault that is no longer
   * open had its entries (and its `trash_path`s) rendered under the current one.
   * Same policy as `useHistoryPanel.load`; it also covers two reads of the SAME
   * vault, where the older list is simply the staler one.
   */
  let readSeq = 0

  async function refreshTrash(): Promise<void> {
    const seq = ++readSeq
    try {
      const entries = await fsService.listTrash(options.vault())
      if (seq !== readSeq) return
      trashEntries.value = entries
      trashUnreadable.value = false
    } catch (e) {
      // A read the user has already left behind reports nothing: the failure is
      // about a vault that is no longer open, and the newer read says what this
      // one's trash state actually is.
      if (seq !== readSeq) return
      // The list is unknown, not empty. Keep the flag so the panel asks the
      // user to fix the read instead of claiming there is nothing to recover,
      // and surface the backend reason (which folder, what the OS said).
      trashEntries.value = []
      trashUnreadable.value = true
      notifyError(e instanceof Error ? e.message : String(e))
    }
  }

  async function restore(entry: TrashEntry): Promise<void> {
    try {
      await fsService.restoreFromTrash(options.vault(), entry.trash_path)
      await refreshTrash()
    } catch {
      notifyError(t('nav.restoreFailed'))
    }
  }

  /** The trash key is the encoded on-disk name (`docs%2Fa.md`), and a second
   *  deletion of the same path adds a timestamp — neither is what the user
   *  deleted. The backend decodes both, so the label is read rather than
   *  re-derived; the local fallbacks cover an older entry shape. */
  function trashLabel(entry: TrashEntry): string {
    return entry.display_name || baseName(entry.original_path) || entry.name
  }

  /** Two-step clear: the first click arms "confirm", the second empties the
   *  trash. No confirm is required when the trash is already empty. */
  async function clearTrash(): Promise<void> {
    if (!clearingTrash.value) {
      clearingTrash.value = true
      return
    }
    clearingTrash.value = false
    try {
      const report = await fsService.clearTrash(options.vault())
      await refreshTrash()
      if (report.failed.length === 0) {
        announce(t('trash.cleared', { n: report.removed }))
      } else {
        // Partial (or total) failure: say what actually happened. "Failed"
        // over a half-emptied trash hides the removals that DID happen and the
        // entries that are still there to retry.
        const names = report.failed.slice(0, 5).map((f) => f.name).join(', ')
        const extra = report.failed.length > 5 ? ` +${report.failed.length - 5}` : ''
        notifyError(
          t('trash.clearPartial', {
            removed: report.removed,
            failed: report.failed.length,
            names: names + extra,
          }),
        )
      }
    } catch {
      notifyError(t('trash.clearFailed'))
    }
  }

  // A new vault starts with nothing armed: the confirm was about the entries
  // that were on screen, and those are not this vault's.
  watch(options.vault, () => {
    clearingTrash.value = false
  })

  return { trashEntries, trashUnreadable, clearingTrash, refreshTrash, restore, trashLabel, clearTrash }
}
