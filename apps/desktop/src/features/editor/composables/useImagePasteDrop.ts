import { ref } from 'vue'
import type { NekoEditor } from '@nekowite/editor-core'
import { fsService } from '../../../platform/gateways/fs'
import { notifyError } from '../../../services/errors'
import { t } from '../../../i18n'
import { useTabsStore } from '../../../stores/tabs'
import { assetsDirForNote, suggestRename } from '../../../services/renameAsset'
import {
  collectClipboardImages,
  escapeMarkdownAlt,
  fileToBase64,
  markdownImageBlock,
  relativePathFromNoteVault,
} from '../../../services/attachments'

interface RenamePrompt {
  initial: string
  resolve: (choice: { ok: boolean; name: string }) => void
}

export interface UseImagePasteDropOptions {
  /** Returns the live editor (may be null before/after mount). */
  getEditor: () => NekoEditor | null
}

/**
 * Image paste/drop pipeline for the rendered pane.
 *
 * Encapsulates the whole "an image lands on the pane" flow: intercept the
 * paste/drop, ask the user to rename each file, persist it into the note's
 * assets directory (or `.tmp` while the note is unsaved), and insert a
 * markdown image block referencing it relatively at the caret. Also owns the
 * rename-dialog prompt state so the orchestrator template can render it.
 *
 * The paste/drop handlers must be registered by the caller (typically on the
 * pane ancestor) with capture so they run before ProseMirror's own handlers,
 * and unregistered on unmount.
 */
export function useImagePasteDrop(options: UseImagePasteDropOptions) {
  const tabs = useTabsStore()
  const renamePrompt = ref<RenamePrompt | null>(null)

  function promptRename(file: File): Promise<{ ok: boolean; name: string }> {
    return new Promise((resolve) => {
      renamePrompt.value = { initial: suggestRename(file), resolve }
    })
  }

  function onRenameConfirm(name: string): void {
    renamePrompt.value?.resolve({ ok: true, name })
    renamePrompt.value = null
  }

  function onRenameCancel(): void {
    renamePrompt.value?.resolve({ ok: false, name: '' })
    renamePrompt.value = null
  }

  /** Ask the user to rename each pasted/dropped image, persist it into the
   * note's assets dir (or `.tmp` while the note is unsaved), and insert a
   * markdown image block (referencing it relatively) at the caret. */
  async function insertImageFiles(files: File[]): Promise<void> {
    const editor = options.getEditor()
    if (!editor) return
    if (!tabs.vault) {
      notifyError(t('rendered.saveImageNoVault'))
      return
    }
    for (const file of files) {
      try {
        const choice = await promptRename(file)
        if (!choice.ok) continue
        const base64 = await fileToBase64(file)
        const tab = tabs.activeTab
        const dir = assetsDirForNote(tab?.path ?? null, tabs.vault ?? '') || undefined
        const savedPath = await fsService.saveAttachment(tabs.vault, choice.name, base64, dir)
        if (tab && dir === '.tmp') tab.pendingAssetPaths.push(savedPath)
        const ref = relativePathFromNoteVault(tab?.path ?? '', tabs.vault ?? '', savedPath)
        await editor.insertMarkdownAtCursor(markdownImageBlock(escapeMarkdownAlt(choice.name), ref))
      } catch {
        notifyError(t('attachments.insertFailed'))
      }
    }
  }

  function onPaste(e: ClipboardEvent): void {
    const files = collectClipboardImages(e.clipboardData)
    if (files.length === 0) return
    // Captured before ProseMirror's own paste handling sees the event.
    e.preventDefault()
    e.stopPropagation()
    void insertImageFiles(files)
  }

  function onDrop(e: DragEvent): void {
    const files = collectClipboardImages(e.dataTransfer)
    if (files.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    void insertImageFiles(files)
  }

  function onDragOver(e: DragEvent): void {
    // Allow drops over the editor pane; the drop handler only intercepts
    // image files and leaves text drags to ProseMirror.
    e.preventDefault()
  }

  return { renamePrompt, onRenameConfirm, onRenameCancel, onPaste, onDrop, onDragOver }
}
