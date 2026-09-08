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
