<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { emitLifecycle } from '@nekowite/plugin-host'
import type { NekoEditor } from '@nekowite/editor-core'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'
import { useFloatStore } from '../stores/float'
import { useAppearanceStore } from '../stores/appearance'
import { resolveDirection } from '../services/rtl'
import { t } from '../i18n'
import { configureTaskChecklistRendering, headingAnchorIds } from '@nekowite/editor-core'
import { resolveLinkPath } from '../features/vault/services/libraryQueries'
import { useDocumentListStore } from '../stores/documentList'
import { dirRelativeToVault } from '../services/noteMeta'
import RenderSearchPanel from './RenderSearchPanel.vue'
import ImagePanel from '../ui/ImagePanel.vue'
import TableMenu from '../ui/TableMenu.vue'
import { createDocumentSession } from '../features/editor/model/documentSession'
import { createEditorController } from '../features/editor/controller/editorController'
import { createEditorPersistence } from '../features/editor/controller/editorPersistence'
import { createEditorExternalSync } from '../features/editor/controller/editorExternalSync'
import { createEditorScrollSync } from '../features/editor/controller/editorScrollSync'
import { createEditorSearchOverlay } from '../features/editor/controller/editorSearchOverlay'
import { createEditorSelection } from '../features/editor/controller/editorSelection'
import { useEditorFocus } from '../features/editor/composables/useEditorFocus'
import { setRenderedFlush } from '../services/editorOwnership'

const tabs = useTabsStore()
const view = useViewStore()
const floatStore = useFloatStore()
const documentList = useDocumentListStore()
const appearance = useAppearanceStore()

const scrollEl = ref<HTMLElement | null>(null)
const editorEl = ref<HTMLElement | null>(null)
const editorForPanel = shallowRef<NekoEditor | null>(null)

// The pane is a thin orchestrator: it owns only the template-bound DOM refs and
// reactive UI state, delegating editor lifecycle, persistence, external sync,
// scroll sync, search overlay and selection to the controller modules.
const session = createDocumentSession()

// Base direction for the rendered content: the user's explicit override wins,
// otherwise the document text decides (Arabic/Hebrew -> rtl). Bound as `dir` on
// the pane root so the browser lays the note out from the correct edge.
const renderDir = computed(() => resolveDirection(appearance.contentDirection, tabs.activeTab?.content ?? ''))

const editorController = createEditorController({
  session,
  getEditorEl: () => editorEl.value,
})
const persistence = createEditorPersistence({ session })
const searchOverlay = createEditorSearchOverlay({
  session,
  getEditor: () => session.editor,
})
const externalSync = createEditorExternalSync({
  session,
  getEditor: () => session.editor,
  scheduleOverlayRefresh: () => searchOverlay.scheduleRefresh(),
})
const scrollSync = createEditorScrollSync({
  session,
  getScrollEl: () => scrollEl.value,
  getEditorEl: () => editorEl.value,
})
const selection = createEditorSelection({ getEditor: () => session.editor })

const { searchOpen, spellPopup } = searchOverlay

// Focus/typewriter centering + the word-count goal live in a composable so the
// pane owns less. The calls read the live `editor`/`scrollEl` via closures.
const {
  wordCount,
  wordGoalMet,
  wordProgressPct,
  queueCenterCursor,
  onFocusKeydown,
  onFocusPointerdown,
  cancelFocusRaf,
} = useEditorFocus({
  getEditor: () => session.editor,
  getScrollEl: () => scrollEl.value,
})

let unlistenChange: (() => void) | null = null
let unlistenOverlayRefresh: (() => void) | null = null

function onScroll(): void {
  scrollSync.onScroll()
}

function getRatio(): number {
  return scrollSync.getRatio()
}

function setRatio(r: number): void {
  scrollSync.setRatio(r)
}

function getHeadingEls(): HTMLElement[] {
  return scrollSync.getHeadingEls()
}

function setScrollToLine(line: number): void {
  scrollSync.setScrollToLine(line)
}

function onContainerPointerDownCapture(e: PointerEvent): void {
  selection.handlePointerDown(e)
}

function onEditorClick(e: MouseEvent): void {
  const target = e.target as Element | null
  const anchor = target?.closest?.('a') as HTMLAnchorElement | null
  const href = anchor?.getAttribute('href') ?? ''
  if (anchor && href) {
    // Every in-document link is handled here, and the default is always
    // prevented: letting the webview follow a relative href would try to
    // navigate the app window itself.
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault()
      e.stopPropagation()
      window.open(href, '_blank', 'noopener,noreferrer')
      return
    }
    if (href.startsWith('#')) {
      e.preventDefault()
      e.stopPropagation()
      scrollToHeadingAnchor(href.slice(1))
      return
    }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      // A same-vault reference (notes/other.md, ../a.md): open it as a tab.
      e.preventDefault()
      e.stopPropagation()
      void openLinkedNote(href)
      return
    }
    // Any other scheme (mailto:, asset:, a hand-written javascript:) is not
    // this pane's business — but it must not navigate the app either.
    e.preventDefault()
    e.stopPropagation()
    return
  }
  const span = target?.closest?.('.nkw-spell') as HTMLElement | null
  if (span) {
    e.preventDefault()
    e.stopPropagation()
    searchOverlay.openSpellPopup(span, e.clientX, e.clientY)
    return
  }
  if (spellPopup.value) {
    const hit = target?.closest?.('.nw-spell-popup')
    if (!hit) spellPopup.value = null
  }
}

/**
 * Scroll the rendered pane to the heading whose slug matches `slug`.
 *
 * The editor's own heading anchors copy `#slug` links, so following one has to
 * land on the heading rather than fall through to the browser (which would try
 * to navigate the app window).
 */
function scrollToHeadingAnchor(slug: string): void {
  if (!slug) return
  const headings = editorEl.value?.querySelectorAll('h1, h2, h3, h4, h5, h6')
  if (!headings) return
  const list = Array.from(headings)
  // Build the same document-wide id list the anchors copy and the export
  // emits, then pick the matching element by INDEX. Comparing slugs would send
  // `#same-1` to the first "Same" instead of the second.
  const ids = headingAnchorIds(list.map((heading) => heading.textContent ?? ''))
  const index = ids.indexOf(slug)
  if (index >= 0) list[index]?.scrollIntoView({ block: 'start', behavior: 'auto' })
}

/** Open a same-vault markdown reference in a new tab. */
async function openLinkedNote(href: string): Promise<void> {
  const vault = tabs.vault
  const notePath = tabs.activeTab?.path
  if (!vault || !notePath) return
  let decoded = href
  try {
    decoded = decodeURIComponent(href)
  } catch {
    // A malformed escape sequence: fall back to the raw href.
  }
  const resolved = resolveLinkPath(
    documentList.notes,
    vault,
    dirRelativeToVault(notePath, vault),
    decoded,
  )
  if (resolved) await tabs.openTab(resolved)
}

function onSpellSuggestion(text: string): void {
  searchOverlay.handleSpellSuggestion(text)
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

defineExpose({ getRatio, setRatio, getHeadingEls, setScrollToLine })

onMounted(async () => {
  if (!editorEl.value) return
  editorController.mount()
  editorForPanel.value = session.editor
  const current = tabs.activeTab
  if (current) await externalSync.applyContent(current.content)

  emitLifecycle('onEditorReady', session.editor)

  editorEl.value.addEventListener('pointerdown', onContainerPointerDownCapture, true)
  editorEl.value.addEventListener('click', onEditorClick)
  window.addEventListener('keydown', onKeydown)
  editorEl.value.addEventListener('keydown', onFocusKeydown)
  editorEl.value.addEventListener('pointerdown', onFocusPointerdown)

  unlistenChange = persistence.attachChangeListener()
  unlistenOverlayRefresh = searchOverlay.attachChangeListener()
  // Published so a one-shot document read (save, export, sending the note to
  // the model) can publish this pane's pending serialization first.
  setRenderedFlush(() => persistence.flush())

  // Spell check is a reactive setting: sync the live toggle (default true) so
  // the renderSearch overlay honors it on open, and re-apply on change.
  searchOverlay.syncSpellEnabled(appearance.spellCheckEnabled)
})

watch(
  () => appearance.spellCheckEnabled,
  (enabled) => {
    searchOverlay.syncSpellEnabled(enabled)
  },
)

watch(
  () => appearance.focusMode,
  (on) => {
    if (on) queueCenterCursor()
  },
)

// The task-list switch is a rendering choice of the live editor: the pane keeps
// one editor per document, and rebuilding it to flip a decoration would throw
// away the undo stack and the caret. editor-core re-decorates the open views
// instead, so `immediate` also seeds the first editor with the stored value.
watch(
  () => appearance.renderTaskChecklist,
  (enabled) => configureTaskChecklistRendering(enabled),
  { immediate: true },
)

onBeforeUnmount(() => {
  try {
    setRenderedFlush(null)
    persistence.cancel()
    searchOverlay.cancelRefresh()
    cancelFocusRaf()
    if (tabs.activeId) tabs.cancelAutosave(tabs.activeId)
    editorForPanel.value = null
    editorEl.value?.removeEventListener('pointerdown', onContainerPointerDownCapture, true)
    editorEl.value?.removeEventListener('click', onEditorClick)
    editorEl.value?.removeEventListener('keydown', onFocusKeydown)
    editorEl.value?.removeEventListener('pointerdown', onFocusPointerdown)
    window.removeEventListener('keydown', onKeydown)
    unlistenChange?.()
    unlistenOverlayRefresh?.()
    scrollSync.cancel()
    editorController.destroy()
  } finally {
    if (session.docChangeTimer) {
      clearTimeout(session.docChangeTimer)
      session.docChangeTimer = null
    }
  }
})

watch(
  () => tabs.activeTab?.content,
  (content) => {
    externalSync.onContentChanged(content)
  },
)

watch(
  () => view.mode,
  (mode) => {
    externalSync.onModeChanged(mode)
  },
)
</script>

<template>
  <div
    ref="scrollEl"
    class="rendered-pane"
    :dir="renderDir"
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
      @close="searchOverlay.closeSearch"
    />
    <div
      ref="editorEl"
      class="editor-container"
    >
      <ImagePanel
        v-if="editorForPanel"
        :editor="editorForPanel"
      />
      <TableMenu
        v-if="editorForPanel"
        :editor="editorForPanel"
      />
    </div>
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

/* Column-width resize: prosemirror-tables arms a thin handle at each column
   divider on hover and flags the editor root with `.resize-cursor`. The handle
   is visual only — pointer events are passed through so the underlying cell
   still reacts to clicks (and the drag is detected by cursor-x proximity). */
.editor-container :deep(.ProseMirror.resize-cursor) {
  cursor: col-resize;
}
.editor-container :deep(.tableWrapper) {
  overflow-x: auto;
}
.editor-container :deep(.column-resize-handle) {
  position: absolute;
  right: -2px;
  top: 0;
  bottom: 0;
  width: 4px;
  z-index: 20;
  background: color-mix(in srgb, var(--app-accent) 55%, transparent);
  pointer-events: none;
}
.editor-container :deep(.column-resize-dragging)::after {
  content: '';
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--app-accent) 18%, transparent);
  pointer-events: none;
}
</style>
