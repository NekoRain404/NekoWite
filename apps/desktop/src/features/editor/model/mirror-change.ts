/**
 * The smallest edit that turns one text into another — the shape a pane mirrors
 * another writer's text with.
 *
 * Why not "replace the whole document": to CodeMirror a whole-document
 * replacement is not an edit, it is a different document. Its scroll anchor is a
 * *position* in the old text, and a position inside a replaced range maps to the
 * START of the replacement (assoc -1), so the view concludes that everything
 * above the viewport has vanished and puts the reader at the top. Measured in
 * the browser on a 9000px source pane, in split mode: a mirror collapsed the
 * pane from 4145px to 115px — and the split sync, which reads that scroll as one
 * the user made, then eased the rendered pane down to the same place. Both panes
 * jumped to the top while the user was typing in one of them.
 *
 * A minimal change maps every position through itself — the anchor included —
 * so the viewport does not move. Common prefix and suffix are trimmed; whatever
 * is left in the middle is replaced.
 *
 * The comparison is by UTF-16 code unit, which is what `String.prototype.slice`
 * and CodeMirror's `from`/`to` offsets both speak, so the result can be applied
 * to the document unchanged.
 */
export interface MirrorChange {
  /** Document offset the replacement starts at. */
  from: number
  /** Document offset it ends at (exclusive). */
  to: number
  /** Text that takes its place. */
  insert: string
}

/**
 * The change that turns `before` into `after`, or null when they are equal.
 *
 * Null is not "nothing to do" for the caller: an identical text still has to
 * reach the host that owns the pane's snapshot bookkeeping.
 */
export function mirrorChange(before: string, after: string): MirrorChange | null {
  if (before === after) return null

  const shorter = Math.min(before.length, after.length)
  let from = 0
  while (from < shorter && before.charCodeAt(from) === after.charCodeAt(from)) from += 1

  // The suffix is trimmed from the end of the strings independently: the two
  // remaining middles can be of different lengths (a replacement, not just an
  // insertion or a deletion), which is exactly what a naive index would break.
  let endBefore = before.length
  let endAfter = after.length
  while (
    endBefore > from &&
    endAfter > from &&
    before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)
  ) {
    endBefore -= 1
    endAfter -= 1
  }

  return { from, to: endBefore, insert: after.slice(from, endAfter) }
}
