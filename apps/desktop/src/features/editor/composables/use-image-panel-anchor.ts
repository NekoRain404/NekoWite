import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { NekoEditor } from '@nekowite/editor-core'
import { placeImagePanel } from '../model/image-panel-placement'
import type { Rect } from '../model/table-toolbar-placement'

type EditorView = NonNullable<ReturnType<NekoEditor['getView']>>

/**
 * Where the image property panel sits, frame by frame.
 *
 * The same contract the table toolbar's composable holds, for a different
 * anchor: on scroll, resize and image change **only the coordinates move**.
 * Nothing here re-parses the document or touches the editor's state for
 * positioning, and the follow is not eased — a panel that chased the image
 * would read as lag on the thing the pointer is dragging.
 *
 * The anchor is the NODE VIEW'S OWN ELEMENT, asked for by document position on
 * every frame rather than held: a re-parse can rebuild that DOM, and the
 * selection is what says which image this is. The panel's own size is measured
 * from the element, because it is placed from its own box (a column of fields,
 * not a strip of buttons) and that box is only known after a first paint.
 */
export interface ImagePanelAnchorOptions {
  /** The live editor, or null before the rendered pane has one. */
  getEditor: () => NekoEditor | null
  /** The selected image's document position, or null when nothing is selected.
   *  A change to it re-points the anchor: the panel's subject is the selection. */
  pos: Ref<number | null>
  /** The pane the panel may never leave. Defaults to the rendered pane's own
   *  scroll container, found from the editor's DOM. */
  getPanelEl?: () => HTMLElement | null
}

export interface ImagePanelAnchor {
  /** Its viewport position; only these change as the pane scrolls. */
  top: Ref<number>
  left: Ref<number>
  /** Measure the panel element once it is on screen (it is placed from its own
   *  size, which is only known after a first paint). */
  measure: (el: HTMLElement | null) => void
}

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
}

export function useImagePanelAnchor(options: ImagePanelAnchorOptions): ImagePanelAnchor {
  const top = ref(0)
  const left = ref(0)
  const size = { width: 0, height: 0 }
  let frame = 0
  let observer: ResizeObserver | null = null
  let scrolled: HTMLElement | null = null
  let root: HTMLElement | null = null

  function view(): EditorView | null {
    try {
      return options.getEditor()?.getView() ?? null
    } catch {
      return null
    }
  }

  /** The pane: the rendered pane's scroll container, which is what the panel may
   *  never leave and what its scroll events come from. */
  function panelEl(): HTMLElement | null {
    const explicit = options.getPanelEl?.()
    if (explicit) return explicit
    const dom = view()?.dom ?? null
    return (dom?.closest('.rendered-pane') as HTMLElement | null) ?? null
  }

  /** The image itself: the node view's `figure`, which is inline-sized, so its
   *  rect is the picture's and not the line it sits on. */
  function imageEl(): HTMLElement | null {
    const v = view()
    const pos = options.pos.value
    if (!v || pos === null) return null
    try {
      const dom = v.nodeDOM(pos)
      return dom instanceof HTMLElement ? dom : null
    } catch {
      // A position that no longer resolves to a node (an undo, another window's
      // write) is not an anchor; the frame is dropped and the next one re-reads.
      return null
    }
  }

  /** The pane's rect — or the window's when the editor is mounted without one
   *  (the panel's own test mounts it bare). Clamping to the window is still the
   *  promise that matters, and it is the only container left to clamp to. */
  function container(): Rect {
    const pane = panelEl()
    if (pane) return rectOf(pane)
    const { innerWidth: width, innerHeight: height } = window
    return { top: 0, left: 0, right: width, bottom: height, width, height }
  }

  /** One frame of positioning: coordinates only (see the module header). */
  function place(): void {
    const image = imageEl()
    if (!image) return
    const next = placeImagePanel({ image: rectOf(image), panel: container(), size })
    top.value = next.top
    left.value = next.left
  }

  function schedule(): void {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      place()
    })
  }

  /**
   * Re-point the three boxes whose changes can move the panel: the pane (its
   * scroll and its size), the image (an edit or a live resize-drag changes its
   * box) and the panel itself (a field appearing changes how much room it
   * needs, and therefore what "as close as fits" means).
   */
  function wire(): void {
    const panel = panelEl()
    if (typeof ResizeObserver !== 'undefined') {
      observer?.disconnect()
      observer = new ResizeObserver(() => schedule())
      for (const el of [panel, imageEl(), root]) if (el) observer.observe(el)
    }
    if (scrolled !== panel) {
      scrolled?.removeEventListener('scroll', schedule)
      panel?.addEventListener('scroll', schedule, { passive: true })
      scrolled = panel
    }
  }

  function measure(el: HTMLElement | null): void {
    if (!el) return
    root = el
    const rect = el.getBoundingClientRect()
    size.width = rect.width
    size.height = rect.height
    // Wiring here and not only on the selection change: the watch below runs
    // before the panel has been rendered (its v-if follows the same selection in
    // the same flush), so this is the first moment the panel is a measurable box.
    wire()
    place()
  }

  watch(options.pos, () => {
    wire()
    place()
    // Again on the next frame: the selection can arrive a tick before the node
    // view's element has its final box, and a placement that found nothing must
    // not be the last word — the signal will not fire again while it stays put.
    schedule()
  })

  onBeforeUnmount(() => {
    scrolled?.removeEventListener('scroll', schedule)
    scrolled = null
    observer?.disconnect()
    observer = null
    if (frame) cancelAnimationFrame(frame)
    frame = 0
  })

  return { top, left, measure }
}
