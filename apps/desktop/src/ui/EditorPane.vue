<script setup lang="ts">
import { onBeforeUnmount, onMounted, computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import { setImageInsertHandler } from '@nekowite/editor-core'
import { FileText } from 'lucide-vue-next'
import { useAppearanceStore } from '../stores/appearance'
import { useViewStore, SPLIT_RATIO_DEFAULT, SPLIT_RATIO_MAX, SPLIT_RATIO_MIN } from '../stores/view'
import { useTabsStore } from '../stores/tabs'
import type { EditorView } from '@codemirror/view'
import RenderedPane from '../view/RenderedPane.vue'
import LayoutResizeHandle from './LayoutResizeHandle.vue'
import WordToolbar from '../components/WordToolbar.vue'
import FloatToolbar from '../components/FloatToolbar.vue'
import RenameDialog from '../components/RenameDialog.vue'
import { useImageIntake } from '../features/editor/composables/useImageIntake'
import { runEditorCommand } from '../services/runEditorCommand'
import { useFloatStore } from '../stores/float'
import { getSourceView } from '../services/sourceView'
import { noteFocusedPane, resetFocusedPane } from '../services/editorOwnership'
import { parseOutline, type OutlineItem } from '../services/outline'
import { createSplitScrollCoordinator } from '../services/splitScrollCoordinator'
import { countDocumentLines } from '../services/scrollSyncAnchors'
import {
  planPaneSync,
  type PaneGeometry,
  type PaneSyncPlan,
} from '../features/editor/controller/paneScrollMapping'
import { t } from '../i18n'

// The source (CodeMirror) pane is loaded only when the user actually needs it.
// Its graph (@codemirror/*, @lezer/*, the host and highlighting services) would
// otherwise be pulled into the first-load bundle even though the Milkdown
// rendered view is what shows on open. Importing it on demand keeps CodeMirror
// off the eager path and lets the pane be torn down (v-if, not v-show) so it is
// not kept resident while the rendered editor is displayed.
type SourcePaneExpose = {
  setScrollTop(top: number, token: number): void
  getScrollTop(): number
  getScrollRange(): number
  scrollTopForLine(line: number): number
  focus(): void
  getText(): string
  getSourceView(): EditorView | null
  getVisibleUnit(): number | null
  setMeasureSuppressed(suppressed: boolean): void
}

const SourcePane = defineAsyncComponent(() => import('../view/SourcePane.vue'))

const view = useViewStore()
const tabs = useTabsStore()
const appearance = useAppearanceStore()
const floatStore = useFloatStore()

const hasTab = computed(() => tabs.activeTab !== null)

const sourcePane = ref<SourcePaneExpose | null>(null)
const renderedPane = ref<InstanceType<typeof RenderedPane> | null>(null)
const panesEl = ref<HTMLElement | null>(null)

// Image intake (paste / drop / file picker) is shared by both panes, so it is
// registered on the common ancestor rather than inside the rendered pane: the
// source pane used to have no handler at all, which is why pasting an image in
// source mode fell through to the raw-text paste.
const {
  renamePrompt,
  onRenameConfirm,
  onRenameCancel,
  onPaste,
  onDrop,
  onDragOver,
  insertImagesFromPicker,
} = useImageIntake()

// ---------------------------------------------------------------------------
// Split-view scroll sync
//
// Both panes report the user's own scrolls here; everything else is the
// coordinator below. It keeps one pending destination per tick and eases toward
// the newest target, re-anchoring where the pane actually is, so a wheel burst
// stays responsive instead of queueing one sync per event.
//
// The panes' exposed positions are still mirrored into the view store as the
// current scroll state, but the store is no longer the transport: it used to
// carry a programmatic write into the other pane, where the resulting scroll
// event came back as a fresh user-originated sync request and the two panes
// fought. Instead each pane reports only the scrolls the user made (see its
// `user-scroll` event) and swallows the echo of a programmatic write, which
// carries the sync token that caused it.
// ---------------------------------------------------------------------------

type PaneId = 'source' | 'rendered'

/** The pane the coordinator is currently moving. A user scroll switches it: the
 *  pane being scrolled becomes the origin and stops being driven, which is what
 *  makes a leg in flight interruptible. */
let destination: PaneId = 'rendered'
/** Identifies each programmatic write, and handed to the pane that receives it:
 *  a program's scroll event arrives later with nothing else to say where it came
 *  from, so the write carries its token and the pane keeps it (see the panes'
 *  `setScrollTop`). */
let syncToken = 0

function nextToken(): number {
  syncToken += 1
  return syncToken
}

function paneScrollTop(id: PaneId): number {
  if (id === 'source') return sourcePane.value?.getScrollTop() ?? 0
  return renderedPane.value?.getScrollTop() ?? 0
}

function paneScrollRange(id: PaneId): number {
  if (id === 'source') return sourcePane.value?.getScrollRange() ?? 0
  return renderedPane.value?.getScrollRange() ?? 0
}

function writeDestination(top: number): void {
  const token = nextToken()
  if (destination === 'source') sourcePane.value?.setScrollTop(top, token)
  else renderedPane.value?.setScrollTop(top, token)
}

/** Parsed outline and line count of the document on screen. Every scroll event
 *  maps through these, so they are kept for the content string they were parsed
 *  from: re-parsing the whole document per wheel event would be O(document) per
 *  frame of a burst. */
let outlineSource = ''
let outlineItems: OutlineItem[] = []
let outlineLines = 1

function outlineForSync(): { items: OutlineItem[]; totalLines: number } {
  const content = tabs.activeTab?.content ?? ''
  if (content !== outlineSource) {
    outlineSource = content
    outlineItems = parseOutline(content)
    outlineLines = countDocumentLines(content)
  }
  return { items: outlineItems, totalLines: outlineLines }
}

/** The geometry the mapping works from: the panes' live offsets. The rendered
 *  headings' offsets collapse to null when they and the parsed outline are out
 *  of step (a heading mid-render), and the source pane's own line offsets come
 *  from the pane, which is the only thing that can measure them. */
function paneGeometry(from: PaneId, to: PaneId): PaneGeometry {
  const { items, totalLines } = outlineForSync()
  const tops = renderedPane.value?.getHeadingTops() ?? []
  return {
    fromTop: paneScrollTop(from),
    fromRange: paneScrollRange(from),
    toRange: paneScrollRange(to),
    totalLines,
    items,
    tops: items.length > 0 && tops.length === items.length ? tops : null,
    sourceTopOfLine: (line) => sourcePane.value?.scrollTopForLine(line) ?? 0,
  }
}

/** Where the counterpart pane has to be to show what `from` is showing, or null
 *  while either pane is missing (the source pane is an async component). */
function planSync(from: PaneId, to: PaneId): PaneSyncPlan | null {
  const source = sourcePane.value
  if (!source || !renderedPane.value) return null
  return planPaneSync(from, paneGeometry(from, to), source.getVisibleUnit() ?? 1)
}

/** The OS-level "reduce motion" preference — the same check the command palette
 *  makes. Scroll sync has to land immediately when the user asked for that. */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

const scrollCoordinator = createSplitScrollCoordinator({
  // requestAnimationFrame is already shaped the way the coordinator wants it.
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (handle) => window.cancelAnimationFrame(handle),
  readScroll: () => paneScrollTop(destination),
  writeScroll: (top) => writeDestination(top),
  clampScroll: (top) => {
    const range = paneScrollRange(destination)
    if (!Number.isFinite(top)) return top > 0 ? range : 0
    return Math.max(0, Math.min(top, range))
  },
})

/**
 * Bring the counterpart of `from` onto the position `from` is showing.
 *
 * `animated` is the caller's answer to "may this glide?": user scrolling does,
 * the discrete moves (entering split, the end of a divider drag, an outline
 * jump) do not, and a document end never does — the ease would spend its last
 * frames creeping up on a position the user has already reached.
 */
function align(from: PaneId, animated: boolean): void {
  const to: PaneId = from === 'source' ? 'rendered' : 'source'
  const plan = planSync(from, to)
  if (!plan) return
  // The destination has to be selected before the coordinator is asked to move:
  // it reads and writes through the adapter, which follows this.
  destination = to
  scrollCoordinator.schedule(plan.top, animated && !plan.atEdge && !prefersReducedMotion())
}

/** A scroll the user made in one of the panes. */
function onUserScroll(from: PaneId): void {
  if (view.mode !== 'split' || resizing || !appearance.autoSyncScroll) return
  align(from, true)
}

// The source pane is loaded on demand (CodeMirror is async). Entering split
// mode from the rendered view can happen before that chunk has resolved, so we
// remember the pane that was visible before the switch and re-align once the
// source pane's ref populates. The pane that was visible before entering split
// is the reference: align the other pane to its scroll position once layout is
// done. Both entries do nothing until both panes actually exist.
let pendingSplitAlignFrom: 'source' | 'rendered' | null = null

function alignSplitPanes(prev: 'source' | 'rendered'): void {
  // A layout move, not a scroll: the panes are put where they belong at once.
  align(prev, false)
}

watch(
  () => view.mode,
  (mode, prev) => {
    // Whatever the coordinator was moving belongs to the layout being left.
    scrollCoordinator.cancel()
    if (mode !== 'split' || prev === 'split') return
    pendingSplitAlignFrom = prev
    void nextTick(() => {
      if (view.mode !== 'split') return
      // The source pane may still be resolving its async chunk — the ref
      // watcher below retries once it mounts.
      if (!sourcePane.value || !renderedPane.value) return
      pendingSplitAlignFrom = null
      alignSplitPanes(prev)
    })
  },
)

watch(
  () => sourcePane.value,
  () => {
    if (view.mode !== 'split') return
    if (!pendingSplitAlignFrom || !sourcePane.value || !renderedPane.value) return
    const prev = pendingSplitAlignFrom
    pendingSplitAlignFrom = null
    alignSplitPanes(prev)
  },
)

// The floating-box toolbar lives on the shared pane container, so it stays on
// screen in source mode even though the element it operates on is hidden. Its
// buttons edit the rendered model, which source mode does not own, so the
// selection is dropped rather than offering controls that cannot work.
watch(
  () => view.mode,
  (mode) => {
    if (mode === 'source') floatStore.select(null)
  },
)

let resizing = false

function onSplitResizeStart(): void {
  resizing = true
  // The panes are being resized under the animation: stop it where it is and
  // re-align once the drag is over.
  scrollCoordinator.cancel()
  sourcePane.value?.setMeasureSuppressed(true)
}

function onSplitResize(value: number): void {
  view.setSplitRatio(value)
}

function clearResizing(): void {
  if (!resizing) return
  resizing = false
  sourcePane.value?.setMeasureSuppressed(false)
}

function onSplitResizeEnd(): void {
  if (!resizing) return
  clearResizing()
  if (view.mode !== 'split') return
  // Widths changed under both panes, so their scroll offsets are stale:
  // re-align once from the source pane (document flow reference), then let
  // normal scroll sync take over.
  align('source', false)
}

const sourceStyle = computed((): Record<string, string> => {
  if (view.mode !== 'split') return {}
  return { width: `${view.splitRatio * 100}%` }
})
const renderedStyle = computed((): Record<string, string> => {
  if (view.mode !== 'split') return {}
  return { width: `${(1 - view.splitRatio) * 100}%` }
})

function scrollToLine(line: number): void {
  const pane = sourcePane.value
  if (!pane) return
  const cm = pane.getSourceView()
  if (!cm) return
  const doc = cm.state.doc
  const clamped = Math.max(0, Math.min(line, doc.lines - 1))
  const info = cm.lineBlockAt(doc.line(clamped + 1).from)
  cm.scrollDOM.scrollTop = Math.max(0, info.top - cm.scrollDOM.clientHeight / 3)
}

watch(
  () => view.pendingOutlineTarget,
  async (target) => {
    if (!target) return
    view.consumeOutlineTarget()
    await nextTick()
    if (view.mode === 'source') {
      scrollToLine(target.line)
      return
    }
    // A jump is discrete: the rendered pane snaps onto the block that holds the
    // line and the source follows it without easing. Both writes are the
    // program's, so neither comes back as a user scroll.
    destination = 'rendered'
    renderedPane.value?.setScrollToLine(target.line, nextToken())
    if (view.mode === 'split') align('rendered', false)
  },
)

/**
 * Dispatch a toolbar command through the shared, mode-aware runner so the
 * button does the same thing in every view mode (the palette and the plugin
 * buttons use the same entry point).
 */
function handleCommand(id: string): void {
  runEditorCommand(id)
}

function onKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    // saveTab flushes the source pane itself, so the save always sees the live
    // document.
    void tabs.saveActive()
  }
}

/**
 * Remember which editor pane the user is working in, so a command invoked from
 * a surface that takes focus itself (the command palette, a toolbar button)
 * still targets the right pane.
 */
function onFocusIn(e: FocusEvent): void {
  const target = e.target as Node | null
  if (!target) return
  const sourceDom = getSourceView()?.dom
  if (sourceDom && sourceDom.contains(target)) {
    noteFocusedPane('source')
    return
  }
  const renderedEl = panesEl.value?.querySelector('.pane.rendered')
  if (renderedEl && renderedEl.contains(target)) noteFocusedPane('rendered')
}

/**
 * Paste/drop listeners are attached to the pane container, which is created
 * together with the first tab, so they follow the element rather than
 * mount order (an empty app has no `.panes` to attach to yet).
 */
let listenersOn: HTMLElement | null = null
function attachPaneListeners(el: HTMLElement | null): void {
  if (listenersOn === el) return
  if (listenersOn) {
    listenersOn.removeEventListener('paste', onPaste, true)
    listenersOn.removeEventListener('drop', onDrop, true)
    listenersOn.removeEventListener('dragover', onDragOver)
    listenersOn.removeEventListener('dragenter', onDragOver)
    listenersOn.removeEventListener('focusin', onFocusIn)
  }
  listenersOn = el
  if (!el) return
  // Capture phase, on an ancestor of both panes: this must run before
  // ProseMirror's and CodeMirror's own at-target handlers, or an image paste
  // would already have been consumed as HTML / a file path.
  el.addEventListener('paste', onPaste, true)
  el.addEventListener('drop', onDrop, true)
  el.addEventListener('dragover', onDragOver)
  el.addEventListener('dragenter', onDragOver)
  el.addEventListener('focusin', onFocusIn)
}

watch(panesEl, (el) => attachPaneListeners(el))

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('blur', clearResizing)
  // The `image` toolbar / palette command has no way to reach the clipboard or
  // the file picker from editor-core; this is the host side of that hook.
  setImageInsertHandler(() => void insertImagesFromPicker())
})

onBeforeUnmount(() => {
  attachPaneListeners(null)
  setImageInsertHandler(null)
  resetFocusedPane()
  scrollCoordinator.dispose()
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('blur', clearResizing)
  clearResizing()
})
</script>

<template>
  <div class="editor-pane">
    <template v-if="hasTab">
      <WordToolbar @command="handleCommand" />
      <div
        ref="panesEl"
        class="panes"
        :class="view.mode"
      >
        <SourcePane
          v-if="view.mode !== 'rendered'"
          ref="sourcePane"
          class="pane source"
          :style="sourceStyle"
          @user-scroll="onUserScroll('source')"
        />
        <LayoutResizeHandle
          v-if="view.mode === 'split'"
          class="split-handle"
          :label="t('editorPane.resizeSplit')"
          :min="SPLIT_RATIO_MIN"
          :max="SPLIT_RATIO_MAX"
          :value="view.splitRatio"
          :default-value="SPLIT_RATIO_DEFAULT"
          :step="0.02"
          delta-unit="fraction"
          @resize-start="onSplitResizeStart"
          @change="onSplitResize"
          @resize-end="onSplitResizeEnd"
        />
        <RenderedPane
          v-show="view.mode !== 'source'"
          ref="renderedPane"
          class="pane rendered"
          :style="renderedStyle"
          @user-scroll="onUserScroll('rendered')"
        />
        <!-- The toolbar is presentational: this pane owns the float store, so
             it feeds the selection down and routes the three actions back into
             the store (whose actions edit the rendered model). -->
        <FloatToolbar
          :selected-id="floatStore.selectedId"
          @bring-forward="floatStore.bringForward()"
          @send-backward="floatStore.sendBackward()"
          @remove="floatStore.removeSelected()"
        />
      </div>
      <RenameDialog
        v-if="renamePrompt"
        :initial="renamePrompt.initial"
        @confirm="onRenameConfirm"
        @cancel="onRenameCancel"
      />
    </template>
    <div
      v-else
      class="editor-empty"
    >
      <div class="empty-icon">
        <FileText
          :size="28"
          :stroke-width="1.5"
        />
      </div>
      <p class="empty-title">
        {{ t('editorPane.emptyTitle') }}
      </p>
      <p class="empty-hint">
        {{ t('editorPane.emptyHint') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.editor-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--app-canvas);
}
.panes {
  position: relative;
  flex: 1;
  display: flex;
  min-height: 0;
}
.pane {
  min-width: 0;
  overflow: auto;
}
.panes.source .pane,
.panes.rendered .pane {
  width: 100%;
}
.panes.split .pane.source {
  border-right: 1px solid var(--app-border);
}
.panes.split .split-handle {
  align-self: stretch;
}

.editor-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--app-muted);
  user-select: none;
}
.empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--app-panel) 70%, var(--app-canvas));
  border: 1px solid var(--app-border);
  color: color-mix(in srgb, var(--app-muted) 70%, transparent);
  margin-bottom: 6px;
}
.empty-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: color-mix(in srgb, var(--app-text) 72%, var(--app-muted));
}
.empty-hint {
  margin: 0;
  font-size: 11px;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
}
</style>
