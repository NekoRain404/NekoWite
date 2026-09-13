import { ref } from 'vue'
import { fsService } from '../../../platform/gateways/fs'
import { getSharedGateways } from '../../../platform/runtime/gatewayRuntime'
import { notifyError } from '../../../services/errors'
import { t } from '../../../i18n'
import { useTabsStore } from '../../../stores/tabs'
import { assetsDirForNote, suggestRename } from '../../../services/renameAsset'
import { insertMarkdownAtCursor } from '../../../services/editorInsert'
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

/**
 * Image intake for the editor pane.
 *
 * Owns the whole "an image arrives" flow for both panes: intercept a paste or
 * drop, ask the user to rename each file, persist it into the note's assets
 * directory (or `.tmp` while the note is unsaved), and insert a Markdown image
 * block at the caret of whichever pane owns the document. Also owns the
 * rename-dialog prompt state so the orchestrator template can render it.
 *
 * The paste/drop handlers are registered by the caller on the shared pane
 * ancestor with capture, so they run before ProseMirror's own handlers, and in
 * every view mode rather than only the rendered one.
 */
export function useImageIntake() {
  const tabs = useTabsStore()
  const renamePrompt = ref<RenamePrompt | null>(null)

  function promptRename(file: { name: string; type: string }): Promise<{ ok: boolean; name: string }> {
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

  /** The vault-relative destination for new assets, or undefined for the
   *  legacy attachments/YYYY-MM layout when the note has no usable path. */
  function assetsDir(): string | undefined {
    return assetsDirForNote(tabs.activeTab?.path ?? null, tabs.vault ?? '') || undefined
  }

  /**
   * Insert the Markdown for one newly stored asset, recording the path when it
   * was staged in `.tmp` so it can be relocated on first save.
   *
   * `alt` is the name the user is thinking in (the one they typed, or the one
   * the file had on disk) rather than the stored name: a collision suffix the
   * backend appended is not something that belongs in the alt text.
   */
  async function insertSavedAsset(
    savedPath: string,
    dir: string | undefined,
    alt: string,
  ): Promise<void> {
    const tab = tabs.activeTab
    if (tab && dir === '.tmp') tab.pendingAssetPaths.push(savedPath)
    const ref = relativePathFromNoteVault(tab?.path ?? '', tabs.vault ?? '', savedPath)
    const inserted = await insertMarkdownAtCursor(markdownImageBlock(escapeMarkdownAlt(alt), ref))
    if (inserted === false) notifyError(t('attachments.editorNotReady'))
  }

  /** Persist pasted/dropped images (the bytes are already in memory). */
  async function insertImageFiles(files: File[]): Promise<void> {
    const vault = tabs.vault
    if (!vault) {
      notifyError(t('rendered.saveImageNoVault'))
      return
    }
    for (const file of files) {
      try {
        const choice = await promptRename(file)
        if (!choice.ok) continue
        const base64 = await fileToBase64(file)
        const dir = assetsDir()
        const savedPath = await fsService.saveAttachment(vault, choice.name, base64, dir)
        await insertSavedAsset(savedPath, dir, choice.name)
      } catch {
        notifyError(t('attachments.insertFailed'))
      }
    }
  }

  /**
   * Open the native picker and import the chosen files from disk.
   *
   * These are copied backend-side straight from the picked path, so no base64
   * round-trip is involved and the file keeps its real name — which is why this
   * path does not re-prompt for a rename the way a nameless clipboard paste
   * does. A name collision is resolved with a numeric suffix by the backend.
   */
  async function insertImagesFromPicker(): Promise<void> {
    const vault = tabs.vault
    if (!vault) {
      notifyError(t('rendered.saveImageNoVault'))
      return
    }
    let paths: string[]
    try {
      paths = await getSharedGateways().dialogs.pickImageFiles()
    } catch {
      notifyError(t('attachments.pickFailed'))
      return
    }
    for (const sourcePath of paths) {
      try {
        const dir = assetsDir()
        const savedPath = await fsService.importAttachment(vault, sourcePath, dir)
        await insertSavedAsset(savedPath, dir, sourcePath.replace(/\\/g, '/').split('/').pop() ?? savedPath)
      } catch {
        notifyError(t('attachments.importFailed'))
      }
    }
  }

  function onPaste(e: ClipboardEvent): void {
    const files = collectClipboardImages(e.clipboardData)
    if (files.length === 0) return
    // Captured before ProseMirror/CodeMirror's own paste handling sees the
    // event, so an image file never lands as raw HTML or a path string.
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
    // image files and leaves text drags to the editors.
    e.preventDefault()
  }

  return {
    renamePrompt,
    onRenameConfirm,
    onRenameCancel,
    onPaste,
    onDrop,
    onDragOver,
    insertImageFiles,
    insertImagesFromPicker,
  }
}
