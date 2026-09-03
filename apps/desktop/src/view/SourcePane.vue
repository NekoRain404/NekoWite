<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorView } from '@codemirror/view'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'
import { createCodeMirrorHost, type CodeMirrorHostHandle } from '../services/codeMirrorHost'
import {
  sourceExtensions,
  setMeasureSuppressed as gateSetMeasureSuppressed,
  isMeasureSuppressed as gateIsMeasureSuppressed,
} from '../services/cmSourceView'

const tabs = useTabsStore()
const view = useViewStore()

const container = ref<HTMLDivElement | null>(null)
let host: CodeMirrorHostHandle | null = null
// The tab whose content the CodeMirror doc currently mirrors. Local edits are
// attributed to it, so a burst that fires right after a tab switch can never
// land on the wrong tab.
let mirroredTabId: string | null = null
// Set by setRatio() so the next scroll event (the async echo of a programmatic
// scroll) is swallowed, breaking the split-mode sync feedback loop.
let suppressScroll = false
// rAF throttle for scroll → store writes: coalesce burst scroll events into one
// syncScroll per frame instead of driving the editor chain on every event.
let scrollRaf = 0

function emitChange(text: string): void {
  const tab = mirroredTabId ? tabs.tabs.find((t) => t.id === mirroredTabId) : null
  if (!tab) return
  tab.content = text
  tabs.markDirty(tab.id)
  tabs.scheduleAutosave(tab.id)
}

onMounted(() => {
  if (!container.value) return
  mirroredTabId = tabs.activeId
  host = createCodeMirrorHost({
    doc: tabs.activeTab?.content ?? '',
    extensions: sourceExtensions(),
    onChange: emitChange,
    onCreateEditor: (editorView) => {
      editorView.scrollDOM.addEventListener('scroll', onScroll, { passive: true })
    },
  })
  host.mount(container.value)
})

watch(
  () => tabs.activeId,
  (id) => {
    if (!host) return
    // Flush the pending burst into the tab being LEFT before the mirror
    // moves on (this watcher runs before the content watcher below).
    host.flush()
    mirroredTabId = id
    host.setText(tabs.tabs.find((t) => t.id === id)?.content ?? '')
  },
)

// External content changes (disk reload, history restore, plugin rewrite,
// conflict re-write) follow into the source view as a full setValue tagged
// with the ExternalChange annotation — no undo pollution, no echo back.
watch(
  () => tabs.activeTab?.content,
  (content) => {
    if (content === undefined || !host) return
    host.setText(content)
  },
)

// The pane lives under v-show: re-measure once it becomes visible again so
// the CodeMirror layout (created while display:none) is correct.
watch(
  () => view.mode,
  async (mode) => {
    if (mode === 'rendered' || !host) return
    await nextTick()
    host.getView()?.requestMeasure()
  },
)

function onScroll(): void {
  // A programmatic scroll (setRatio) fires its scroll event asynchronously;
  // swallow exactly that one event so it cannot write back to the store and
  // re-enter the split-mode sync loop (which fights the mouse wheel).
  if (suppressScroll) {
    suppressScroll = false
    return
  }
  if (scrollRaf !== 0) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    view.syncScroll('source', scrollRatio())
  })
}

function getRatio(): number {
  return scrollRatio()
}

function setRatio(r: number): void {
  const cm = host?.getView()
  if (!cm) return
  const el = cm.scrollDOM
  const range = el.scrollHeight - el.clientHeight
  if (range <= 0) return
  const target = r * range
  // Only arm the suppression when the position actually changes — a no-op
  // assignment fires no scroll event, so the flag must not leak.
  if (Math.abs(el.scrollTop - target) < 0.5) return
  suppressScroll = true
  el.scrollTop = target
}

function scrollRatio(): number {
  const cm = host?.getView()
  if (!cm) return 0
  const el = cm.scrollDOM
  const range = el.scrollHeight - el.clientHeight
  return range > 0 ? el.scrollTop / range : 0
}

function focus(): void {
  host?.getView()?.focus()
}

function getText(): string {
  return host?.flush() ?? ''
}

function getSourceView(): EditorView | null {
  return host?.getView() ?? null
}

/** The 1-based line number of the first content line currently visible. */
function getVisibleUnit(): number | null {
  const cm = host?.getView()
  if (!cm) return null
  const block = cm.lineBlockAtHeight(Math.max(0, cm.scrollDOM.scrollTop))
  if (!block) return null
  return cm.state.doc.lineAt(block.from).number
}

/**
 * Toggle the split-drag measure suppression. While dragging, CodeMirror's
 * decoration plugin holds its stale set (see cmSourceView's measure gate) so
 * per-frame resize does not re-traverse visibleRanges + the syntax tree. When
 * the drag ends, one trailing measure restores a correct viewport.
 */
function setMeasureSuppressed(suppressed: boolean): void {
  if (suppressed === gateIsMeasureSuppressed()) return
  gateSetMeasureSuppressed(suppressed)
  if (!suppressed) host?.getView()?.requestMeasure()
}

defineExpose({ getRatio, setRatio, focus, getText, getSourceView, getVisibleUnit, setMeasureSuppressed })

onBeforeUnmount(() => {
  if (scrollRaf !== 0) cancelAnimationFrame(scrollRaf)
  host?.getView()?.scrollDOM.removeEventListener('scroll', onScroll)
  host?.destroy()
  host = null
})
</script>

<template>
  <div
    ref="container"
    class="source-pane"
    data-testid="source-pane"
  />
</template>

<style scoped>
.source-pane {
  width: 100%;
  height: 100%;
  background: var(--app-canvas);
}

/* Markdown source highlighting — mirrors editor-content.css typography.
   All colors come from --app-* tokens and follow data-theme automatically. */
.source-pane :deep(.cm-md-heading) {
  color: var(--app-text);
  font-weight: 700;
  letter-spacing: -0.03em;
}
.source-pane :deep(.cm-line:has(.cm-md-h1)) {
  font-size: 1.72em;
  line-height: 1.28;
}
.source-pane :deep(.cm-line:has(.cm-md-h2)) {
  font-size: 1.45em;
  line-height: 1.3;
}
.source-pane :deep(.cm-line:has(.cm-md-h3)) {
  font-size: 1.14em;
  line-height: 1.4;
}
.source-pane :deep(.cm-md-mark) {
  color: color-mix(in srgb, var(--app-muted) 88%, transparent);
  font-weight: 500;
}
.source-pane :deep(.cm-md-task) {
  color: color-mix(in srgb, var(--app-muted) 70%, var(--app-text));
  font-weight: 550;
}
.source-pane :deep(.cm-md-emphasis) {
  font-style: italic;
}
.source-pane :deep(.cm-md-strong) {
  font-weight: 700;
}
.source-pane :deep(.cm-md-strikethrough) {
  color: var(--app-muted);
  text-decoration: line-through;
}
.source-pane :deep(.cm-md-link) {
  color: var(--app-accent);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--app-accent) 38%, transparent);
  text-underline-offset: 2px;
}
.source-pane :deep(.cm-md-url),
.source-pane :deep(.cm-md-label) {
  color: color-mix(in srgb, var(--app-accent) 58%, var(--app-muted));
}
.source-pane :deep(.cm-md-code) {
  font-family: var(--app-mono-font);
  font-size: 0.88em;
  background: color-mix(in srgb, var(--app-panel) 72%, var(--app-canvas));
  border: 1px solid color-mix(in srgb, var(--app-border) 72%, transparent);
  border-radius: var(--app-radius-xs);
  padding: 0.1em 0.35em;
  color: color-mix(in srgb, var(--app-text) 88%, var(--app-muted));
}
.source-pane :deep(.cm-md-codeblock) {
  background: color-mix(in srgb, var(--app-panel) 88%, var(--app-canvas));
}
.source-pane :deep(.cm-md-codeblock .cm-md-code) {
  background: transparent;
  border: none;
  padding: 0;
  font-size: inherit;
}
.source-pane :deep(.cm-md-quote) {
  color: color-mix(in srgb, var(--app-text) 74%, var(--app-muted));
}
.source-pane :deep(.cm-md-hr),
.source-pane :deep(.cm-md-comment) {
  color: var(--app-muted);
}
.source-pane :deep(.cm-md-comment) {
  font-style: italic;
}
.source-pane :deep(.cm-md-string) {
  color: var(--app-code-string);
}
.source-pane :deep(.cm-code-keyword) {
  color: var(--app-code-keyword);
}
.source-pane :deep(.cm-code-number) {
  color: var(--app-code-number);
}
.source-pane :deep(.cm-code-fn) {
  color: var(--app-code-fn);
}
.source-pane :deep(.cm-code-type) {
  color: var(--app-code-type);
}
.source-pane :deep(.cm-code-prop) {
  color: var(--app-code-prop);
}
.source-pane :deep(.cm-code-name),
.source-pane :deep(.cm-code-operator) {
  color: color-mix(in srgb, var(--app-text) 88%, var(--app-muted));
}
.source-pane :deep(.cm-code-invalid) {
  color: var(--app-danger);
}

/* zh search panel */
.source-pane :deep(.nw-search) {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 12px;
  font-family: var(--app-font);
  font-size: 12px;
}
.source-pane :deep(.nw-search-field) {
  width: 180px;
  padding: 4px 8px;
  border: 1px solid color-mix(in srgb, var(--app-border) 72%, transparent);
  border-radius: var(--app-radius-sm);
  background: var(--app-canvas);
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  outline: none;
}
.source-pane :deep(.nw-search-field:focus) {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
}
.source-pane :deep(.nw-search-field.is-invalid) {
  border-color: var(--app-danger);
}
.source-pane :deep(.nw-search-count) {
  min-width: 56px;
  text-align: center;
  color: var(--app-muted);
}
.source-pane :deep(.nw-search-group) {
  display: flex;
  align-items: center;
  gap: 2px;
}
.source-pane :deep(.nw-search-toggle),
.source-pane :deep(.nw-search-action),
.source-pane :deep(.nw-search-close) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  padding: 0 6px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 11px;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.source-pane :deep(.nw-search-toggle:hover),
.source-pane :deep(.nw-search-action:hover),
.source-pane :deep(.nw-search-close:hover) {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 62%, transparent);
}
.source-pane :deep(.nw-search-toggle.is-active) {
  color: var(--app-accent-contrast);
  background: var(--app-accent);
}
</style>
