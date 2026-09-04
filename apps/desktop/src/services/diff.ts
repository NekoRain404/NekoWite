/** Row cap for the LCS diff. Diffing is O(n·m), so both inputs are sliced to
 * `DIFF_MAX_LINES` before any work runs — a pragmatic bound that keeps a doc
 * with tens of thousands of lines fast to compare.
 *
 * Callers that need a complete view for pathological inputs should show a
 * hint; the history UI truncates through this same constant. */
export const DIFF_MAX_LINES = 2000

export type DiffType = 'add' | 'del' | 'same'

export interface DiffLine {
  type: DiffType
  text: string
  /** 1-based line number in the old text; `null` for added lines. */
  oldLine: number | null
  /** 1-based line number in the new text; `null` for deleted lines. */
  newLine: number | null
}

export interface DiffStats {
  added: number
  removed: number
  unchanged: number
}

/** Split on newlines, dropping the empty tail produced by a trailing `\n` so a
 * mere newline change at EOF does not surface as a phantom empty-line diff. */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Line-level diff via classic LCS dynamic programming (O(n·m) time with the
 * rows capped by `DIFF_MAX_LINES`; O(m) extra state on top of the DP row we
 * keep). Returns left-to-right operations with 1-based source line numbers.
 *
 * Tie-breaking resolves equal LCS paths by preferring additions, which makes
 * a replaced line render as its removed line followed by its added line. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText).slice(0, DIFF_MAX_LINES)
  const b = splitLines(newText).slice(0, DIFF_MAX_LINES)
  const n = a.length
  const m = b.length
  const width = m + 1
  const dp = new Int32Array((n + 1) * width)

  for (let i = 1; i <= n; i += 1) {
    const row = i * width
    const prev = (i - 1) * width
    const ai = a[i - 1]
    for (let j = 1; j <= m; j += 1) {
      if (ai === b[j - 1]) {
        dp[row + j] = dp[prev + (j - 1)] + 1
      } else {
        const up = dp[prev + j]
        const left = dp[row + (j - 1)]
        dp[row + j] = up >= left ? up : left
      }
    }
  }

  const ops: DiffLine[] = []
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ type: 'same', text: a[i - 1], oldLine: i, newLine: j })
      i -= 1
      j -= 1
    } else if (dp[(i - 1) * width + j] > dp[i * width + (j - 1)]) {
      ops.push({ type: 'del', text: a[i - 1], oldLine: i, newLine: null })
      i -= 1
    } else {
      ops.push({ type: 'add', text: b[j - 1], oldLine: null, newLine: j })
      j -= 1
    }
  }
  while (i > 0) {
    ops.push({ type: 'del', text: a[i - 1], oldLine: i, newLine: null })
    i -= 1
  }
  while (j > 0) {
    ops.push({ type: 'add', text: b[j - 1], oldLine: null, newLine: j })
    j -= 1
  }
  ops.reverse()
  return ops
}

/** Count operations produced by `lineDiff`. */
export function diffStats(diff: DiffLine[]): DiffStats {
  let added = 0
  let removed = 0
  let unchanged = 0
  for (const line of diff) {
    if (line.type === 'add') added += 1
    else if (line.type === 'del') removed += 1
    else unchanged += 1
  }
  return { added, removed, unchanged }
}