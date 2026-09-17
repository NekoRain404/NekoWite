import { onUnmounted, ref } from 'vue'
import { fsService } from '../../../platform/gateways/fs'
import { getSharedGateways } from '../../../platform/runtime/gateway-runtime'
import { notifyError } from '../../../services/errors'
import { t } from '../../../i18n'
import { useTabsStore } from '../../../stores/tabs'
import { assetsDirForNote, suggestRename } from '../../../services/rename-asset'
import { insertMarkdownAtCursor } from '../../../services/editor-insert'
import {
  collectClipboardImages,
  describeAttachmentRejections,
  escapeMarkdownAlt,
  fileToBase64,
  markdownImageBlock,
  relativePathFromNoteVault,
} from '../../attachments'
import type { AttachmentLimitResult } from '../../attachments'

interface RenamePrompt {
  initial: string
  resolve: (choice: { ok: boolean; name: string }) => void
}

/**
 * The note a paste or drop belongs to, captured before the flow's first await.
 *
 * Everything here reads `tabs.activeTab`, which follows the user's clicks. A
 * paste awaits the rename dialog, the base64 encode and the attachment write,
 * all with the UI live, so reading the active tab *after* them lands the image
 * in whatever note is open when the last one finishes — a different note from
 * the one the image was pasted into. The identity is the tab `id` (a note can
 * gain a path mid-paste, via Save As) and the path is what the Markdown
 * reference is measured from.
 */
interface IntakeTarget {
  /** The tab that was active, or null when no note was open at all. */
  id: string | null
  path: string | null
  /** The assets directory that note resolves to, or undefined for the legacy
   *  `attachments/YYYY-MM` layout. `.tmp` means the note had no path yet. */
  dir: string | undefined
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
  /**
   * True once the host that renders `RenameDialog` is gone. The dialog is the
   * only thing that can settle a prompt, so a promise left pending would
   * suspend `insertImageFiles` forever — the pasted image dropped with no
   * toast and nothing logged.
   */
  let unmounted = false

  onUnmounted(() => {
    unmounted = true
    // Settle as a cancel, which is what Escape does: the intake's awaiting loop
    // already has that branch (`continue`), so the files are skipped rather
    // than inserted into a pane that no longer exists.
    renamePrompt.value?.resolve({ ok: false, name: '' })
    renamePrompt.value = null
  })

  function promptRename(file: { name: string; type: string }): Promise<{ ok: boolean; name: string }> {
    // A prompt opened after the host unmounted would never be answered either:
    // cancel it immediately rather than hand back another hanging promise.
    if (unmounted) return Promise.resolve({ ok: false, name: '' })
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
  function assetsDirFor(notePath: string | null): string | undefined {
    return assetsDirForNote(notePath, tabs.vault ?? '') || undefined
  }

  /** Bind the flow to the note that is in front right now. */
  function captureTarget(): IntakeTarget {
    const tab = tabs.activeTab
    return {
      id: tab?.id ?? null,
      path: tab?.path ?? null,
      dir: assetsDirFor(tab?.path ?? null),
    }
  }

  /**
   * True while the note the paste was made in is still the one in front.
   *
   * No note at capture time means there was nothing to bind to (the paste
   * arrived with no tab open), so the flow keeps its old behaviour and lets the
   * insert report that no editor can take it.
   */
  function targetIsInFront(target: IntakeTarget): boolean {
    return target.id === null || tabs.activeTab?.id === target.id
  }

  /** Record a `.tmp`-staged asset on the tab it was staged FOR — the paste's
   *  own tab, which may no longer be the active one. This list is what stops
   *  the recovery pass collecting the staged file as an orphan
   *  (`referencedTmpPaths`) and what moves it into the note's assets directory
   *  on that note's first save. */
  function noteStagedAsset(target: IntakeTarget, savedPath: string): void {
    if (target.dir !== '.tmp') return
    tabs.tabs.find((tab) => tab.id === target.id)?.pendingAssetPaths.push(savedPath)
  }

  /** Tell the user their image was stored but not placed — once per batch, so
   *  a ten-image paste does not stack ten copies of the same sentence. */
  function reportNotInserted(name: string, already: { done: boolean }): void {
    if (already.done) return
    already.done = true
    notifyError(t('attachments.pasteNotInserted', { name }))
  }

  /**
   * Insert the Markdown for one newly stored asset.
   *
   * `alt` is the name the user is thinking in (the one they typed, or the one
   * the file had on disk) rather than the stored name: a collision suffix the
   * backend appended is not something that belongs in the alt text.
   */
  async function insertSavedAsset(
    savedPath: string,
    target: IntakeTarget,
    alt: string,
  ): Promise<void> {
    const ref = relativePathFromNoteVault(target.path ?? '', tabs.vault ?? '', savedPath)
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
    // One paste is one note's paste: the destination is decided once, before
    // the first await, so a later note switch cannot move the batch with it.
    const target = captureTarget()
    const reported = { done: false }
    for (const file of files) {
      try {
        const choice = await promptRename(file)
        if (!choice.ok) continue
        const base64 = await fileToBase64(file)
        const savedPath = await fsService.saveAttachment(vault, choice.name, base64, target.dir)
        noteStagedAsset(target, savedPath)
        if (!targetIsInFront(target)) {
          reportNotInserted(choice.name, reported)
          continue
        }
        await insertSavedAsset(savedPath, target, choice.name)
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
    // Bound to the note the same way a paste is: the import copies a file of
    // any size, and the picker's own await is not the last one.
    const target = captureTarget()
    const reported = { done: false }
    for (const sourcePath of paths) {
      try {
        const savedPath = await fsService.importAttachment(vault, sourcePath, target.dir)
        noteStagedAsset(target, savedPath)
        if (!targetIsInFront(target)) {
          reportNotInserted(sourcePath.replace(/\\/g, '/').split('/').pop() ?? savedPath, reported)
          continue
        }
        await insertSavedAsset(
          savedPath,
          target,
          sourcePath.replace(/\\/g, '/').split('/').pop() ?? savedPath,
        )
      } catch {
        notifyError(t('attachments.importFailed'))
      }
    }
  }

  /**
   * Tell the reader about whatever the limits refused, then keep what survived.
   *
   * The sentence is the intake's own (`describeAttachmentRejections`), so this surface and the
   * chat panel's and the agent composer's cannot describe the same refusal three ways. What is
   * this surface's is the *showing* of it: the intake returns the refusals rather than reporting
   * them itself, because it is called by three surfaces that tell a reader three different ways.
   */
  function accepted(result: AttachmentLimitResult): File[] {
    if (result.rejected.length > 0) notifyError(describeAttachmentRejections(result.rejected))
    return result.accepted
  }

  function onPaste(e: ClipboardEvent): void {
    const files = accepted(collectClipboardImages(e.clipboardData))
    if (files.length === 0) return
    // Captured before ProseMirror/CodeMirror's own paste handling sees the
    // event, so an image file never lands as raw HTML or a path string.
    e.preventDefault()
    e.stopPropagation()
    void insertImageFiles(files)
  }

  function onDrop(e: DragEvent): void {
    const files = accepted(collectClipboardImages(e.dataTransfer))
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
