/**
 * The commands a note card offers: open, favourite, rename, delete and export,
 * plus the context menu that carries them (§13.4 — the state lives in the
 * stores, the flows in `services/`, and the commands here).
 *
 * The store reads (tabs, documentList, vaultSession, refs, appearance, view)
 * live here rather than in the components: §10.2 keeps a feature component off
 * the stores, and every read is one of these commands' business — which vault
 * the target belongs to, which tab holds it, whether deleting asks twice.
 *
 * Every action reads the path it was given and never `tabs.activeTab`: the note
 * the user right-clicked is usually NOT the open one, and the whole context menu
 * exists to act on the right-clicked note.
 */

import { computed, markRaw, ref, watch, type ComputedRef, type Ref } from 'vue'
import {
  Download,
  FileDown,
  FolderOpen,
  PencilLine,
  Star,
  StarOff,
  Trash2,
} from 'lucide-vue-next'
import { useAppearanceStore } from '../../../stores/appearance'
import { useDocumentListStore } from '../../../stores/documentList'
import { useRefsStore } from '../../../stores/refs'
import { useTabsStore } from '../../../stores/tabs'
import { useVaultSessionStore } from '../../../stores/vaultSession'
import { useViewStore } from '../../../stores/view'
import { fsService } from '../../../platform/gateways/fs'
import { t } from '../../../i18n'
import { baseName, samePath } from '../../../services/paths'
import {
  isCaseOnlyRename,
  noteActionTarget,
  noteRenameNameError,
  noteRenameTargetPath,
  readTargetContent,
} from '../../../services/noteActions'
import type { NoteActionDeps } from '../../../services/noteActions'
import { moveOrRepair } from '../../../services/noteMoveFlow'
import { deleteNoteWithAssets } from '../../../services/noteDelete'
import { describeExportError, notifyError } from '../../../services/errors'
import { exportHtml, exportToPdf, type ExportUiOptions } from '../../../services/export'
import { exportBaseName } from '../../../services/exportName'
import { toExportRefs } from '../../../services/exportRefs'
import { isPathWithinVault } from '../../../services/attachments'
import { flushEdits } from '../../../services/editorOwnership'
import { isComposingKey } from '../../../services/keyGuard'
import type { ContextMenuItem } from '../../../ui/ContextMenu.vue'
import type { NoteCardContextTarget } from '../../../ui/NoteCard.vue'

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
   * The note the card menu is acting on: the path recorded when the menu opened,
   * plus the click position. Every action reads THIS path — never
   * `tabs.activeTab`, which is a different note whenever the user right-clicks a
   * background card.
   */
  const noteMenu = ref<NoteCardContextTarget | null>(null)

  const NOTE_MENU_ICONS = {
    open: markRaw(FolderOpen),
    favorite: markRaw(Star),
    unfavorite: markRaw(StarOff),
    rename: markRaw(PencilLine),
    exportHtml: markRaw(Download),
    exportPdf: markRaw(FileDown),
    delete: markRaw(Trash2),
  }

  const noteMenuItems = computed<ContextMenuItem[]>(() => {
    const target = noteMenu.value
    if (!target) return []
    // Resolved on every render, so the label and icon always describe the action
    // for this note's CURRENT favourite state instead of a cached one.
    const favorite = documentList.isFavorite(target.path)
    return [
      { id: 'open', label: t('notecard.open'), icon: NOTE_MENU_ICONS.open },
      {
        id: 'toggle-favorite',
        label: t(favorite ? 'notecard.unfavorite' : 'notecard.favorite'),
        // The icon matches the label's action: Star = add, StarOff = remove.
        icon: favorite ? NOTE_MENU_ICONS.unfavorite : NOTE_MENU_ICONS.favorite,
      },
      { id: 'rename', label: t('filetree.rename'), icon: NOTE_MENU_ICONS.rename },
      { id: 'export-html', label: t('notecard.exportHtml'), icon: NOTE_MENU_ICONS.exportHtml },
      { id: 'export-pdf', label: t('notecard.exportPdf'), icon: NOTE_MENU_ICONS.exportPdf },
      // A leading divider sets the destructive action apart from the rest.
      {
        id: 'delete',
        label: t('filetree.delete'),
        icon: NOTE_MENU_ICONS.delete,
        separator: true,
        danger: true,
      },
    ]
  })

  function openNoteMenu(target: NoteCardContextTarget): void {
    noteMenu.value = target
  }

  function closeNoteMenu(): void {
    noteMenu.value = null
  }

  function onNoteMenuSelect(id: string): void {
    // ContextMenu emits `select` before `close`, so the target recorded when the
    // menu opened is still here.
    const target = noteMenu.value
    if (!target) return
    switch (id) {
      case 'open':
        openNote(target.path)
        break
      case 'toggle-favorite':
        documentList.toggleFavorite(target.path)
        break
      case 'rename':
        startNoteRename(target.path)
        break
      case 'export-html':
        void exportNoteHtml(target.path)
        break
      case 'export-pdf':
        void exportNotePdf(target.path)
        break
      case 'delete':
        requestNoteDelete(target.path)
        break
    }
  }

  function openNote(path: string | null): void {
    if (!path) return
    void tabs.openTab(path)
  }

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

  // --- rename -----------------------------------------------------------------

  /**
   * The note whose name is being edited in place, and what has been typed.
   *
   * Bound by PATH, never by the active tab: the editor is opened from the card the
   * user right-clicked, which is usually a note that is not open at all.
   */
  const renameTarget = ref<{ path: string; name: string } | null>(null)
  const renameName = ref('')
  const renameError = ref('')
  let renameInFlight = false

  function startNoteRename(path: string): void {
    const name = baseName(path)
    renameTarget.value = { path, name }
    renameName.value = name
    renameError.value = ''
  }

  function cancelNoteRename(): void {
    // A rename already on its way may not be torn down from under itself; its own
    // completion clears the editor.
    if (renameInFlight) return
    renameTarget.value = null
    renameError.value = ''
  }

  /** Enter commits and Escape cancels — but not while an IME is composing: there
   *  Enter accepts the highlighted candidate and Escape dismisses the candidate
   *  list, and treating those as app actions renames the note to raw pinyin or
   *  throws the typed name away. */
  function onRenameKeydown(e: KeyboardEvent): void {
    if (isComposingKey(e)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      void confirmNoteRename()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelNoteRename()
    }
  }

  /** True when `path` already exists. A rejection is the answer "no": the gateway
   *  reports a missing path by failing (`stat`), which is how the delete flow
   *  probes for a note's `_assets` folder too. */
  async function notePathExists(vault: string, path: string): Promise<boolean> {
    try {
      await fsService.stat(vault, path)
      return true
    } catch {
      return false
    }
  }

  async function confirmNoteRename(): Promise<void> {
    const target = renameTarget.value
    if (!target || renameInFlight) return
    const invalid = noteRenameNameError(renameName.value)
    if (invalid) {
      renameError.value = t(invalid)
      return
    }
    const to = noteRenameTargetPath(target.path, renameName.value)
    // The same path is not a move. This must stay a plain comparison: a case-only
    // rename (`note.md` → `Note.md`) IS a real rename the backend runs, and
    // `samePath` would fold it away as "no change".
    if (to === target.path) {
      cancelNoteRename()
      return
    }
    const vault = tabs.vault
    if (!vault) return
    renameInFlight = true
    try {
      // A name that is already taken is refused before anything moves, so a clash
      // cannot leave the note half-renamed — EXCEPT for a case-only rename, whose
      // target IS the source file on a case-insensitive filesystem.
      if (!isCaseOnlyRename(target.path, to) && (await notePathExists(vault, to))) {
        renameError.value = t('tree.conflict')
        return
      }
      // The shared move: flush pending edits, arm the self-write/move claims,
      // carry `<basename>_assets` and the note-relative references, retarget the
      // open tabs, and repair them if the move fails after its rename landed.
      await moveOrRepair(vault, target.path, to, false)
    } catch {
      notifyError(t('filetree.renameFailed'))
      // The editor stays open on the note it failed to rename: the name is a
      // correction away from working, and closing it would hide which note failed.
      return
    } finally {
      renameInFlight = false
    }
    renameTarget.value = null
    renameError.value = ''
    await refreshNoteIndex()
  }

  // --- delete -----------------------------------------------------------------

  /**
   * Paths whose delete is already in flight. One deliberate activation deletes
   * once: a second pick from the menu while the first delete is still running, or
   * a second press on the confirm button, must not aim a second trash entry at a
   * path that is already on its way out. The same guard the file tree keeps.
   */
  const deleting = new Set<string>()

  /** The note the confirmation step is waiting on (never set while the gate is
   *  off — then the menu pick is the whole gesture). */
  const deleteConfirmPath = ref<string | null>(null)

  /**
   * Ask for `path` to be deleted.
   *
   * Deleting is destructive, so by default the menu item only arms the card and
   * the following confirm button performs the delete; with "confirm before
   * deleting" switched off that button is the whole gesture, exactly as in the
   * file tree.
   */
  function requestNoteDelete(path: string): void {
    if (deleting.has(path)) return
    if (!appearance.confirmBeforeDelete) {
      void performNoteDelete(path)
      return
    }
    deleteConfirmPath.value = path
  }

  function cancelNoteDelete(): void {
    deleteConfirmPath.value = null
  }

  async function performNoteDelete(path: string): Promise<void> {
    if (deleting.has(path)) return
    deleting.add(path)
    const vault = tabs.vault
    try {
      if (!vault) return
      const tab = tabs.tabs.find((t) => t.path === path)
      if (tab) {
        // The tabs store deletes the note WITH its `_assets` folder and closes
        // every tab on that path, so the open-note branch owns the whole gesture.
        await tabs.deleteTabFile(tab.id)
      } else {
        // A note with no tab still owns a `<basename>_assets` folder; leaving it
        // behind kept its images on disk while nothing in the app could list or
        // reclaim them.
        const result = await deleteNoteWithAssets(
          {
            deleteFile: (v, p) => fsService.deleteFile(v, p),
            exists: async (v, p) => {
              await fsService.stat(v, p)
              return true
            },
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
      deleteConfirmPath.value = null
      await refreshNoteIndex()
    }
  }

  // --- export -----------------------------------------------------------------

  /**
   * The dependencies {@link readTargetContent} resolves a target's text with,
   * built from the stores this composable already holds. The lookup keys on the
   * path — it is asked for the right-clicked note's tab, not for the active one —
   * and the read is the fs gateway's own vault read.
   */
  function noteExportDeps(): NoteActionDeps {
    return {
      read: (vault, path) => fsService.read(vault, path),
      findTab: (path) => tabs.tabs.find((t) => t.path !== null && samePath(t.path, path)) ?? null,
      flushEdits: () => flushEdits(),
      openTab: (path) => tabs.openTab(path),
    }
  }

  /**
   * The options both exports hand to the pipeline.
   *
   * `notePath` is the load-bearing one: attachments and citations are resolved
   * against it, so leaving it out resolves the target's `![](pic.png)` against
   * whatever note happens to be open — the wrong-note bug this whole menu is
   * built to avoid. `refs` is the same map the settings dialog exports with, so
   * a cited `[@key]` renders identically whichever way the note leaves the app.
   */
  function noteExportOptions(path: string): ExportUiOptions {
    return {
      title: exportBaseName(path),
      notePath: path,
      refs: toExportRefs(refs.refs.values()),
    }
  }

  /**
   * Export the right-clicked note as a self-contained `.html` file.
   *
   * The source is the target's LATEST text ({@link readTargetContent}: its own
   * open tab, flushed first when it is the active one, its file otherwise), and
   * the default name is the target's. Everything happens about `path`; the
   * active tab is not an input.
   */
  async function exportNoteHtml(path: string): Promise<void> {
    const vault = tabs.vault
    // The dialog comes first, so a cancelled save is a decision with no side
    // effects at all — nothing is read, nothing is exported, nothing is said.
    const savePath = await fsService.saveFileDialog(exportBaseName(path) + '.html', vault ?? undefined)
    if (!savePath) return
    // The native dialog can aim anywhere (Desktop, Home, …), but the backend's
    // write is vault-confined: an outside path is rejected with "path escapes
    // vault" and the export dies silently behind the closed dialog. Refuse it up
    // front, with the message the settings dialog already shows.
    if (vault && !isPathWithinVault(savePath, vault)) {
      notifyError(t('error.exportOutsideVault'))
      return
    }
    try {
      const source = await readTargetContent(noteExportDeps(), vault, noteActionTarget(path))
      await exportHtml(source, vault ?? '', savePath, noteExportOptions(path))
    } catch (e) {
      // Reported, never swallowed: a rejected read (the note is gone) and a
      // rejected write look exactly like the menu item doing nothing.
      notifyError(describeExportError(e))
    }
  }

  /** Export the right-clicked note through the app's own print frame. There is
   *  no destination to pick, so only the target matters. */
  async function exportNotePdf(path: string): Promise<void> {
    const vault = tabs.vault
    try {
      const source = await readTargetContent(noteExportDeps(), vault, noteActionTarget(path))
      await exportToPdf(source, noteExportOptions(path))
    } catch (e) {
      notifyError(describeExportError(e))
    }
  }

  function jumpOutline(line: number, index: number): void {
    view.requestOutlineTarget({ line, index })
  }

  watch(() => vaultSession.vault, () => {
    // A half-finished rename or delete question belongs to the vault that is
    // being left: the paths it holds are absolute, and the delete would be aimed
    // at a path of the OLD vault while the new one is current.
    renameTarget.value = null
    renameError.value = ''
    deleteConfirmPath.value = null
  })

  return {
    noteMenu: computed(() => noteMenu.value),
    noteMenuItems,
    openNoteMenu,
    onNoteMenuSelect,
    closeNoteMenu,
    openNote,
    jumpOutline,
    renameTarget: computed(() => renameTarget.value),
    renameName,
    renameError: computed(() => renameError.value),
    startNoteRename,
    cancelNoteRename,
    onRenameKeydown,
    confirmNoteRename,
    deleteConfirmPath: computed(() => deleteConfirmPath.value),
    requestNoteDelete,
    cancelNoteDelete,
    performNoteDelete,
  }
}
