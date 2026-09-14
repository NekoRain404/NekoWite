import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from 'vue'
import type { EditorView } from '@codemirror/view'
import { useViewStore } from '../../../stores/view'

/**
 * The source pane's slot: the half of the editor that pane takes over, the ref
 * the host hands to it, and how that half gets filled.
 *
 * The pane is loaded on demand — its CodeMirror graph would otherwise sit on the
 * first-load path — which makes it the one editor surface that can be *asked for
 * before it exists*. Two things follow from that, and both belong to the slot
 * rather than to the pane or to the component that hosts it:
 *
 * 1. The chunk is warmed in the first idle moment after mount. Until this
 *    existed, the only thing that ever fetched it was the first switch to
 *    Source, so that switch left the whole document region empty until the
 *    chunk arrived and then planted the text at the carried line — two jumps
 *    instead of one missing fade, once per run, which is why it read as a bug
 *    rather than as no animation. Warmed, the click finds the module resolved
 *    and the pane mounts in the flush of the mode change itself.
 * 2. While the half is on screen and still empty, `awaitingSource` says so, and
 *    the host holds the pane's place instead of leaving a hole in the layout.
 *
 * It is deliberately *not* done with a `loadingComponent` on the async
 * component: the async wrapper hands the template ref to whatever it renders, so
 * a loading component would occupy this ref while the chunk is in flight — and
 * the handoff, which reads the ref to decide whether the pane exists at all,
 * would plant the carried position into the loading state and lose it.
 *
 * The interface is restated structurally rather than imported from the
 * component, so what the host depends on is visible in one place and the pane
 * can be tested without a live CodeMirror.
 */
export type SourcePaneExpose = {
  /** Write a scroll offset from outside, tagged with the sync token that caused
   *  it, so the pane recognises its own echo instead of reporting it as a
   *  scroll the user made. */
  setScrollTop(top: number, token: number): void
  /**
   * Put 1-based `line` at the top of the viewport, measured rather than
   * estimated: the write waits for CodeMirror's measure cycle, because a pane
   * that has just been handed a document has no real line heights yet and an
   * estimate can be out by an order of magnitude.
   */
  setScrollTopForLine(line: number, token: number): void
  getScrollTop(): number
  /** The pane's scrollable extent, with the panel's trailing space excluded:
   *  the space is the panel's, not the document's, and the split sync maps
   *  through the document. */
  getScrollRange(): number
  /** The offset that puts 1-based `line` at the top of the viewport. */
  scrollTopForLine(line: number): number
  focus(): void
  getText(): string
  getSourceView(): EditorView | null
  /** The 1-based line of the first content line visible, i.e. the one occupying
   *  the viewport's first pixel, or null when there is no view. */
  getVisibleUnit(): number | null
  /** The 1-based (fractional) line at the top of the viewport: the document
   *  position this pane is showing, in the unit both panes share. */
  getVisibleLine(): number
  /** Put the caret on `line` (1-based, floored) without moving the viewport. */
  setCaretLine(line: number): void
  setMeasureSuppressed(suppressed: boolean): void
}

/** What an engine without idle callbacks waits before warming. A deferral, not a
 *  deadline: the whole point is to stay off the first-load path. */
const PREFETCH_FALLBACK_DELAY_MS = 1200

export interface SourcePaneSlot {
  /** The pane once it exists, or null while its chunk is still in flight. */
  sourcePane: Ref<SourcePaneExpose | null>
  /** True while the source half is on screen with nothing in it yet. */
  awaitingSource: ComputedRef<boolean>
}

export function useSourcePaneSlot(): SourcePaneSlot {
  const view = useViewStore()
  const sourcePane = ref<SourcePaneExpose | null>(null)

  let idle: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function warm(): void {
    idle = null
    timer = null
    void import('../../../view/SourcePane.vue')
  }

  onMounted(() => {
    if (typeof window.requestIdleCallback === 'function') {
      idle = window.requestIdleCallback(warm)
      return
    }
    timer = setTimeout(warm, PREFETCH_FALLBACK_DELAY_MS)
  })

  onBeforeUnmount(() => {
    if (idle !== null && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idle)
    }
    idle = null
    if (timer !== null) clearTimeout(timer)
    timer = null
  })

  return {
    sourcePane,
    // The rendered pane is the one that shows on open, so the slot is only empty
    // in the modes that put the source pane up.
    awaitingSource: computed(() => view.mode !== 'rendered' && sourcePane.value === null),
  }
}
