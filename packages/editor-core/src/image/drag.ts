/**
 * Coalescing recorder for an image resize drag.
 *
 * A user's drag fires many `pointermove` events; committing every one to
 * ProseMirror's history would produce one undo step per pixel, so undoing a
 * resize is impossible to do in one gesture. A drag is a single atomic action,
 * so the node view buffers each move here and emits exactly ONE transaction
 * when the pointer lifts. That keeps a whole resize drag as one undo step.
 *
 * This is a pure value-recorder: it holds no reference to a ProseMirror view
 * or DOM, so the coalescing contract (N moves -> 1 commit) is unit-testable in
 * isolation.
 */

export interface ResizeDragState {
  /** Width the image had when the drag started. */
  startWidth: number
  /** ProseMirror position of the image node at the last recorded move. */
  lastPos: number
  /** Width the image should settle at (the last recorded move's target). */
  lastWidth: number
  /** True once any move was recorded — a click without a drag commits nothing. */
  moved: boolean
}

export interface ResizeDragCommit {
  pos: number
  width: number
}

/** Begin a drag, remembering the image's starting width. */
export function beginResizeDrag(startWidth: number): ResizeDragState {
  return { startWidth, lastPos: -1, lastWidth: startWidth, moved: false }
}

/** Record a single pointermove during the drag. The live DOM width is applied
 * by the caller; only the target is buffered so the drag ends in one commit. */
export function advanceResizeDrag(
  state: ResizeDragState,
  pos: number,
  width: number,
): ResizeDragState {
  return { ...state, lastPos: pos, lastWidth: width, moved: true }
}

/** The single commit for the drag, or null when the image was never moved. */
export function commitResizeDrag(state: ResizeDragState): ResizeDragCommit | null {
  if (!state.moved || state.lastPos < 0) return null
  return { pos: state.lastPos, width: state.lastWidth }
}
