/**
 * The note's own blocks: the runs of source lines the renderer turns into one
 * top-level node, and the line↔block arithmetic over them.
 *
 * A caret crosses a mode switch as a source LINE and is re-planted by whichever
 * pane arrives. A document with headings does that through the line↔offset
 * mapping's anchors; one without them was left to the pane's scroll ratio, which
 * is a fraction of the SCROLLABLE extent — the one quantity a note shorter than
 * its pane does not have. `scrollHeight - clientHeight` is then ~0, so every
 * line maps to the top of the pane and the caret's own paragraph is discarded by
 * the very conversion meant to carry it.
 *
 * The document's own blocks are the instrument that does not depend on the pane:
 * a line names one of them, and the block names the model node that line belongs
 * to. The pairing is by INDEX — block k of the source with node k of the model —
 * and it is refused when the two counts disagree. That is the same refusal the
 * heading anchors make when the outline and the measured offsets are out of
 * step, and for the same reason: a line paired with the wrong paragraph puts the
 * caret where the user was not, which is worse than not knowing where it goes.
 *
 * One block is a run of lines the renderer takes as one node: blank lines
 * separate blocks, and a blank line inside a fence is the code's own text rather
 * than a separator. A construct the rule does not recognise (a loose list, a link
 * reference definition, an HTML comment) makes the two counts disagree, and the
 * caller falls back instead of pairing the wrong blocks.
 */

/** A run of source lines the renderer takes as one top-level node. 1-based and
 *  inclusive: the block is the lines `line`..`endLine`. */
export interface SourceBlock {
  line: number
  endLine: number
}

/**
 * A fence, read the way `parseOutline` reads one: three or more backticks or
 * tildes, an info string, and a closing run of the same character that is at
 * least as long and carries none.
 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/**
 * A leading frontmatter block, which the model is never given: the rendered pane
 * parses the document's BODY (`editor-core`'s `open()` reads
 * `readDocumentEnvelope(content).body`), so a frontmatter block has no node to
 * pair with and every block after it would be one out. The same fences the notes
 * feature's scanner and the envelope reader look for — a block the two disagree
 * about only makes the counts differ, which the caller answers by falling back.
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---((?:\r?\n)+|$)/

/** The 0-based index of the document's first body line: past a leading
 *  frontmatter block and the blank run that closes it. */
function bodyStartLine(content: string): number {
  const match = FRONTMATTER_RE.exec(content)
  if (!match) return 0
  return match[0].split(/\r\n|\n|\r/).length - 1
}

/**
 * The document's blocks, in order, numbered by the lines they occupy in the
 * WHOLE source — frontmatter included, because that is the line numbering the
 * source pane's caret and the outline both use.
 */
export function parseSourceBlocks(content: string): SourceBlock[] {
  const lines = content.split(/\r\n|\n|\r/)
  const blocks: SourceBlock[] = []
  let fence: { char: string; len: number } | null = null
  // The 0-based index the open block starts at, or -1 when none is open.
  let start = -1
  for (let i = bodyStartLine(content); i < lines.length; i += 1) {
    const text = lines[i]
    const inFence = fence !== null
    const match = FENCE_RE.exec(text)
    if (match) {
      const char = match[1][0]
      const len = match[1].length
      if (fence === null) fence = { char, len }
      else if (char === fence.char && len >= fence.len && match[2].trim() === '') fence = null
    }
    // A blank line inside a fence is the code's own text, not a separator.
    if (text.trim() === '' && !inFence && !match) {
      if (start >= 0) {
        blocks.push({ line: start + 1, endLine: i })
        start = -1
      }
      continue
    }
    if (start < 0) start = i
  }
  if (start >= 0) blocks.push({ line: start + 1, endLine: lines.length })
  return blocks
}

/**
 * The block a 1-based (possibly fractional) source line belongs to: the last
 * block that starts at or above it, which is how `anchorHeadingIndex` reads the
 * same question for headings. A line in the blank space below a block is that
 * block's — it is the nearest one a caret there can be said to be in — and a
 * line above the first block is the first block's, for the same reason.
 */
export function blockIndexForLine(blocks: SourceBlock[], line: number): number | null {
  if (blocks.length === 0) return null
  const target = Number.isFinite(line) ? Math.floor(line) : 1
  let result = 0
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i].line > target) break
    result = i
  }
  return result
}

/**
 * How far into a block's own text a 1-based source line sits: 0 at the block's
 * first line, 1 at its last. A one-line block answers 0 — a caret on its only
 * line is at the block's own start rather than at some fraction of itself.
 */
export function blockProgress(blocks: SourceBlock[], index: number, line: number): number {
  const block = blocks[index]
  if (!block) return 0
  const span = block.endLine - block.line
  if (span <= 0) return 0
  const offset = (Number.isFinite(line) ? line : block.line) - block.line
  return Math.max(0, Math.min(offset / span, 1))
}

/**
 * The 1-based source line a position `progress` (0..1) of the way through a
 * block sits on: the inverse of `blockProgress`, and fractional for the same
 * reason it is — the line a caret reports is the line it would be put back on.
 */
export function blockLineFor(
  blocks: SourceBlock[],
  index: number,
  progress: number,
): number | null {
  const block = blocks[index]
  if (!block) return null
  const amount = Number.isFinite(progress) ? Math.max(0, Math.min(progress, 1)) : 0
  return block.line + amount * (block.endLine - block.line)
}
