/**
 * The commands a note card offers: open, favourite, rename, delete and export,
 * plus the context menu that carries them (§13.4 — the state lives in the
 * stores, the flows in `services/`, and the commands here).
 *
 * This module is the composition root of that set. The menu itself is
 * `useNoteMenu`, the two commands that change disk state are `useNoteRename` and
 * `useNoteDelete`, the exports are `useNoteExport`; what is left here is the
 * wiring between them, the two commands with no flow of their own (`openNote`,
 * `jumpOutline`), and the one step both disk commands publish through
 * (`refreshNoteIndex`).
 *
 * The store reads (tabs, documentList, vaultSession, refs, appearance, view)
 * live here rather than in the components: §10.2 keeps a feature component off
 * the stores, and every read is one of these commands' business — which vault
 * the target belongs to, which tab holds it, whether deleting asks twice. The
 * flow modules take what they need as parameters, so each of them can be driven
 * without a mounted component.
 *
 * Every action reads the path it was given and never `tabs.activeTab`: the note
 * the user right-clicked is usually NOT the open one, and the whole context menu
 * exists to act on the right-clicked note.
 */

import { watch, type ComputedRef, type Ref } from 'vue'
import { useAppearanceStore } from '../../../stores/appearance'
import { useDocumentListStore } from '../../../stores/documentList'
import { useRefsStore } from '../../../stores/refs'
import { useTabsStore } from '../../../stores/tabs'
import { useVaultSessionStore } from '../../../stores/vaultSession'
import { useViewStore } from '../../../stores/view'
import { samePath } from '../../../services/paths'
import type { ContextMenuItem } from '../../../ui/ContextMenu.vue'
import type { NoteCardContextTarget } from '../../../ui/NoteCard.vue'
import { useNoteMenu } from './useNoteMenu'
import { useNoteRename } from './useNoteRename'
import { useNoteDelete } from './useNoteDelete'
import { useNoteExport } from './useNoteExport'

export interface NoteActionsModel {
  /** The note the card menu is acting on, or null when it is closed. */
  noteMenu: ComputedRef<NoteCardContextTarget | null>
  noteMenuItems: ComputedRef<ContextMenuItem[]>
  openNoteMenu(target: NoteCardContextTarget): void
  onNoteMenuSelect(id: string): void
  closeNoteMenu(): void
  openNote(path: string | null): void
  jumpOutline(line: number, index: number): void
  /** The note being renamed in place, and the typed name (the input writes it). */
  renameTarget: ComputedRef<{ path: string; name: string } | null>
  renameName: Ref<string>
  renameError: ComputedRef<string>
  startNoteRename(path: string): void
  cancelNoteRename(): void
  onRenameKeydown(e: KeyboardEvent): void
  confirmNoteRename(): Promise<void>
  /** The note the delete question is waiting on, or null. */
  deleteConfirmPath: ComputedRef<string | null>
  requestNoteDelete(path: string): void
  cancelNoteDelete(): void
  performNoteDelete(path: string): Promise<void>
}

export function useNoteActions(): NoteActionsModel {
  const appearance = useAppearanceStore()
  const documentList = useDocumentListStore()
  const refs = useRefsStore()
  const tabs = useTabsStore()
  const vaultSession = useVaultSessionStore()
  const view = useViewStore()

  /**
   * Re-run the vault index after a note moved or went to the trash. The note list
   * is a mirror of that index, so this is what makes the renamed note appear under
   * its new name (and the deleted one disappear) without waiting for the fs
   * watcher — and the index run is also what prunes favorites/recents pointing at
   * paths that no longer exist (see `vaultIndexCoordinator` →
   * `documentList.setFavoritesRecents`).
   */
  async function refreshNoteIndex(): Promise<void> {
    try {
      await vaultSession.rebuildIndex()
    } catch {
      // The rename/delete itself already happened; the refresh is fire-and-forget
      // and must not surface as an unhandled rejection for an action that
      // succeeded. The fs watcher and the index-state chip stay the way back to a
      // fresh list.
    }
  }

  function openNote(path: string | null): void {
    if (!path) return
    void tabs.openTab(path)
  }

  function jumpOutline(line: number, index: number): void {
    view.requestOutlineTarget({ line, index })
  }

  const rename = useNoteRename({
    vault: () => tabs.vault,
    refreshIndex: refreshNoteIndex,
  })

  const remove = useNoteDelete({
    vault: () => tabs.vault,
    confirmBeforeDelete: () => appearance.confirmBeforeDelete,
    tabs: {
      tabIdAt: (path) => tabs.tabs.find((tab) => tab.path === path)?.id ?? null,
      deleteTabFile: (tabId) => tabs.deleteTabFile(tabId),
    },
    refreshIndex: refreshNoteIndex,
  })

  const exportNote = useNoteExport({
    vault: () => tabs.vault,
    // Keyed on the path: the target's own tab, never the active one.
    findTab: (path) => tabs.tabs.find((tab) => tab.path !== null && samePath(tab.path, path)) ?? null,
    openTab: (path) => tabs.openTab(path),
    refs: () => refs.refs.values(),
  })

  const menu = useNoteMenu({
    isFavorite: (path) => documentList.isFavorite(path),
    open: openNote,
    toggleFavorite: (path) => documentList.toggleFavorite(path),
    rename: (path) => rename.start(path),
    exportHtml: (path) => void exportNote.exportHtml(path),
    exportPdf: (path) => void exportNote.exportPdf(path),
    delete: (path) => remove.request(path),
  })

  watch(() => vaultSession.vault, () => {
    // A half-finished rename or delete question belongs to the vault that is
    // being left: the paths it holds are absolute, and the delete would be aimed
    // at a path of the OLD vault while the new one is current.
    rename.resetForVault()
    remove.cancel()
  })

  return {
    noteMenu: menu.target,
    noteMenuItems: menu.items,
    openNoteMenu: menu.open,
    onNoteMenuSelect: menu.select,
    closeNoteMenu: menu.close,
    openNote,
    jumpOutline,
    renameTarget: rename.target,
    renameName: rename.name,
    renameError: rename.error,
    startNoteRename: rename.start,
    cancelNoteRename: rename.cancel,
    onRenameKeydown: rename.onKeydown,
    confirmNoteRename: rename.confirm,
    deleteConfirmPath: remove.confirmPath,
    requestNoteDelete: remove.request,
    cancelNoteDelete: remove.cancel,
    performNoteDelete: remove.perform,
  }
}
