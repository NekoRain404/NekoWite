<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createEditor, basicPlugins, configureImageResolver, configureHeadingAnchorUrl } from '@nekowite/editor-core'
import type { NekoEditor } from '@nekowite/editor-core'
import { emitLifecycle, setActiveEditor } from '@nekowite/plugin-host'
import { consumeSuppressReapply } from '../services/suppressReapply'
import { setCalloutView } from '../plugins/callout'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'
import { useFloatStore } from '../stores/float'
import { useAppearanceStore } from '../stores/appearance'
import { notifyError } from '../services/errors'
import { t } from '../i18n'
import { editorBridge } from '../services/editorBridge'
import { fsService } from '../services/fs'
import { applySpellReplacement, getView, refreshOverlays, setSpellEnabled } from '../services/renderSearch'
import { suggestionsFromAttr } from '../services/renderSearch'
import { countWords, isWordGoalMet, shouldCenterScroll, wordProgress } from '../services/editorBehaviors'
import RenderSearchPanel from './RenderSearchPanel.vue'
import RenameDialog from '../components/RenameDialog.vue'
import { assetsDirForNote, suggestRename } from '../services/renameAsset'
import { parseOutline } from '../services/outline'
import { anchorHeadingIndex, countDocumentLines, lineRatio } from '../services/scrollSyncAnchors'
import {
  collectClipboardImages,
  createImageSrcResolver,
  escapeMarkdownAlt,
  fileToBase64,
  markdownImageBlock,
  relativePathFromNoteVault,
} from '../services/attachments'

const tabs = useTabsStore()
const view = useViewStore()
const floatStore = useFloatStore()
const appearance = useAppearanceStore()

const searchOpen = ref(false)
const spellPopup = ref<{ x: number; y: number; from: number; to: number; word: string; suggestions: string[] } | null>(null)
let overlayRaf = 0

// Focus / typewriter mode: keep the cursor block vertically centered while it
// drifts, scrolling only the viewport (never the document). Driven by a rAF so
// we re-frame after ProseMirror has synced the DOM for this interaction.
let focusRaf = 0

function centerCursor(): void {
  const scroller = scrollEl.value
  const v = editor?.getView()
  if (!scroller || !v) return
  if (!appearance.focusMode) return
  const head = v.state.selection.head
  const coords = v.coordsAtPos(head)
  if (!coords) return
  const rect = scroller.getBoundingClientRect()
  const cursorTop = coords.top - rect.top
  // Leave the scroll alone while the caret sits near the middle, so an
  // already-centered caret does not chase itself on every keystroke.
  if (!shouldCenterScroll(cursorTop, scroller.clientHeight)) return
  const target = scroller.scrollTop + (cursorTop - scroller.clientHeight / 2)
  const clamped = Math.max(0, Math.min(target, scroller.scrollHeight - scroller.clientHeight))
  if (Math.abs(scroller.scrollTop - clamped) < 0.5) return
  scroller.scrollTop = clamped
}

function queueCenterCursor(): void {
  if (!appearance.focusMode) return
  if (focusRaf) return
  focusRaf = requestAnimationFrame(() => {
    focusRaf = 0
    centerCursor()
  })
}

function onEditorFocusKeydown(): void {
  queueCenterCursor()
}

function onEditorFocusPointerdown(): void {
  queueCenterCursor()
}

// Word-count goal: a slim top progress reading is shown while wordGoal > 0,
// flipping to the accent color once the goal is reached. Count is derived from
// the live tab content with the same CJK/latin algorithm the status bar uses.
const wordCount = computed(() => countWords(tabs.activeTab?.content ?? ''))
const wordGoalMet = computed(() => isWordGoalMet(wordCount.value, appearance.wordGoal))
const wordProgressPct = computed(() => Math.round(wordProgress(wordCount.value, appearance.wordGoal) * 100))

// rAF-throttled overlay refresh: coalesce bursts of model changes into one
// deterministic pass, and ensure it runs AFTER ProseMirror's own DOM sync.
function queueOverlayRefresh(): void {
  if (overlayRaf) return
  overlayRaf = requestAnimationFrame(() => {
    overlayRaf = 0
    refreshOverlays()
  })
}

const scrollEl = ref<HTMLElement | null>(null)
const editorEl = ref<HTMLElement | null>(null)
let editor: NekoEditor | null = null
let unlistenChange: (() => void) | null = null
let unlistenOverlayRefresh: (() => void) | null = null
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
// Set by setRatio() so the next scroll event (the async echo of a programmatic
// scroll) is swallowed, breaking the split-mode sync feedback loop.
let suppressScroll = false

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
        notifyError(t('rendered.parseFailed'))
        view.setMode('source')
      }
    }
  } catch {
    parseFailed = true
    notifyError(t('rendered.parseFailed'))
    view.setMode('source')
  } finally {
    applyingExternal = false
    // A content change that arrived mid-apply must not be dropped.
    const pending = pendingExternal
    pendingExternal = null
    if (pending !== null && pending !== lastLocalMarkdown && !parseFailed) {
      gen++
      void applyContent(pending)
    } else {
      queueOverlayRefresh()
    }
  }
}

function onScroll(): void {
  // A programmatic scroll (setRatio) fires its scroll event asynchronously;
  // swallow exactly that one event so it cannot write back to the store and
  // re-enter the split-mode sync loop (which fights the mouse wheel).
  if (suppressScroll) {
    suppressScroll = false
    return
  }
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

function onEditorClick(e: MouseEvent): void {
  const target = e.target as Element | null
  // External links open in a new tab; internal/markdown links are left alone.
  const anchor = target?.closest?.('a') as HTMLAnchorElement | null
  const href = anchor?.getAttribute('href') ?? ''
  if (anchor && /^https?:\/\//.test(href)) {
    e.preventDefault()
    e.stopPropagation()
    window.open(href, '_blank', 'noopener,noreferrer')
    return
  }
  const span = target?.closest?.('.nkw-spell') as HTMLElement | null
  if (span) {
    e.preventDefault()
    e.stopPropagation()
    openSpellPopup(span, e.clientX, e.clientY)
    return
  }
  if (spellPopup.value) {
    const hit = target?.closest?.('.nw-spell-popup')
    if (!hit) spellPopup.value = null
  }
}

function openSpellPopup(span: HTMLElement, clientX: number, clientY: number): void {
  const from = Number(span.dataset.from ?? NaN)
  const to = Number(span.dataset.to ?? NaN)
  const word = span.dataset.word ?? ''
  const suggestions = suggestionsFromAttr(span.dataset.suggestions ?? null)
  if (!Number.isFinite(from) || !Number.isFinite(to) || !word) return
  spellPopup.value = { x: clientX, y: clientY, from, to, word, suggestions }
}

function onSpellSuggestion(text: string): void {
  const pop = spellPopup.value
  if (!pop) return
  const view = getView()
  if (view) applySpellReplacement(view, pop.from, pop.to, text)
  spellPopup.value = null
}

function onSearchClose(): void {
  searchOpen.value = false
  spellPopup.value = null
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && floatStore.selectedId) {
    floatStore.select(null)
  }
  if (e.key === 'Escape' && (searchOpen.value || spellPopup.value)) {
    searchOpen.value = false
    spellPopup.value = null
    return
  }
  // Ctrl/Cmd+F opens the rendered-pane find panel. In source mode and when
  // focus is inside the CodeMirror host (split mode), leave the shortcut to
  // the source view's own search panel.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    if (view.mode === 'source') return
    const target = e.target as Element | null
    if (target && target.closest('.cm-editor')) return
    e.preventDefault()
    searchOpen.value = true
  }
}

interface RenamePrompt {
  initial: string
  resolve: (choice: { ok: boolean; name: string }) => void
}

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

function setRatio(r: number): void {
  const el = scrollEl.value
  if (!el) return
  const range = el.scrollHeight - el.clientHeight
  if (range <= 0) return
  const target = r * range
  // Only arm the suppression when the position actually changes — a no-op
  // assignment fires no scroll event, so the flag must not leak.
  if (Math.abs(el.scrollTop - target) < 0.5) return
  suppressScroll = true
  el.scrollTop = target
}

function getHeadingEls(): HTMLElement[] {
  const root = editorEl.value
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
}

/** Scroll so the block containing the given 1-based source line is top-most,
 * anchored on the nearest heading; falls back to a line-proportional ratio. */
function setScrollToLine(line: number): void {
  const el = scrollEl.value
  if (!el) return
  const content = tabs.activeTab?.content ?? ''
  const items = parseOutline(content)
  const index = anchorHeadingIndex(items, line)
  if (index === null) {
    setRatio(lineRatio(line, countDocumentLines(content)))
    return
  }
  const target = getHeadingEls()[index]
  if (!target) {
    setRatio(lineRatio(line, countDocumentLines(content)))
    return
  }
  const range = el.scrollHeight - el.clientHeight
  if (range <= 0) return
  // Content-space top of the heading, minus the same 16px scroll-margin-top
  // the editor styles use, so the heading sits just inside the viewport.
  const pos =
    target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 16
  const clamped = Math.max(0, Math.min(pos, range))
  if (Math.abs(el.scrollTop - clamped) < 0.5) return
  suppressScroll = true
  el.scrollTop = clamped
}

defineExpose({ getRatio, setRatio, getHeadingEls, setScrollToLine })

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
  // Heading anchors copy a deep-link fragment. Prefer the note's vault-relative
  // path so the link is resolvable from anywhere; fall back to a bare fragment
  // for unsaved docs. Reads live tab state at click time.
  configureHeadingAnchorUrl((slug) => {
    const path = tabs.activeTab?.path
    const vault = tabs.vault
    if (!path || !vault) return `#${slug}`
    return `${vault.replace(/\/+$/, '')}/${path}#${slug}`
  })
  const current = tabs.activeTab
  if (current) await applyContent(current.content)

  emitLifecycle('onEditorReady', editor)

  editorEl.value.addEventListener('pointerdown', onContainerPointerDownCapture, true)
  editorEl.value.addEventListener('click', onEditorClick)
  // Paste/drop must be captured on the PANE (an ancestor) so they run before
  // ProseMirror's own at-target handlers on the editor root; otherwise PM
  // would already have consumed the event (e.g. inserting remote <img> html)
  // before the attachment pipeline can intercept image files.
  scrollEl.value?.addEventListener('paste', onPaste, true)
  scrollEl.value?.addEventListener('drop', onDrop, true)
  scrollEl.value?.addEventListener('dragover', onDragOver)
  scrollEl.value?.addEventListener('dragenter', onDragOver)
  window.addEventListener('keydown', onKeydown)
  editorEl.value.addEventListener('keydown', onEditorFocusKeydown)
  editorEl.value.addEventListener('pointerdown', onEditorFocusPointerdown)

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

  // Keep the find/spell overlays in sync with every model change.
  unlistenOverlayRefresh = editor.onContentChange(() => {
    if (applyingExternal) return
    queueOverlayRefresh()
  })

  // Spell check is a reactive setting: sync the live toggle (default true) so
  // the renderSearch overlay honors it on open, and re-apply on change.
  setSpellEnabled(appearance.spellCheckEnabled)
})

watch(
  () => appearance.spellCheckEnabled,
  (enabled) => {
    setSpellEnabled(enabled)
  },
)

watch(
  () => appearance.focusMode,
  (on) => {
    if (on) queueCenterCursor()
  },
)

onBeforeUnmount(() => {
  if (docChangeTimer) {
    clearTimeout(docChangeTimer)
    docChangeTimer = null
  }
  if (overlayRaf) {
    cancelAnimationFrame(overlayRaf)
    overlayRaf = 0
  }
  if (focusRaf) {
    cancelAnimationFrame(focusRaf)
    focusRaf = 0
  }
  if (tabs.activeId) tabs.cancelAutosave(tabs.activeId)
  setCalloutView(null)
  configureImageResolver(null)
  configureHeadingAnchorUrl(null)
  editorBridge.setEditor(null)
  setActiveEditor(null)
  editorEl.value?.removeEventListener('pointerdown', onContainerPointerDownCapture, true)
  editorEl.value?.removeEventListener('click', onEditorClick)
  editorEl.value?.removeEventListener('keydown', onEditorFocusKeydown)
  editorEl.value?.removeEventListener('pointerdown', onEditorFocusPointerdown)
  scrollEl.value?.removeEventListener('paste', onPaste, true)
  scrollEl.value?.removeEventListener('drop', onDrop, true)
  scrollEl.value?.removeEventListener('dragover', onDragOver)
  scrollEl.value?.removeEventListener('dragenter', onDragOver)
  window.removeEventListener('keydown', onKeydown)
  unlistenChange?.()
  unlistenOverlayRefresh?.()
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
      v-if="appearance.wordGoal > 0"
      class="nw-word-goal"
      :class="{ 'is-done': wordGoalMet }"
    >
      <span class="nw-word-goal-label">
        {{ t('settings.editor.wordGoalProgress', { current: wordCount, goal: appearance.wordGoal }) }}
      </span>
      <span class="nw-word-goal-track">
        <span
          class="nw-word-goal-fill"
          :style="{ width: `${wordProgressPct}%` }"
        />
      </span>
    </div>
    <RenderSearchPanel
      v-if="searchOpen"
      class="nw-render-search-host"
      @close="onSearchClose"
    />
    <div
      ref="editorEl"
      class="editor-container"
    />
    <div
      v-if="spellPopup"
      class="nw-spell-popup"
      :style="{ left: `${spellPopup.x}px`, top: `${spellPopup.y}px` }"
      @click.stop
    >
      <div class="nw-spell-popup-title">
        {{ spellPopup.word }}
      </div>
      <div class="nw-spell-popup-label">
        {{ t('spell.suggestions') }}
      </div>
      <template v-if="spellPopup.suggestions.length">
        <button
          v-for="s in spellPopup.suggestions"
          :key="s"
          class="nw-spell-popup-item"
          type="button"
          @click="onSpellSuggestion(s)"
        >
          {{ s }}
        </button>
      </template>
      <div
        v-else
        class="nw-spell-popup-none"
      >
        {{ t('spell.noSuggestions') }}
      </div>
    </div>
  </div>
  <RenameDialog
    v-if="renamePrompt"
    :initial="renamePrompt.initial"
    @confirm="onRenameConfirm"
    @cancel="onRenameCancel"
  />
</template>

<style scoped>
.rendered-pane {
  width: 100%;
  height: 100%;
  overflow: auto;
  background: var(--app-canvas);
}
.nw-word-goal {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: var(--app-content-width);
  margin: 0 auto;
  padding: 10px 24px 8px;
  background: color-mix(in srgb, var(--app-canvas) 86%, transparent);
  backdrop-filter: blur(3px);
  font-family: var(--app-font);
  font-size: 11px;
  color: var(--app-muted);
}
.nw-word-goal-label {
  flex: none;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.nw-word-goal-track {
  flex: 1;
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-border) 80%, transparent);
  overflow: hidden;
}
.nw-word-goal-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--app-accent);
  transition: width var(--app-motion-fast) var(--app-ease),
              background var(--app-motion-fast) var(--app-ease);
}
.nw-word-goal.is-done .nw-word-goal-fill {
  background: var(--app-accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--app-accent) 55%, transparent);
}
.nw-word-goal.is-done .nw-word-goal-label {
  color: var(--app-accent);
  font-weight: 600;
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

.rendered-pane :deep(.nw-find-hit) {
  background: color-mix(in srgb, var(--app-accent) 28%, transparent);
  border-radius: 2px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--app-accent) 28%, transparent);
  color: inherit;
}
.rendered-pane :deep(.nw-find-active) {
  background: var(--app-accent);
  color: var(--app-accent-contrast);
  box-shadow: none;
}

/* Spell squiggle: wavy underline, clickable, theme-token driven. */
.rendered-pane :deep(.nkw-spell) {
  text-decoration: underline wavy var(--app-danger);
  text-decoration-thickness: 1.5px;
  text-underline-offset: 3px;
  cursor: pointer;
  border-radius: 2px;
}
.rendered-pane :deep(.nkw-spell:hover) {
  background: color-mix(in srgb, var(--app-danger) 12%, transparent);
}

/* Suggestion popup for a clicked misspelled word. */
.nw-spell-popup {
  position: fixed;
  z-index: 60;
  min-width: 150px;
  max-width: 240px;
  padding: 6px;
  background: var(--app-elevated);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-md);
  box-shadow: 0 8px 28px color-mix(in srgb, var(--app-text) 16%, transparent);
  font-family: var(--app-font);
  font-size: 12px;
}
.nw-spell-popup-title {
  padding: 2px 6px;
  font-weight: 600;
  color: var(--app-danger);
}
.nw-spell-popup-label {
  padding: 2px 6px;
  color: var(--app-muted);
  font-size: 11px;
}
.nw-spell-popup-item {
  display: block;
  width: 100%;
  padding: 4px 6px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.nw-spell-popup-item:hover {
  background: color-mix(in srgb, var(--app-accent) 18%, transparent);
  color: var(--app-accent);
}
.nw-spell-popup-none {
  padding: 4px 6px;
  color: var(--app-muted);
  font-size: 11px;
}
</style>
