/**
 * The work `open()` is allowed to START, and what it refuses to start.
 *
 * A load parses the whole body synchronously on the UI thread, and the cost of
 * that parse is not this package's to bound. Task-53 measured it (CPU time,
 * happy-dom, this machine): ~2.3 s for a 207 KB document of paragraphs, 19 s
 * for a 362 KB document of nested list items, 91 s for a 1 MB one — the window
 * frozen for the whole of it, because the time is inside remark-parse's
 * container scanning and inside @milkdown/transformer's serializer, neither of
 * which this repository owns. `open()` cannot make that parse cheaper. It can
 * decline to begin one it knows will not finish while the user is still
 * watching.
 *
 * So the answer for a document the rendered view cannot take is a refusal that
 * arrives BEFORE any work, carrying the reason and the one instruction that
 * helps. What it replaces was not an error message but the absence of one: a
 * minute of a frozen window ending in `RangeError: Maximum call stack size
 * exceeded`, which no user can act on.
 *
 * The refusal is still a FAILED LOAD in every way that matters — `open()`
 * rejects, the editor holds no document, and a save cannot write one out of the
 * model (see held-document.ts). The file itself is untouched, and the source
 * pane opens it instantly, which is what "switch to source" points at.
 *
 * Both limits are measured, not guessed (task-53 report has the table):
 *
 *   - `MAX_RENDERABLE_CHARACTERS` sits between the largest document that opens
 *     in a time a user will wait out and the smallest one that freezes: every
 *     shape measured under ~4 s CPU (207 KB of paragraphs, 91 KB of nested
 *     lists) still opens, and the 362 KB shape that cost 19 s does not. A
 *     quarter of a megabyte is also far above any hand-written note — a 256 KB
 *     Markdown file is roughly 40 000 words.
 *   - `MAX_CONTAINER_WEIGHT` is how deep the source declares its containers.
 *     Blockquote nesting is what overflows the stack (1500 levels is a
 *     `RangeError`, and a 20 KB file of 20000 levels pays 2 s of parsing before
 *     micromark throws), and list indentation is what remark-parse re-scans on
 *     every line (300 levels costs 3.7 s, 600 costs 19 s). The cap falls
 *     between "opens today" (1000 levels, 0.5 s) and "cannot parse at all"
 *     (1500, RangeError), so it refuses nothing that opens today.
 */

/** The most a rendered view will be asked to parse, in UTF-16 code units. */
export const MAX_RENDERABLE_CHARACTERS = 262_144

/**
 * The deepest container nesting a rendered view will be asked to parse.
 *
 * Indentation counts as one per column, a blockquote marker as two (see
 * `containerWeight`), so this is 1024 blockquote levels or 2048 columns of
 * list indentation — and any mixture of the two.
 */
export const MAX_CONTAINER_WEIGHT = 2_048

/** Columns a tab advances by; the width the pane's stylesheet gives it. */
const TAB_COLUMNS = 4

const SPACE = 32
const TAB = 9
const GREATER_THAN = 62

/**
 * `open()` refused a document before parsing it, because the rendered view
 * cannot open it in a time a user would sit through.
 *
 * A distinct type rather than the parser's own error: the file is FINE — it is
 * the rendered view that cannot take it — and the caller has a better answer
 * than "check the document format" ("switch to source"). The message says which
 * of the two limits was passed.
 */
export class DocumentTooComplexToRenderError extends Error {
  constructor(reason: string) {
    super(`[NekoEditor] this note is ${reason} to open in the rendered view; switch to source`)
    this.name = 'DocumentTooComplexToRenderError'
  }
}

/**
 * The deepest container nesting the source declares, as a per-line weight.
 *
 * A line's weight is its leading indentation in columns — a tab counting as
 * `TAB_COLUMNS`, since what makes indentation expensive is the container
 * tracking it implies, not the bytes — plus two per leading blockquote marker,
 * so that a level of `>` weighs what a nested list level costs. Only the run at
 * the START of a line is counted: that is the only place a container can open.
 *
 * It is an upper bound on the work a line implies, not a model of it: a line of
 * `>` inside a fenced code block is counted although no container opens there.
 * That direction is the safe one — an over-estimate only refuses a document the
 * user can still read in the source pane, while an under-estimate is the freeze
 * this module exists to prevent.
 */
export function containerWeight(content: string): number {
  let max = 0
  const length = content.length
  let lineStart = 0
  while (lineStart < length) {
    const lineEnd = content.indexOf('\n', lineStart)
    const end = lineEnd === -1 ? length : lineEnd
    const weight = lineWeight(content, lineStart, end)
    if (weight > max) max = weight
    lineStart = end + 1
  }
  return max
}

/** The weight of the line `content.slice(start, end)` (see `containerWeight`). */
function lineWeight(content: string, start: number, end: number): number {
  let columns = 0
  let quotes = 0
  let at = start
  for (;;) {
    const before = at
    let spaces = 0
    while (at < end) {
      const code = content.charCodeAt(at)
      if (code === SPACE) spaces += 1
      else if (code === TAB) spaces += TAB_COLUMNS
      else break
      at += 1
    }
    if (at >= end || content.charCodeAt(at) !== GREATER_THAN) {
      // Whitespace with no marker behind it is the content's own indentation —
      // an indented code block, a list's continuation line — and counts only
      // when it is the whole of the line's leading run.
      if (before === start) columns += spaces
      break
    }
    columns += spaces
    quotes += 1
    at += 1
  }
  return columns + quotes * 2
}

/**
 * Refuse a document the rendered view cannot open, before anything touches it.
 *
 * The size check runs first and is O(1): a document large enough to be refused
 * for its size must not pay for a scan either.
 */
export function assertRenderable(content: string): void {
  if (content.length > MAX_RENDERABLE_CHARACTERS) {
    throw new DocumentTooComplexToRenderError(
      `too large (${content.length} characters; the rendered view opens up to ${MAX_RENDERABLE_CHARACTERS})`,
    )
  }
  const weight = containerWeight(content)
  if (weight > MAX_CONTAINER_WEIGHT) {
    throw new DocumentTooComplexToRenderError(
      `nested too deeply (weight ${weight}; the rendered view opens up to ${MAX_CONTAINER_WEIGHT})`,
    )
  }
}
