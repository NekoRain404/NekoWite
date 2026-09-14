import type { OutlineItem } from './outline'

/** Number of lines, matching CodeMirror's doc.line count (a trailing line
 * break terminates the last line instead of opening an empty one). */
export function countDocumentLines(content: string): number {
  if (!content) return 1
  const lines = content.split(/\r\n|\n|\r/)
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

/** Proportional scroll ratio for a 1-based line among the whole document. */
export function lineRatio(line: number, totalLines: number): number {
  if (totalLines <= 1) return 0
  const clamped = Math.max(1, Math.min(line, totalLines))
  return (clamped - 1) / (totalLines - 1)
}

/** Index of the heading that anchors the block containing `targetLine` (1-based),
 * i.e. the closest heading at or above that line; null when there are no headings. */
export function anchorHeadingIndex(items: OutlineItem[], targetLine: number): number | null {
  if (items.length === 0) return null
  const target = Math.max(1, Math.floor(targetLine))
  let result = 0
  for (let i = 0; i < items.length; i++) {
    if (items[i].line + 1 > target) break
    result = i
  }
  return result
}

/** Index of the heading that anchors the block shown at a rendered scroll
 * position: the last heading whose top offset is at or above `scrollTop`.
 *
 * `headingTops` are the rendered headings' content-space top offsets, in
 * document order. Pass the parsed outline `items` alongside them when the caller
 * has them: offsets and outline come from two different sources (the DOM and the
 * parsed document), so if they disagree in length the two are out of step and
 * the mapping is refused rather than pointing at the wrong heading.
 *
 * Null means there are no headings to map (callers fall back to the ratio). A
 * position above the first heading clamps onto it, mirroring
 * `anchorHeadingIndex`'s clamp in the other direction. */
export function nearestHeadingIndex(
  headingTops: number[],
  scrollTop: number,
  items?: OutlineItem[],
): number | null {
  if (headingTops.length === 0) return null
  if (items && items.length !== headingTops.length) return null
  const top = Number.isFinite(scrollTop) ? scrollTop : 0
  let result = 0
  for (let i = 0; i < headingTops.length; i++) {
    if (headingTops[i] > top) break
    result = i
  }
  return result
}

/** 1-based source line of the heading at `headingIndex` — the reverse of
 * `anchorHeadingIndex`, for moving the source pane onto a rendered heading.
 * An out-of-range index clamps onto the first/last heading (a non-numeric index
 * reads as the first), and the result is never below line 1. Null means there
 * are no headings. */
export function headingSourceLine(items: OutlineItem[], headingIndex: number): number | null {
  if (items.length === 0) return null
  const raw = Number.isFinite(headingIndex) ? Math.floor(headingIndex) : 0
  const index = Math.max(0, Math.min(raw, items.length - 1))
  return Math.max(1, items[index].line + 1)
}

/** Clamp a 1-based line number into `[1, totalLines]`, floored to a line.
 * Degenerate documents (`totalLines <= 1`) keep line 1; a non-numeric line
 * reads as line 1. */
export function clampLine(line: number, totalLines: number): number {
  const last = Number.isFinite(totalLines) ? Math.max(1, Math.floor(totalLines)) : 1
  const value = Number.isFinite(line) ? Math.floor(line) : 1
  return Math.max(1, Math.min(value, last))
}

/** Clamp a scroll ratio into `[0, 1]`; a non-numeric ratio reads as 0. */
export function clampRatio(ratio: number): number {
  if (Number.isNaN(ratio)) return 0
  return Math.max(0, Math.min(ratio, 1))
}
