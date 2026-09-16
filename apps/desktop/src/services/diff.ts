/** Row cap for the LCS diff. Diffing is O(n·m), so both inputs are sliced to
 * `DIFF_MAX_LINES` before any work runs — a pragmatic bound that keeps a doc
 * with tens of thousands of lines fast to compare.
 *
 * The cap bounds the ROWS and nothing else: `compareDocuments` answers identity
 * over the whole texts, and reports `truncated` so a caller can say the rows are
 * a prefix instead of letting a bounded row set answer an unbounded question.
 * The history UI shows that hint through this same constant. */
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

/** Everything a comparison panel needs from one pair of texts. */
export interface DiffComparison {
  /** Row-by-row operations, covering at most `DIFF_MAX_LINES` lines a side. */
  ops: DiffLine[]
  stats: DiffStats
  /** Whether the two texts are the same document — a whole-text answer. */
  identical: boolean
  /** True when a side ran past `DIFF_MAX_LINES`, so `ops` is only a prefix of
   *  the real diff and a caller that draws them must say so. */
  truncated: boolean
}

/** Split on newlines, dropping the empty tail produced by a trailing `\n` so a
 * mere newline change at EOF does not surface as a phantom empty-line diff. */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Whole-document equality over the line sequences `splitLines` produces.
 *
 * Line sequences rather than the raw strings, so this and `lcsOps` agree on what
 * a difference is: the EOF newline above is not one, and a panel that called such
 * a pair different while drawing no differing row would be making a claim its own
 * rows contradict. O(n), and it exits at the first line that differs. */
function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Line-level diff via classic LCS dynamic programming (O(n·m) time; O(m) extra
 * state on top of the DP row we keep). Returns left-to-right operations with
 * 1-based source line numbers.
 *
 * Tie-breaking resolves equal LCS paths by preferring additions, which makes
 * a replaced line render as its removed line followed by its added line. */
function lcsOps(a: string[], b: string[]): DiffLine[] {
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

/** The rows for two documents, capped at `DIFF_MAX_LINES` a side. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText).slice(0, DIFF_MAX_LINES)
  const b = splitLines(newText).slice(0, DIFF_MAX_LINES)
  return lcsOps(a, b)
}

/** Diff two documents and answer both questions about them: the rows, which are
 * bounded, and whether they are the same document, which is not.
 *
 * Two instruments on purpose. "Are these the same?" is asked about the whole
 * text — the cheapest check there is, and what the claim means — so a version
 * whose only change sits past the row cap is still reported as different;
 * `DIFF_MAX_LINES` keeps a pathological diff from running its DP, and nothing
 * else. Reading identity off the rows is what made a long note's tail invisible:
 * both prefixes were equal, so `added === 0 && removed === 0` said "identical"
 * about a document that had changed. */
export function compareDocuments(oldText: string, newText: string): DiffComparison {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  const ops = lcsOps(oldLines.slice(0, DIFF_MAX_LINES), newLines.slice(0, DIFF_MAX_LINES))
  return {
    ops,
    stats: diffStats(ops),
    identical: sameLines(oldLines, newLines),
    truncated: oldLines.length > DIFF_MAX_LINES || newLines.length > DIFF_MAX_LINES,
  }
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