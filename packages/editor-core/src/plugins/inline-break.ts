/**
 * The author's inline `<br>`, hidden from the parser and put back afterwards.
 *
 * @milkdown/preset-commonmark ships `remarkPreserveEmptyLine`, whose transformer
 * DELETES every mdast `html` node whose value is one of the `<br>` spellings. That
 * rule exists for the empty-paragraph marker the serializer writes, but it also
 * matched the author's own break: `line1<br />line2` re-opened as `line1line2`
 * (the two text runs merged, because the only node between them had been spliced
 * out) and the next save wrote that over the file, so the break was lost
 * permanently. Inside a GFM cell the same thing happened, and there the author has
 * no other way to write a line break at all.
 *
 * The preset's transformer is not exported, takes no options, and unified only
 * APPENDS transformers, so it always runs before one this package could add. Its
 * input is changed instead: an inline marker is rewritten to a sentinel (no `html`
 * node is produced, so nothing deletes it) and turned back into an `html` node
 * after the transformers ran. A marker standing alone on its line is left alone
 * and keeps the preset's behavior.
 *
 * Two rules make the masking safe, and both are the reason this module exists as
 * its own unit:
 *
 *   1. ONLY a `text` node, or the boundary between two of them, can be repaired
 *      into `text`/`html` siblings. Every other node that carries the sentinel in
 *      its `value` (a fence, a code span, a formula, an MDX component's source)
 *      holds ONE token, so the marker goes back inside that same node as literal
 *      text. Splitting those was how a fenced block holding `<br />` became three
 *      top-level nodes and made `open()` throw, and how a code span and a formula
 *      came apart in two.
 *   2. NOTHING may leave with a sentinel in it. `restoreInlineBreaks` walks every
 *      string field of the finished tree — not only the `value` of a node — because
 *      the marker also lands in fields the tree-walk never inspected (an image's
 *      `alt`, a link's `title`), and those wrote the private-use characters
 *      straight into the user's file.
 *
 * The file this module produced is byte-identical to what the author wrote for
 * every case: the sentinel is a parse-time device and is never written out.
 */
/**
 * Delimiters for the sentinel an inline marker is swapped for while parsing.
 *
 * They have to be characters a note cannot reasonably contain AND characters
 * `String.prototype.trim()` keeps: the preset’s predicate compares
 * `node.value?.trim()`, so a whitespace-like delimiter (a control character, for
 * instance) would be trimmed away and the value would match the marker again.
 * Unicode’s Private Use Area is neither whitespace nor markdown syntax.
 */
const SENTINEL_OPEN = ''
const SENTINEL_CLOSE = ''

/**
 * The spellings milkdown (and the export) treat as an empty-paragraph marker.
 *
 * These are exactly the four `visitEmptyLine` in @milkdown/preset-commonmark
 * compares against, so the masker and the preset agree on what is a marker. A
 * spelling that is not here (an uppercase `<BR/>`, a double space) is left for the
 * parser to read as ordinary inline HTML — see `isInlineBreakValue`.
 */
const BR_MARKERS = ['<br />', '<br>', '<br/>', '<br >'] as const

/** Node types whose text is one token: their `value` is never split. */
const CODE_NODES = new Set(['code', 'inlineCode', 'code_block'])

/** What the model uses for a line break the author wrote as a tag. */
const INLINE_BREAK = '<br />'

/**
 * A `<br>` a browser would render as a line break, in any spelling.
 *
 * This is deliberately NOT `BR_MARKERS`: the model must also recognise the
 * spellings the preset's marker list does not carry (`<BR/>`, `<br  />`), because
 * those reached the model as `html` atoms too and were shown to the reader as the
 * literal text of the tag. Anything with attributes (`<br clear="all">`) is not
 * this: only the plain break tag.
 */
const INLINE_BREAK_RE = /^<br\s*\/?\s*>$/i

export interface MdastLike {
  type?: string
  value?: unknown
  children?: MdastLike[]
  /** Link/image reference label, already normalised by the parser. */
  identifier?: unknown
  /** Link reference definition fields, for the position-less fallback. */
  url?: unknown
  title?: unknown
  label?: unknown
  position?: { start?: { offset?: number }; end?: { offset?: number } }
}

/** True when a node's value is a `<br>` this package renders as a line break. */
export function isInlineBreakValue(value: string): boolean {
  return INLINE_BREAK_RE.test(value.trim())
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function markerPattern(): RegExp {
  return new RegExp(BR_MARKERS.map(escapeRe).join('|'), 'g')
}

/**
 * True when the marker is the only thing on its line.
 *
 * A marker on its own line is an HTML BLOCK: that is the shape the serializer
 * writes for an empty paragraph, so the parser has to fold it away. A marker next
 * to text is an inline HTML node: the author’s line break, which has to survive
 * (and in a GFM cell is the only way to write one).
 */
function isStandaloneLine(markdown: string, index: number, length: number): boolean {
  const lineStart = markdown.lastIndexOf('\n', index - 1) + 1
  let lineEnd = markdown.indexOf('\n', index)
  if (lineEnd === -1) lineEnd = markdown.length
  const before = markdown.slice(lineStart, index).trim()
  const after = markdown.slice(index + length, lineEnd).trim()
  return before === '' && after === ''
}

/**
 * True when the `<` at `index` is escaped, by Markdown's own rule: an odd run of
 * backslashes in front of it makes the character literal.
 *
 * The masker matches the source with a regex and cannot see that, so it also
 * matched the escape the SERIALIZER writes to protect a literal `<` — `\<br/>`.
 * Masking it undid the escape: the backslash stopped escaping anything, the tag
 * became a live marker again, and because the writer re-escapes what the model
 * holds, an image alt gained two backslashes on every open-and-save cycle.
 * In prose the same mis-read turned an escaped literal tag into a real line
 * break. An escaped `<` is text, so there is no marker here to mask.
 */
function isEscaped(markdown: string, index: number): boolean {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && markdown[i] === '\\'; i--) backslashes += 1
  return backslashes % 2 === 1
}

/** Hide the inline markers before the parser sees them (see the module comment). */
export function maskInlineBreaks(markdown: string): string {
  const pattern = markerPattern()
  let masked = ''
  let cursor = 0
  for (const match of markdown.matchAll(pattern)) {
    const index = match.index ?? 0
    const token = match[0]
    masked += markdown.slice(cursor, index)
    masked +=
      isEscaped(markdown, index) || isStandaloneLine(markdown, index, token.length)
        ? token
        : `${SENTINEL_OPEN}${token}${SENTINEL_CLOSE}`
    cursor = index + token.length
  }
  return masked + markdown.slice(cursor)
}

/**
 * Put the hidden markers back into a slice of masked source.
 *
 * A raw run is carried as its own source text, so a marker the masker hid
 * inside one has to be restored — the sentinel pair is a parse-time device and
 * would otherwise be written into the user’s file.
 */
export function unmaskInlineBreaks(text: string): string {
  return hasSentinel(text)
    ? text.split(SENTINEL_OPEN).join('').split(SENTINEL_CLOSE).join('')
    : text
}

function hasSentinel(text: string): boolean {
  return text.includes(SENTINEL_OPEN) || text.includes(SENTINEL_CLOSE)
}

type Piece = string | { html: string }

function splitSentinel(value: string): Piece[] {
  const pieces: Piece[] = []
  const pattern = new RegExp(`${SENTINEL_OPEN}([\\s\\S]*?)${SENTINEL_CLOSE}`, 'g')
  let cursor = 0
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0
    const lead = value.slice(cursor, index)
    if (lead !== '') pieces.push(lead)
    pieces.push({ html: match[1] })
    cursor = index + match[0].length
  }
  const tail = value.slice(cursor)
  if (tail !== '') pieces.push(tail)
  return pieces
}

/**
 * Turn the sentinels back into `html` nodes, or into the text that holds them.
 *
 * Two shapes have to be handled. Normally the masked marker comes back as one text
 * node (`line1<sentinel><br /><sentinel>line2`) and is split into text/html/text. A
 * marker the parser broke out of its run — the `html` node it produced is removed
 * while the surrounding text stays — leaves the open sentinel at the end of one
 * node and the close sentinel at the start of the next, so that pair is joined and
 * replaced by the `html` node alone. Inside code the marker is put back as the
 * literal source text: the preset never touched code content, so code must stay
 * byte-identical. Empty `text` pieces are dropped, because milkdown’s parser
 * rejects an empty text node.
 *
 * Every other node that carries the sentinel keeps its own text (module rule 1),
 * and whatever the walk could not reach is cleaned afterwards (rule 2).
 */
export function restoreInlineBreaks(tree: MdastLike): void {
  restoreNodes(tree)
  unmaskRemaining(tree)
}

function restoreNodes(tree: MdastLike): void {
  const children = tree.children
  if (!children) return
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (Array.isArray(child.children)) {
      restoreNodes(child)
      continue
    }
    if (typeof child.value !== 'string') continue
    if (typeof child.type === 'string' && CODE_NODES.has(child.type)) {
      // The marker goes back INSIDE the code: the tokenizer never reinterpreted
      // this text, so nothing here is markdown and the bytes must not move.
      child.value = unmaskInlineBreaks(child.value)
      continue
    }
    if (child.value.endsWith(SENTINEL_OPEN) && i + 1 < children.length) {
      const next = children[i + 1]
      if (typeof next.value === 'string' && next.value.startsWith(SENTINEL_CLOSE)) {
        child.value = child.value.slice(0, -SENTINEL_OPEN.length)
        next.value = next.value.slice(SENTINEL_CLOSE.length)
        children.splice(i + 1, 0, { type: 'html', value: INLINE_BREAK })
        i += 1
        continue
      }
    }
    if (!child.value.includes(SENTINEL_OPEN)) continue
    // Only a text run can become text/html siblings. Any other value holder is
    // ONE node — a formula, an `html` atom, an MDX component's source — and
    // replacing it with a run of that same type is what broke documents open.
    if (child.type !== 'text') {
      child.value = unmaskInlineBreaks(child.value)
      continue
    }
    const pieces = splitSentinel(child.value)
    if (pieces.length === 1 && typeof pieces[0] === 'string') {
      child.value = pieces[0]
      continue
    }
    const replacement: MdastLike[] = pieces
      .map((piece: Piece) =>
        typeof piece === 'string'
          ? { type: child.type, value: piece }
          : { type: 'html', value: piece.html },
      )
      .filter((node) => node.type !== 'text' || String(node.value ?? '').length > 0)
    children.splice(i, 1, ...replacement)
    i += replacement.length - 1
  }
}

/**
 * Drop a `<br>` that is the whole of a table cell, leaving the cell empty.
 *
 * This is the parse half of the empty-cell rule; `table/stringify.ts` is the
 * write half, and neither is sufficient alone. A note written before that rule
 * existed holds `| <br /> |` in every blank cell, and a line with pipes in it is
 * never a "standalone line" to the masker — so the marker is masked, restored as
 * an `html` atom, and the save after it writes `<br />` straight back. Dropping
 * the atom here is what makes an existing file shed the marker on its next save
 * instead of keeping it forever.
 *
 * It is also what keeps the write rule from having to guess. With the atom gone
 * the cell holds nothing, so a `<br>` that IS in a cell is always one the reader
 * put between two things — `a<br />b`, the only line break a GFM cell can
 * express — and the write side leaves it alone.
 *
 * The shape has to be read off the PARSER's tree, which is not the serializer's:
 * mdast-util-gfm-table holds a cell's content as phrasing children directly
 * (there is no `paragraph` in the cell until the schema builds one), and the
 * masker's repair can leave empty text runs on either side of the atom it puts
 * back — `[text "", html, text ""]` is what one marker looks like. So "the whole
 * cell" is decided by what is left after the empty runs are discounted.
 *
 * Nothing else about the empty-line convention moves. A marker standing alone
 * between two blocks (`a` / `<br />` / `b`) is still folded back into an empty
 * paragraph: that is a marker on its own LINE, `visitEmptyLine` has already
 * handled it by the time this runs, and it is a different tree shape.
 */
export function dropEmptyCellBreaks(tree: MdastLike): void {
  const children = tree.children
  if (!children) return
  for (const child of children) {
    if (Array.isArray(child.children)) dropEmptyCellBreaks(child)
  }
  if (tree.type !== 'tableCell') return
  const significant = children.filter(
    (child) => !(child.type === 'text' && String(child.value ?? '').trim() === ''),
  )
  if (significant.length !== 1) return
  const only = significant[0]
  if (only.type !== 'html' || typeof only.value !== 'string') return
  if (!isInlineBreakValue(only.value)) return
  tree.children = children.filter((child) => child !== only)
}

/**
 * Strip any sentinel the walk above could not reach.
 *
 * The sentinel pair addresses positions in a text run, which is why the repair
 * above is structural. But a marker can also sit in a field that is a plain string
 * with no children to repair — an image’s `alt`, a link’s `title` — and there it
 * survived the whole parse and was written into the user’s file as two private-use
 * characters. Every string in the tree therefore ends up here, which is what makes
 * “the sentinel is never written out” true rather than merely intended.
 */
function unmaskRemaining(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) unmaskRemaining(child)
    return
  }
  if (node === null || typeof node !== 'object') return
  const record = node as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const value = record[key]
    if (typeof value === 'string') {
      if (hasSentinel(value)) record[key] = unmaskInlineBreaks(value)
      continue
    }
    if (value !== null && typeof value === 'object') unmaskRemaining(value)
  }
}
