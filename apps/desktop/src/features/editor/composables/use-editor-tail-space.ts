import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

/**
 * Trailing space at the end of the editor panel, so the last line can be
 * scrolled up to a comfortable place instead of being pinned to the bottom edge
 * of the pane.
 *
 * Three things this space must never be:
 *
 * - **not the document.** The space is padding on the pane's own content BOX
 *   (the element the scroller measures), not a paragraph, newline or blank
 *   node — so nothing about it can be saved, exported, counted or serialized.
 *   A blank paragraph would be document content and would reach the file.
 * - **not `padding-bottom: 80%`.** A percentage padding resolves against the
 *   element's WIDTH, which has nothing to do with the requirement: this is the
 *   PANEL's own visible HEIGHT times {@link TAIL_SPACE_RATIO}, measured once on
 *   the panel every pane in it fills and kept current by a `ResizeObserver`.
 * - **not per pane.** One number is measured and handed to all of them (see
 *   below), because the panes are the same height and the number is the same
 *   requirement: a pad that differs between the panes is a pad the panes
 *   disagree about, which is what a reader sees as one pane having the space
 *   and its neighbour not.
 *
 * **Measured on the panel, not on a pane's scroller.** The panel is the box the
 * panes are laid out in; a scroller is not, and each one measures a different
 * thing: the rendered pane's scroller IS the pane, while the source pane's is
 * CodeMirror's `.cm-scroller`, which loses a horizontal scrollbar's height the
 * moment a line is longer than the pane — the normal case with soft wrap off,
 * which is what that pane is for. Measured per scroller, the source pane's tail
 * came out a scrollbar short of the rendered pane's (`312` against `320` in
 * `EditorPane.tail-space.test.ts`), and the two panes showed a different amount
 * of space below the same last line. Measuring the panel also settles the
 * timing half of the same problem: a pane measured its own scroller once, at
 * its own mount, which for a pane that mounts hidden is a measurement of
 * nothing at all — the panel is measured when it has a box, and the panes take
 * the number whenever it changes.
 *
 * A `ResizeObserver` on the panel rather than a window listener: the panel
 * changes height when a toolbar, a split drag or a panel toggle changes its
 * box, and none of those are window events.
 */
export const TAIL_SPACE_RATIO = 0.8

export interface EditorTailSpaceOptions {
  /** The panel every pane is laid out in: what is measured, and never padded
   *  itself. It is also where the panes' shared height lives — one measurement
   *  here is the same number for all of them. */
  getPanelEl: () => HTMLElement | null
}

export interface EditorTailSpace {
  /** The pad the panes are to apply, in px. Whoever owns the panels applies it
   *  to the box that needs it; this composable never touches a pane's DOM. */
  tailSpacePx: Ref<number>
}

export function useEditorTailSpace(options: EditorTailSpaceOptions): EditorTailSpace {
  const tailSpacePx = ref(0)
  let observer: ResizeObserver | null = null

  function measure(): void {
    const el = options.getPanelEl()
    if (!el) return
    const next = Math.round(el.clientHeight * TAIL_SPACE_RATIO)
    if (next === tailSpacePx.value) return
    tailSpacePx.value = next
  }

  function attach(): void {
    const el = options.getPanelEl()
    if (!el || typeof ResizeObserver === 'undefined') return
    observer?.disconnect()
    observer = new ResizeObserver(() => measure())
    observer.observe(el)
    measure()
  }

  onMounted(attach)
  // The panel is a template ref of the component that owns it, so this is the
  // mount and a teardown; it is watched rather than assumed because the panel
  // is inside the pane host's `v-if`, which a document closing and reopening
  // takes away and puts back.
  watch(() => options.getPanelEl(), attach)

  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
  })

  return { tailSpacePx }
}

/**
 * Put the panel's trailing space on one pane's own box, where that pane's
 * stylesheet reads it (`--nkw-tail-space`, in `sourcePane.css` and
 * `renderedPane.css`).
 *
 * Written on mount as well as on change, and that is the whole reason this is a
 * function rather than a `watch` at each call site: a pane mounts long after
 * the panel has been measured, so the first value it ever sees is usually the
 * real one and a watcher alone never fires for it. The pad would then stay at
 * the CSS fallback's `0px` — silently, which is how every failure this space
 * has had stayed invisible.
 */
export function useTailSpaceApplication(
  getEl: () => HTMLElement | null,
  getTailSpacePx: () => number,
): void {
  function apply(px: number): void {
    getEl()?.style.setProperty('--nkw-tail-space', `${px}px`)
  }

  watch(getTailSpacePx, apply)
  onMounted(() => apply(getTailSpacePx()))
}
