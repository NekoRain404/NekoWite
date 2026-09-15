/**
 * The pointer gesture behind the image's resize handle (and its bottom-right
 * corner): the moves preview on the element, and pointer-up lands the whole
 * drag as ONE `setNodeMarkup`, so one gesture is one undo step.
 *
 * The width the gesture starts from and the pair a Shift (aspect) lock holds to
 * both come from ./measure's `resizeBasis` — the same call ./keymap makes, so
 * one operation cannot form two ratios. And where there is no ratio to hold,
 * this gesture refuses exactly as the keymap refuses: it neither previews nor
 * commits. Both of its old stand-ins wrote a size belonging to no image —
 * `{1,1}` squared the picture when nothing was measurable, the 0.75 one wrote a
 * 4:3 — and the commit is where such a size reached the note.
 *
 * Declining the PREVIEW too is deliberate: the element is not the document, so
 * the refusal costs the reader a gesture that visibly does nothing, where
 * previewing it would leave a size on screen the note does not have. The
 * alternative reading (let it grow, commit nothing) ends with the element
 * showing a resize that was never written.
 *
 * The node view keeps what is its own: the element to preview on, the attrs to
 * read, and the re-render that puts a refused gesture back.
 */

import type { EditorView } from '@milkdown/prose/view'

import { nextWidth, proportionalSize } from './resize'
import { resizeBasis } from './measure'
import { advanceResizeDrag, beginResizeDrag, commitResizeDrag } from './drag'
import { commitImageResize } from './resize-commit'

/** What the gesture needs from the node view that owns the DOM. */
export interface ResizeDragHost {
  view: EditorView
  /** ProseMirror's position getter for the node, as the node view receives it. */
  getPos: () => number | undefined
  /** The node's attrs as they are NOW: a transaction between pointerdown and
   *  pointerup must not be overwritten with the size the drag started from. */
  attrs: () => Record<string, unknown>
  /** The node view's own `<img>` — the element holding the file's own pixels. */
  img: HTMLImageElement
  /** Put the element back to the node's own dims (the node view's `applyDims`),
   *  for a gesture that ends without a commit. */
  restore: () => void
}

/** Begin a resize drag at `event`; a non-primary button starts nothing. */
export function startResizeDrag(event: PointerEvent, host: ResizeDragHost): void {
  if (event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()
  const { view, getPos, attrs, img, restore } = host
  const { baseWidth, lock } = resizeBasis(attrs(), img)
  const startWidth = baseWidth ?? 1
  const startX = event.clientX
  let drag = beginResizeDrag(startWidth)
  let proportional = event.shiftKey

  const onMove = (ev: PointerEvent): void => {
    const pos = getPos()
    if (typeof pos !== 'number') return
    const target = nextWidth(startWidth, ev.clientX - startX)
    proportional = ev.shiftKey
    if (proportional) {
      // No ratio to hold: neither the element nor the recorder is touched, so a
      // gesture that cannot write a size cannot show one either.
      if (!lock) return
      const { width, height } = proportionalSize(lock.width, lock.height, target)
      drag = advanceResizeDrag(drag, pos, width)
      img.style.width = `${width}px`
      img.style.height = `${height}px`
    } else {
      drag = advanceResizeDrag(drag, pos, target)
      img.style.width = `${target}px`
      img.style.height = ''
    }
  }

  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    const commit = commitResizeDrag(drag)
    // A click that never moved commits nothing, and neither does a Shift
    // gesture that recorded no move: there is no size for it to write.
    if (!commit) return
    if (!proportional) {
      commitImageResize(view, commit.pos, { ...attrs(), width: commit.width, height: null })
      return
    }
    // Shift held at the last move with no ratio to hold — it can be pressed
    // mid-gesture, after moves that WERE previewed: the document keeps its
    // size, and the element goes back to the node's own dims so that preview
    // cannot outlive the gesture.
    if (!lock) {
      restore()
      return
    }
    const { height } = proportionalSize(lock.width, lock.height, commit.width)
    commitImageResize(view, commit.pos, { ...attrs(), width: commit.width, height })
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
