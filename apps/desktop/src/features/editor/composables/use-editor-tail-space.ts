import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

/**
 * Trailing space at the end of a pane's scrolling content, so the last line can
 * be scrolled up to a comfortable place instead of being pinned to the bottom
 * edge of the panel.
 *
 * Three things this space must never be:
 *
 * - **not the document.** The space is padding on the pane's own content BOX
 *   (the element the scroller measures), not a paragraph, newline or blank
 *   node — so nothing about it can be saved, exported, counted or serialized.
 *   A blank paragraph would be document content and would reach the file.
 * - **not `padding-bottom: 80%`.** A percentage padding resolves against the
 *   element's WIDTH, which has nothing to do with the requirement: this is the
 *   panel's own visible HEIGHT times {@link TAIL_SPACE_RATIO}, read from the
 *   scroll container and kept current by a `ResizeObserver`.
 * - **not part of the document's scroll extent.** Each pane reports its scroll
 *   RANGE to the split sync, and that range has to be the content's: the panes
 *   lay the same note out at different heights, and folding a panel-sized pad
 *   into both ranges is what would misalign them (the mapping's ratio fallbacks
 *   are computed against exactly that number). Each pane subtracts the pad from
 *   the range it answers with "how tall is the document".
 *
 * A `ResizeObserver` on the scroll container rather than a window listener: the
 * panel changes height when a toolbar, a split drag or a panel toggle changes
 * its box, and none of those are window events.
 */
export const TAIL_SPACE_RATIO = 0.8

export interface EditorTailSpaceOptions {
  /** The pane's scroll container: what is measured, and never padded itself. */
  getScrollEl: () => HTMLElement | null
  /** Apply the measured height to the pane's own content box. Called with 0 on
   *  teardown so a recycled element cannot keep a stale pad. */
  apply: (px: number) => void
}

export interface EditorTailSpace {
  /** The pad currently applied, in px — what the pane subtracts from the scroll
   *  range it reports to the split sync. */
  tailSpacePx: Ref<number>
  /**
   * Start measuring. Called on mount and whenever a bound scroll element
   * appears; a pane whose scroller is created imperatively (CodeMirror's, inside
   * an async chunk) has nothing reactive to watch, so it calls this itself once
   * the view exists.
   */
  attach: () => void
}

export function useEditorTailSpace(options: EditorTailSpaceOptions): EditorTailSpace {
  const tailSpacePx = ref(0)
  let observer: ResizeObserver | null = null

  function measure(): void {
    const el = options.getScrollEl()
    if (!el) return
    const next = Math.round(el.clientHeight * TAIL_SPACE_RATIO)
    if (next === tailSpacePx.value) return
    tailSpacePx.value = next
  }

  function attach(): void {
    const el = options.getScrollEl()
    if (!el || typeof ResizeObserver === 'undefined') return
    observer?.disconnect()
    observer = new ResizeObserver(() => measure())
    observer.observe(el)
    measure()
  }

  onMounted(attach)
  // The scroll container is behind a `v-show` and, for the source pane, inside
  // an async chunk: the element can appear after this composable's mount.
  watch(() => options.getScrollEl(), attach)

  // Applied in a watcher rather than inside `measure` so the pad is written by
  // exactly one place, and only when the number actually changed.
  watch(tailSpacePx, (px) => options.apply(px), { immediate: true })

  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
    options.apply(0)
  })

  return { tailSpacePx, attach }
}
