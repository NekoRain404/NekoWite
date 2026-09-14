<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorView } from '@codemirror/view'
import { Transaction } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'
import { useAppearanceStore } from '../stores/appearance'
import {
  createCodeMirrorHost,
  ExternalChange,
  type CodeMirrorHostHandle,
} from '../services/code-mirror-host'
import { mirrorChange } from '../features/editor/model/mirror-change'
import { useEditorTailSpace } from '../features/editor/composables/use-editor-tail-space'
import {
  sourceExtensions,
  setMeasureSuppressed as gateSetMeasureSuppressed,
  isMeasureSuppressed as gateIsMeasureSuppressed,
} from '../services/cm-source-view'
import {
  setSourceViewHandle,
  releaseSourceViewHandle,
  type SourceViewHandle,
} from '../services/source-view'
import { markSourceAuthored } from '../services/editor-ownership'
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

// Trailing space, the source pane's half: the pad goes on CodeMirror's own
// content box (`.cm-content`), which is where "below the last line" lives, and
// it is subtracted from the scroll range this pane reports — space, not
// document, and never part of the extent the split sync maps through.
const { tailSpacePx, attach: attachTailSpace } = useEditorTailSpace({
  getScrollEl: () => host?.getView()?.scrollDOM ?? null,
  apply: (px) => container.value?.style.setProperty('--nkw-tail-space', `${px}px`),
})
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
  // The scroller this measures is CodeMirror's own element, created just above:
  // there is nothing reactive to watch, so the pane says when it exists.
  attachTailSpace()
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

/**
 * Mirror the tab's text into the CodeMirror document.
 *
 * A change of the SAME note's text (a disk reload, a history restore, a plugin
 * rewrite, or — in split mode — the rendered pane's own edits arriving back
 * through the tab) is applied as the smallest edit that produces the text, not
 * as the host's whole-document `setText`.
 *
 * Why that distinction is the difference between "the mirror" and "the reader
 * is thrown to the top": a whole-document replacement moves CodeMirror's scroll
 * anchor to position 0 (a position inside a replaced range maps to the start of
 * the replacement), so the view decides everything above the viewport is gone
 * and scrolls up — measured in the browser on a 9000px note: 4145px -> 115px.
 * In split mode the sync then reads that scroll as one the user made and eases
 * the OTHER pane to the top as well, which is the reported defect ("typing in
 * the rendered pane collapses both panes"). A minimal change maps every position
 * through itself — the scroll anchor included — so the reader does not move.
 *
 * The transaction carries the host's own semantics — the `ExternalChange`
 * annotation (so the host's listener does not echo this back as a local edit),
 * `addToHistory: false` and an isolation point (a text that arrived from
 * elsewhere is not an undo step) — and the host's `setText` still runs
 * afterwards, on a document that already holds the text, which is the host's
 * documented no-op path: it is what cancels a pending local burst and keeps
 * `lastEmitted` the host's business rather than this pane's.
 *
 * A document SWAP goes through the tab watcher below, which calls the host
 * directly: a different note's text must NOT keep this pane's position.
 */
watch(
  () => tabs.activeTab?.content,
  (content) => {
    if (content === undefined || !host) return
    const cm = host.getView()
    const change = cm ? mirrorChange(cm.state.doc.toString(), content) : null
    if (cm && change) {
      host.resetHistory()
      cm.dispatch({
        changes: change,
        annotations: [
          ExternalChange.of(true),
          Transaction.addToHistory.of(false),
          isolateHistory.of('full'),
        ],
      })
    }
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
  // Where this pane is, recorded whoever moved it: a mode switch reads the
  // memory to put the pane back, and a programmatic write moved it just as much
  // as a wheel did. Written before the echo check below, which decides only
  // whether this scroll is the USER's (a sync request) — not whether it counts
  // as position.
  view.syncScroll('source', el.scrollTop, scrollRange())
  // A programmatic scroll fires its scroll event asynchronously, and that event
  // is this pane's own echo — not a scroll the user made, so it must not become
  // a new sync request. The record holds the offset the engine kept, so its echo
  // matches exactly; anything else is the user, however close it lands.
  const written = programWrite
  programWrite = null
  if (written && el.scrollTop === written.top) return
  emit('user-scroll')
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

/** The offset that puts the top of `line` (1-based, possibly fractional: 12.5 is
 *  halfway down the twelfth line's block) at the top of the viewport.
 *
 *  An integer line lands exactly where it always did — the fraction only ever
 *  subdivides the line's own block, and CodeMirror measures a wrapped line's
 *  block as one unit (see `lineBlockAt`), so the subdivision stays inside the
 *  line as drawn. */
function scrollTopForLine(line: number): number {
  const cm = host?.getView()
  if (!cm) return 0
  const doc = cm.state.doc
  const clamped = Math.max(1, Math.min(line, doc.lines))
  const start = Math.floor(clamped)
  const block = cm.lineBlockAt(doc.line(start).from)
  return Math.max(0, block.top + (clamped - start) * block.height)
}

/**
 * Put `line` at the top of the viewport, measured rather than estimated.
 *
 * `scrollTopForLine` turns a line into an offset through CodeMirror's height
 * map, and a document that has just been mirrored into the view (a mount, a note
 * switch, a reload) has not been measured yet: the map is then estimates, and a
 * wrapped paragraph's estimate is out by an order of magnitude — measured, a
 * restore landed at 3404px where the reader left 4793px. Reading the offset
 * inside a measure request makes it the layout's own answer: CodeMirror runs
 * that read after it has measured the document it is holding.
 *
 * The write is the pane's ordinary program write, so its echo is recognised
 * rather than reported as a scroll the user made (which would drag the other
 * pane with it in split mode).
 */
function setScrollTopForLine(line: number, token: number): void {
  const cm = host?.getView()
  if (!cm) return
  cm.requestMeasure({
    read: () => scrollTopForLine(line),
    write: (top: number) => setScrollTop(top, token),
  })
}

function scrollRange(): number {
  const el = host?.getView()?.scrollDOM
  if (!el) return 0
  return Math.max(0, el.scrollHeight - el.clientHeight - tailSpacePx.value)
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
 * The 1-based line at the top of the viewport, with how far into it the
 * viewport starts as a fraction — the document position this pane is showing,
 * in the only unit that means the same thing in the other pane.
 *
 * A mode switch has to name a position that survives the move: a pixel offset
 * is measured against this pane's layout and means nothing in a pane that lays
 * the same document out differently, while a source line is in the document's
 * own space. The fraction is what keeps a switch from jumping up to a whole
 * line — a wrapped paragraph occupies many pixel rows of one line, and rounding
 * there moves the user's place by however tall that line is.
 */
function getVisibleLine(): number {
  const cm = host?.getView()
  if (!cm) return 1
  // One pixel in, for the same reason as `getVisibleUnit`: CodeMirror resolves a
  // height landing exactly on a line's top to the line above it.
  const top = Math.max(0, cm.scrollDOM.scrollTop + 1)
  const block = cm.lineBlockAtHeight(top)
  if (!block) return 1
  const start = cm.state.doc.lineAt(block.from).number
  if (!(block.height > 0)) return start
  return start + Math.max(0, Math.min((top - block.top) / block.height, 1))
}

/** Put the caret at the start of `line` (1-based, floored) without moving the
 *  viewport: the pane a mode switch restores has its scroll written separately,
 *  and letting this one scroll too would fight it. */
function setCaretLine(line: number): void {
  const cm = host?.getView()
  if (!cm) return
  const doc = cm.state.doc
  const clamped = Math.max(1, Math.min(Math.floor(line), doc.lines))
  cm.dispatch({
    selection: { anchor: doc.line(clamped).from },
    scrollIntoView: false,
    // Placing the caret is not an edit: it must not become an undo step the
    // user has to press Ctrl+Z through.
    annotations: Transaction.addToHistory.of(false),
  })
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
  setScrollTopForLine,
  getScrollTop,
  getScrollRange,
  scrollTopForLine,
  focus,
  getText,
  getSourceView,
  getVisibleUnit,
  getVisibleLine,
  setCaretLine,
  setMeasureSuppressed,
})

onBeforeUnmount(() => {
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

<style scoped src="../features/editor/styles/sourcePane.css"></style>
