<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorView } from '@codemirror/view'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'
import { useAppearanceStore } from '../stores/appearance'
import { createCodeMirrorHost, type CodeMirrorHostHandle } from '../services/codeMirrorHost'
import {
  sourceExtensions,
  setMeasureSuppressed as gateSetMeasureSuppressed,
  isMeasureSuppressed as gateIsMeasureSuppressed,
} from '../services/cmSourceView'
import {
  setSourceViewHandle,
  releaseSourceViewHandle,
  type SourceViewHandle,
} from '../services/sourceView'
import { markSourceAuthored } from '../services/editorOwnership'
import { resolveDirection } from '../services/rtl'

const tabs = useTabsStore()
const view = useViewStore()
const appearance = useAppearanceStore()

// Reported to the pane's parent (the editor pane), which owns the split-view
// scroll coordinator. Only the user's own scrolls are reported: a programmatic
// write is this pane's own echo and is consumed below.
const emit = defineEmits<{ 'user-scroll': [] }>()

/**
 * The rendered pane already lays its content out from the correct edge; the
 * source pane ignored the setting entirely, so split mode showed the same
 * document LTR on one side and RTL on the other. Same resolver, so both panes
 * agree on what the document's direction is.
 */
const sourceDir = computed(() => resolveDirection(appearance.contentDirection, tabs.activeTab?.content ?? ''))

const container = ref<HTMLDivElement | null>(null)
let host: CodeMirrorHostHandle | null = null
// The tab whose content the CodeMirror doc currently mirrors. Local edits are
// attributed to it, so a burst that fires right after a tab switch can never
// land on the wrong tab.
let mirroredTabId: string | null = null
// Our own entry in the source-pane registry, so teardown can withdraw it
// without clobbering a newer pane that mounted first during a hot swap.
let sourceHandle: SourceViewHandle | null = null
// The last programmatic write: the token that caused it and the offset it
// landed on. Its scroll event arrives later and is indistinguishable by shape
// from a user's, so the record is what lets onScroll tell them apart — matching
// the offset is what makes a write that never fired an event harmless instead
// of swallowing the user's next scroll.
let programWrite: { token: number; top: number } | null = null
// rAF throttle for scroll → store writes: coalesce burst scroll events into one
// store write per frame instead of driving it on every event.
let scrollRaf = 0

function emitChange(text: string): void {
  const tab = mirroredTabId ? tabs.tabs.find((t) => t.id === mirroredTabId) : null
  if (!tab) return
  // Publish the raw text *and* record that the source pane authored it: while
  // this is the tab's content the rendered serializer's output is stale and
  // must not be written back over it.
  markSourceAuthored(text)
  tab.content = text
  tabs.markDirty(tab.id)
  tabs.scheduleAutosave(tab.id)
}

onMounted(() => {
  if (!container.value) return
  host = createCodeMirrorHost({
    doc: '',
    extensions: sourceExtensions({ lineNumbers: appearance.lineNumbers, softWrap: appearance.softWrap }),
    onChange: emitChange,
    onCreateEditor: (editorView) => {
      editorView.scrollDOM.addEventListener('scroll', onScroll, { passive: true })
    },
  })
  host.mount(container.value)
  // Read the live tab AFTER the host exists so a tab switch between setup and
  // mount (or during host construction) cannot be overwritten by a stale
  // snapshot captured before the watchers could apply.
  mirroredTabId = tabs.activeId
  host.setText(tabs.activeTab?.content ?? '')
  // Published for the mode-aware insert / toolbar routing and for the rendered
  // pane's "flush before you serialize" handshake: those run from services and
  // composables, which cannot reach a component ref.
  sourceHandle = {
    getView: () => host?.getView() ?? null,
    flush: () => {
      host?.flush()
    },
  }
  setSourceViewHandle(sourceHandle)
})

// Hot-swap the source view layout when line-number / soft-wrap toggles change.
// codeMirrorHost.reconfigure wraps the whole extension set in a Compartment, so
// this re-applies the Markdown highlighting and search panel unchanged while
// only the layout extensions flip on/off.
watch(
  [() => appearance.lineNumbers, () => appearance.softWrap],
  () => {
    host?.reconfigure(sourceExtensions({ lineNumbers: appearance.lineNumbers, softWrap: appearance.softWrap }))
  },
)

watch(
  () => tabs.activeId,
  (id) => {
    if (!host) return
    // Flush the pending burst into the tab being LEFT before the mirror
    // moves on (this watcher runs before the content watcher below).
    host.flush()
    mirroredTabId = id
    host.setText(tabs.tabs.find((t) => t.id === id)?.content ?? '')
    // `setText` only recognises a document swap when the TEXT changes, so two
    // notes that happen to hold identical text are a swap it cannot see and it
    // leaves the previous note's undo entries reachable. Ctrl+Z in the new note
    // would then invert an edit made in the old one and autosave the result
    // into the new file. The tab change itself is the signal `setText` lacks,
    // so the stack is dropped here unconditionally (idempotent when `setText`
    // already did it).
    host.resetHistory()
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
  const el = host?.getView()?.scrollDOM
  if (!el) return
  // A programmatic scroll fires its scroll event asynchronously, and that event
  // is this pane's own echo — not a scroll the user made, so it must not become
  // a new sync request. The record holds the offset the engine kept, so its echo
  // matches exactly; anything else is the user, however close it lands.
  const written = programWrite
  programWrite = null
  if (written && el.scrollTop === written.top) return
  emit('user-scroll')
  if (scrollRaf !== 0) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    view.syncScroll('source', scrollRatio())
  })
}

function getScrollTop(): number {
  return host?.getView()?.scrollDOM.scrollTop ?? 0
}

/** The pane's scrollable extent: 0 when the whole document fits. */
function getScrollRange(): number {
  return scrollRange()
}

/** Write an offset from outside, tagged with the sync token that caused it. The
 *  pane keeps the tag so its own scroll event can be recognised as an echo. */
function setScrollTop(top: number, token: number): void {
  const el = host?.getView()?.scrollDOM
  if (!el) return
  const clamped = Number.isFinite(top) ? Math.max(0, Math.min(top, scrollRange())) : 0
  el.scrollTop = clamped
  // Record what the engine ACCEPTED, not what was asked for: it snaps a scroll
  // offset to its own quantum (and clamps it to the range), so the requested
  // value can sit up to half a pixel from the one the write's scroll event will
  // report — a whole pixel on an engine that truncates. Reading the offset back
  // closes that gap, which is what lets onScroll compare exactly below.
  programWrite = { token, top: el.scrollTop }
}

/** The offset that puts the top of `line` (1-based) at the top of the viewport. */
function scrollTopForLine(line: number): number {
  const cm = host?.getView()
  if (!cm) return 0
  const doc = cm.state.doc
  const clamped = Math.max(1, Math.min(Math.floor(line), doc.lines))
  return Math.max(0, cm.lineBlockAt(doc.line(clamped).from).top)
}

function scrollRange(): number {
  const el = host?.getView()?.scrollDOM
  if (!el) return 0
  return Math.max(0, el.scrollHeight - el.clientHeight)
}

function scrollRatio(): number {
  const range = scrollRange()
  return range > 0 ? getScrollTop() / range : 0
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

/** The 1-based line number of the first content line currently visible, i.e.
 *  the one occupying the viewport's first pixel. The read is taken one pixel
 *  in because CodeMirror resolves a height landing exactly on a line's top to
 *  the line above it — which would report the line just scrolled past. */
function getVisibleUnit(): number | null {
  const cm = host?.getView()
  if (!cm) return null
  const block = cm.lineBlockAtHeight(Math.max(0, cm.scrollDOM.scrollTop + 1))
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

defineExpose({
  setScrollTop,
  getScrollTop,
  getScrollRange,
  scrollTopForLine,
  focus,
  getText,
  getSourceView,
  getVisibleUnit,
  setMeasureSuppressed,
})

onBeforeUnmount(() => {
  if (scrollRaf !== 0) cancelAnimationFrame(scrollRaf)
  host?.getView()?.scrollDOM.removeEventListener('scroll', onScroll)
  if (sourceHandle) releaseSourceViewHandle(sourceHandle)
  sourceHandle = null
  host?.destroy()
  host = null
})
</script>

<template>
  <div
    ref="container"
    class="source-pane"
    data-testid="source-pane"
    :dir="sourceDir"
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
