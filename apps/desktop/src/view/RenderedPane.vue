<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createEditor, basicPlugins, configureImageResolver } from '@nekowite/editor-core'
import type { NekoEditor } from '@nekowite/editor-core'
import { emitLifecycle, setActiveEditor } from '@nekowite/plugin-host'
import { consumeSuppressReapply } from '../services/suppressReapply'
import { setCalloutView } from '../plugins/callout'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'
import { useFloatStore } from '../stores/float'
import { notifyError } from '../services/errors'
import { editorBridge } from '../services/editorBridge'
import { fsService } from '../services/fs'
import {
  collectClipboardImages,
  createImageSrcResolver,
  escapeMarkdownAlt,
  fileToBase64,
  markdownImageBlock,
  relativePathFromNote,
  suggestedPasteFileName,
} from '../services/attachments'

const tabs = useTabsStore()
const view = useViewStore()
const floatStore = useFloatStore()

const scrollEl = ref<HTMLElement | null>(null)
const editorEl = ref<HTMLElement | null>(null)
let editor: NekoEditor | null = null
let unlistenChange: (() => void) | null = null
let applyingExternal = false
let parseFailed = false
let gen = 0
let calloutViewSet = false
let docChangeTimer: ReturnType<typeof setTimeout> | null = null
let lastDoc = ''
// Markdown last produced by (or applied to) the editor. The tab-content
// watcher uses it to recognize the echo of an editor-originated update and
// skip the full re-open it would otherwise trigger on every edit burst.
let lastLocalMarkdown: string | null = null
// Content that arrived while an applyContent was in flight.
let pendingExternal: string | null = null

async function applyContent(content: string): Promise<void> {
  if (!editor) return
  applyingExternal = true
  try {
    await editor.open(content)
    floatStore.select(null)
    // Capture the editor's canonical serialization immediately. The
    // debounced markdownUpdated emit would otherwise arrive later and — for
    // files needing canonicalization (e.g. CRLF) — mark a freshly opened
    // tab dirty, causing an autosave rewrite with no user edit.
    const initial = await editor.save()
    lastLocalMarkdown = initial
    const active = tabs.activeTab
    if (active && active.content !== initial) {
      active.content = initial
      if (!active.dirty) active.savedContent = initial
    }
    if (!calloutViewSet) {
      try {
        setCalloutView(editor.getView())
        calloutViewSet = true
      } catch {
        // The editor view is expected to be ready once open() resolves.
        parseFailed = true
        notifyError('文档解析失败，已切换到源码视图，请检查文档格式')
        view.setMode('source')
      }
    }
  } catch {
    parseFailed = true
    notifyError('文档解析失败，已切换到源码视图，请检查文档格式')
    view.setMode('source')
  } finally {
    applyingExternal = false
    // A content change that arrived mid-apply must not be dropped.
    const pending = pendingExternal
    pendingExternal = null
    if (pending !== null && pending !== lastLocalMarkdown && !parseFailed) {
      gen++
      void applyContent(pending)
    }
  }
}

function onScroll(): void {
  if (scrollEl.value) view.syncScroll('rendered', scrollEl.value.scrollTop)
}

function getRatio(): number {
  const el = scrollEl.value
  if (!el) return 0
  const range = el.scrollHeight - el.clientHeight
  return range > 0 ? el.scrollTop / range : 0
}

function onContainerPointerDownCapture(e: PointerEvent): void {
  const target = e.target as Element | null
  if (target && target.closest('.float-box')) return
  floatStore.select(null)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && floatStore.selectedId) {
    floatStore.select(null)
  }
}

/** Persist an image file into the vault attachments dir and insert a
 * markdown image block (referencing it relatively) at the caret. */
async function insertImageFiles(files: File[]): Promise<void> {
  if (!editor) return
  if (!tabs.vault) {
    notifyError('尚未打开 vault，无法保存图片')
    return
  }
  for (const file of files) {
    try {
      const base64 = await fileToBase64(file)
      const fileName = suggestedPasteFileName(file)
      const savedPath = await fsService.saveAttachment(tabs.vault, fileName, base64)
      const ref = relativePathFromNote(tabs.activeTab?.path ?? '', savedPath)
      await editor.insertMarkdownAtCursor(markdownImageBlock(escapeMarkdownAlt(fileName), ref))
    } catch {
      notifyError('图片插入失败，请重试')
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

function setRatio(r: number): void {
  const el = scrollEl.value
  if (!el) return
  const range = el.scrollHeight - el.clientHeight
  if (range > 0) el.scrollTop = r * range
}

function getHeadingEls(): HTMLElement[] {
  const root = editorEl.value
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
}

defineExpose({ getRatio, setRatio, getHeadingEls })

onMounted(async () => {
  if (!editorEl.value) return
  editor = createEditor(editorEl.value, { plugins: basicPlugins })
  editorBridge.setEditor(editor)
  setActiveEditor(editor)
  configureImageResolver(
    createImageSrcResolver(fsService, {
      getVault: () => tabs.vault,
      getNotePath: () => tabs.activeTab?.path ?? null,
    }),
  )
  const current = tabs.activeTab
  if (current) await applyContent(current.content)

  emitLifecycle('onEditorReady', editor)

  editorEl.value.addEventListener('pointerdown', onContainerPointerDownCapture, true)
  // Paste/drop must be captured on the PANE (an ancestor) so they run before
  // ProseMirror's own at-target handlers on the editor root; otherwise PM
  // would already have consumed the event (e.g. inserting remote <img> html)
  // before the attachment pipeline can intercept image files.
  scrollEl.value?.addEventListener('paste', onPaste, true)
  scrollEl.value?.addEventListener('drop', onDrop, true)
  scrollEl.value?.addEventListener('dragover', onDragOver)
  scrollEl.value?.addEventListener('dragenter', onDragOver)
  window.addEventListener('keydown', onKeydown)

  unlistenChange = editor.onContentChange(() => {
    if (applyingExternal || !editor) return
    void (async () => {
      const active = tabs.activeTab
      if (!active) return
      // Capture the generation BEFORE the await: a reloadFromDisk during the
      // save bumps gen, and the stale markdown must not win.
      const myGen = gen
      const markdown = await editor!.save()
      if (tabs.activeTab?.id !== active.id) return
      if (myGen !== gen) return
      // A debounced echo of a change we already applied is not an edit.
      if (markdown === lastLocalMarkdown && markdown === active.content) return
      lastLocalMarkdown = markdown
      active.content = markdown
      tabs.markDirty(active.id)
      tabs.scheduleAutosave(active.id)
      lastDoc = markdown
      if (docChangeTimer) return
      docChangeTimer = setTimeout(() => {
        emitLifecycle('onDocChange', { doc: lastDoc })
        docChangeTimer = null
      }, 300)
    })()
  })
})

onBeforeUnmount(() => {
  if (docChangeTimer) {
    clearTimeout(docChangeTimer)
    docChangeTimer = null
  }
  if (tabs.activeId) tabs.cancelAutosave(tabs.activeId)
  setCalloutView(null)
  configureImageResolver(null)
  editorBridge.setEditor(null)
  setActiveEditor(null)
  editorEl.value?.removeEventListener('pointerdown', onContainerPointerDownCapture, true)
  scrollEl.value?.removeEventListener('paste', onPaste, true)
  scrollEl.value?.removeEventListener('drop', onDrop, true)
  scrollEl.value?.removeEventListener('dragover', onDragOver)
  scrollEl.value?.removeEventListener('dragenter', onDragOver)
  window.removeEventListener('keydown', onKeydown)
  unlistenChange?.()
  editor?.destroy()
  editor = null
})

watch(
  () => tabs.activeTab?.content,
  (content) => {
    // I2: a save-time rewrite syncs the model but must not re-open the editor
    // (that would replace the user's live text and reset caret/scroll). The
    // flag is armed by tabs.saveActive and consumed once here.
    if (consumeSuppressReapply()) return
    if (content === undefined) return
    if (applyingExternal) {
      pendingExternal = content
      return
    }
    // The echo of an editor-originated update: content was set from the
    // editor's own serialization, so re-opening would re-parse the whole
    // document (wiping undo history and stored positions) for no change.
    if (content === lastLocalMarkdown) return
    if (parseFailed) return
    gen++
    void applyContent(content)
  },
)

watch(
  () => view.mode,
  (mode) => {
    if (!parseFailed) return
    if (mode === 'source') return
    parseFailed = false
    const content = tabs.activeTab?.content
    if (content === undefined) return
    gen++
    void applyContent(content)
  },
)
</script>

<template>
  <div
    ref="scrollEl"
    class="rendered-pane"
    @scroll="onScroll"
  >
    <div
      ref="editorEl"
      class="editor-container"
    />
  </div>
</template>

<style scoped>
.rendered-pane {
  width: 100%;
  height: 100%;
  overflow: auto;
  background: var(--app-canvas);
}
.editor-container {
  position: relative;
  max-width: var(--app-content-width);
  margin: 0 auto;
  padding: 24px 24px 96px;
  min-height: 100%;
}
.editor-container :deep(h1),
.editor-container :deep(h2),
.editor-container :deep(h3),
.editor-container :deep(h4),
.editor-container :deep(h5),
.editor-container :deep(h6) {
  scroll-margin-top: 16px;
}
</style>
