/**
 * Rescue a GFM table whose delimiter row is a bullet list's.
 *
 * `- | -` is a valid delimiter row — hyphens with optional colons, separated by
 * pipes — and it is also a bullet-list marker followed by text. micromark tries
 * the flow construct registered for a line's first character before the one
 * registered for "any line", and the list wins that race, so the table's header
 * line stays a paragraph and everything under it becomes a list item with its
 * pipes escaped: `a | b\n- | -\n1 | 2` came back as `a | b\n\n- \| -\n  1 | 2`.
 * The same row written `-- | --`, or with a leading pipe, is a table — one
 * character deciding whether the author keeps their table is the defect, not
 * the canonical form a save writes (`| a | b |` is the model's own spelling, as
 * `| --- |` becoming `| - |` already is).
 *
 * The repair is textual, but it is only applied to a line the PARSE proved was
 * stolen: a paragraph immediately followed by a list that begins on the line
 * after it, a delimiter row on that line, and the same number of cells above.
 * A delimiter-looking line inside a fenced code block is inside a `code` node
 * and can never match, so code is safe by construction rather than by a second
 * scanner. The repaired source is parsed again and the result kept only if it
 * really produced the table; otherwise the original parse stands, which keeps
 * this from changing any document it does not fully understand. Positions are
 * returned alongside the tree because every caller reads source slices from
 * them (`mdx/document.ts`, `mdx/remark.ts`) and they have to describe the text
 * the tree was parsed from, not the text it was repaired from.
 */

/** The subset of mdast this module walks. */
export interface MdastNode {
  type?: string
  children?: MdastNode[]
  position?: { start?: { offset?: number }; end?: { offset?: number } }
}

/** A delimiter-row cell: hyphens, optionally with a leading and/or trailing colon. */
const DELIMITER_CELL = /^:?-+:?$/

/**
 * The stolen shape, from the list's own marker on: a lone hyphen cell — the
 * list marker itself — then the pipe that separates it from the next cell.
 * Reading from the marker rather than from the start of the line is what lets a
 * row inside a blockquote (`> - | -`) match; the `>` belongs to the container.
 */
const STOLEN_FIRST_CELL = /^-(?=[ \t]+\|)/

/** A parsed document: the tree, and the exact source its offsets describe. */
export interface ParsedDocument<T> {
  tree: T
  source: string
}

/**
 * Parse `md`, repairing any delimiter row the list construct stole.
 *
 * `parse` is the caller's own parser (the editor's and the save path's are
 * different processors), so the repair runs against the parser that will
 * actually read the document.
 */
export function parseWithTableRepair<T extends MdastNode>(
  md: string,
  parse: (source: string) => T,
): ParsedDocument<T> {
  const tree = parse(md)
  const repaired = repairStolenDelimiterRows(md, tree)
  if (repaired === null) return { tree, source: md }
  const second = parse(repaired)
  // Only a repair that produced the table is taken. Every condition above is
  // about what the author is likely to have meant; this one is about what the
  // parser can actually do with it.
  return countTables(second) > countTables(tree)
    ? { tree: second, source: repaired }
    : { tree, source: md }
}

/** The source with each stolen delimiter row given one more hyphen, or null. */
function repairStolenDelimiterRows(md: string, tree: MdastNode): string | null {
  const offsets: number[] = []
  const walk = (node: MdastNode): void => {
    const children = node.children
    if (!children) return
    for (let i = 0; i + 1 < children.length; i++) {
      const offset = stolenRowOffset(md, children[i], children[i + 1])
      if (offset !== null) offsets.push(offset)
    }
    for (const child of children) walk(child)
  }
  walk(tree)
  if (offsets.length === 0) return null
  let repaired = md
  // Last first, so the earlier offsets keep pointing at the same characters.
  for (const offset of offsets.reverse()) {
    repaired = `${repaired.slice(0, offset)}-${repaired.slice(offset)}`
  }
  return repaired
}

/**
 * Where the stolen delimiter row starts, or null when this paragraph/list pair
 * is not one.
 */
function stolenRowOffset(md: string, para: MdastNode, list: MdastNode): number | null {
  if (para.type !== 'paragraph' || list.type !== 'list') return null
  const paraEnd = para.position?.end?.offset
  const listStart = list.position?.start?.offset
  if (typeof paraEnd !== 'number' || typeof listStart !== 'number') return null
  const afterPara = md.indexOf('\n', paraEnd)
  if (afterPara < 0) return null
  const lineEnd = md.indexOf('\n', afterPara + 1)
  const lineEndOffset = lineEnd < 0 ? md.length : lineEnd
  // The list has to BE the line right after the paragraph: a blank line between
  // them means the row was not a delimiter row at all.
  if (listStart <= afterPara || listStart >= lineEndOffset) return null
  const row = md.slice(listStart, lineEndOffset)
  if (!STOLEN_FIRST_CELL.test(row)) return null
  const cells = splitCells(row.trimEnd())
  if (!cells.every((cell) => DELIMITER_CELL.test(cell.trim()))) return null
  // GFM: the delimiter row has to have as many cells as the header row above it.
  const header = lastLine(md, paraEnd)
  if (header === null || splitCells(header).length !== cells.length) return null
  return listStart
}

/** The last line of the paragraph, which is the header row the row belongs to. */
function lastLine(md: string, end: number | undefined): string | null {
  if (typeof end !== 'number') return null
  const start = md.lastIndexOf('\n', end - 1) + 1
  return md.slice(start, end)
}

/**
 * The pipe-separated cells of a table line, with an optional leading and
 * trailing pipe dropped and `\|` kept as part of its cell.
 */
function splitCells(line: string): string[] {
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\' && i + 1 < line.length) {
      current += ch + line[i + 1]
      i += 1
      continue
    }
    if (ch === '|') {
      cells.push(current)
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current)
  if (cells.length > 1 && cells[0].trim() === '') cells.shift()
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop()
  return cells
}

function countTables(node: MdastNode): number {
  let count = node.type === 'table' ? 1 : 0
  for (const child of node.children ?? []) count += countTables(child)
  return count
}
