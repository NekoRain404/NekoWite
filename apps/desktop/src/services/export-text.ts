/**
 * The text-shaped exporters: plain text, and CSV for the tables in a document.
 *
 * Both read the SAME rendered HTML the other exporters write, rather than the
 * Markdown source. That is the whole reason they can be honest: the renderer
 * already decided what every construct means (a footnote is a footnote, a
 * task list is a task list), and a second reader of the source would be a
 * second opinion about the document — the one thing an export must not have.
 * Nothing here extends the renderer; it only reads what the renderer produced.
 */

/** Elements whose text is not document content. `style`/`script` are never
 *  rendered anyway; `head` is stripped by the `<body>` read below. */
const SKIPPED = new Set(['STYLE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT'])

/** Elements that start a new line when they open and when they close. */
const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'DD', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR', 'UL',
])

/** Elements whose whitespace is significant (the renderer's `<pre>` blocks). */
const VERBATIM = new Set(['PRE'])

/** Table cells. They are separated by a space rather than a line break: the
 *  row is the line (see `TR` above), and `甲乙丙 value 42` is the row as someone
 *  would read it out. A cell break that became a newline would turn a ten-row
 *  table into thirty lines with nothing to say which cell belonged to which
 *  row. The renderer emits only inline content inside a cell, so a cell never
 *  carries a block of its own to confuse this. */
const CELL = new Set(['TD', 'TH'])

function parseBody(html: string): HTMLElement | null {
  if (typeof DOMParser === 'undefined') return null
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return doc.body
}

/**
 * The document as plain text.
 *
 * Block boundaries become newlines because that is what they are: a paragraph
 * is a line, not a run-on. Whitespace inside a line is collapsed, except in
 * `<pre>`, where the renderer's own indentation is part of what the user wrote
 * — a code block flattened to one line is a code block that no longer runs.
 */
export function htmlToPlainText(html: string): string {
  const body = parseBody(html)
  if (!body) return ''
  const out: string[] = []
  // A task item's marker opens the item's own line, and the renderer wraps every
  // item body in a `<p>` whose opening break would otherwise strand the marker
  // on the line above the text it belongs to. So the break that follows a marker
  // is spent rather than emitted — by one push only, since whatever is emitted
  // next either spends it or ends that line by being on it.
  let markerLine = false
  const push = (piece: string): void => {
    const spendsLine = markerLine && piece === '\n'
    markerLine = false
    if (!spendsLine) out.push(piece)
  }

  const walk = (node: Node, verbatim: boolean): void => {
    if (node.nodeType === 3 /* text */) {
      const text = node.nodeValue ?? ''
      push(verbatim ? text : text.replace(/\s+/g, ' '))
      return
    }
    if (node.nodeType !== 1 /* element */) return
    const el = node as Element
    const tag = el.tagName.toUpperCase()
    if (SKIPPED.has(tag)) return
    if (tag === 'BR') {
      push('\n')
      return
    }
    if (tag === 'IMG') {
      // An image has no text, but dropping it silently makes the export shorter
      // than the document without saying so. Its alt text is what the document
      // itself falls back to.
      const alt = el.getAttribute('alt')?.trim()
      if (alt) push(`[${alt}]`)
      return
    }
    if (tag === 'INPUT' && el.getAttribute('type') === 'checkbox') {
      // A task item's state is an attribute on a void element, so it reaches the
      // text only here: unread, the item's body survives the walk and its state
      // does not, and a reader of the .txt cannot tell a done item from a
      // pending one — the same silence the IMG branch above refuses. `[x]`/`[ ]`
      // is GFM's own spelling for it, so the line reads as the document's source
      // does and a round trip back through Markdown still carries the state.
      push(el.hasAttribute('checked') ? '[x] ' : '[ ] ')
      markerLine = true
      return
    }
    const isBlock = BLOCK.has(tag)
    const isCell = CELL.has(tag)
    const inner = verbatim || VERBATIM.has(tag)
    if (isBlock) push('\n')
    for (const child of Array.from(el.childNodes)) walk(child, inner)
    // After the cell, not before it: a leading space would survive the
    // per-line trim below and indent every row.
    if (isCell) push(' ')
    if (isBlock) push('\n')
  }

  walk(body, false)
  return out
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** One CSV field, RFC 4180: quoted when it contains a delimiter, a quote, a
 *  newline, or leading/trailing space that a reader would otherwise eat. */
export function csvField(value: string): string {
  if (/[",\r\n]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/**
 * One CSV block per table in the document, blocks separated by a blank line —
 * or `null` when the document has no table at all, which the caller has to
 * report rather than write an empty file for.
 *
 * The renderer emits one `<thead>` of `<th>` and one `<tbody>` of `<td>` and
 * no `colspan`/`rowspan` (GFM tables cannot express a merged cell), so every
 * row has the same number of cells and a table maps onto CSV without losing
 * anything. A document with several tables is NOT one table: pretending they
 * were would put a second header row in the middle of the grid, so they are
 * kept apart and the separation is visible.
 */
export function htmlTablesToCsv(html: string): string | null {
  const body = parseBody(html)
  if (!body) return null
  const tables = Array.from(body.querySelectorAll('table'))
  if (tables.length === 0) return null

  const blocks = tables.map((table) =>
    Array.from(table.querySelectorAll('tr'))
      .map((row) =>
        Array.from(row.querySelectorAll('th,td'))
          .map((cell) => csvField((cell.textContent ?? '').replace(/\s+/g, ' ').trim()))
          .join(','),
      )
      .join('\r\n'),
  )
  return `${blocks.join('\r\n\r\n')}\r\n`
}
