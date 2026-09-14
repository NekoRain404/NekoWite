import { mdxJsxMdast, isOpenTag } from './remark'
import { scanExpression } from './runs'
import type { SourceNode } from './source'

/**
 * MDX the parser rejects, kept away from the parser.
 *
 * micromark refuses a document it cannot read — `{width=640 align=center}` is an
 * MDX expression that is not JavaScript, `<https://example.com>` is an autolink
 * MDX does not have, `<Callout>` that never closes is not a JSX element — and it
 * throws out of the parse. The caller then had one answer for that: read the
 * whole file as Markdown, which is the path that existed before MDX parsing did.
 * The syntax is a fact about the product, so the failing thing had to become the
 * construct instead of the document.
 *
 * That is what this does, in the shape `runs.ts` already uses one level down: a
 * span the parser cannot read is replaced by a form it accepts, and the bytes are
 * never the placeholder's — the tree is read back off the ORIGINAL source by
 * offset (`source.ts`), so whatever the parser made of the placeholder, the
 * author's text is what comes out. Hence the one rule that makes the whole thing
 * safe: **a placeholder is exactly as long as what it replaces.** Offsets in the
 * tree then address the same bytes in the original, and nothing downstream —
 * `normalizeMdxTree`, the transformers, `imageDimMdast` — has to know a mask
 * happened at all.
 *
 * What gets masked is decided by TRYING. The MDX parser is the oracle: it is
 * handed the document, and whatever it throws on is the construct that gets
 * masked. Nothing here guesses from a pattern that some `{ … }` is "not really
 * MDX", so `{a * b}` and `{width=480}` are never touched — not because a rule
 * recognises them, but because micromark reads them without complaint.
 *
 * Two things are deliberately let through:
 *
 *   - **What the author wrote literally.** A construct inside a fence, a backtick
 *     span or a formula is not MDX to the parser either, so masking there would
 *     be pointless and the one way this could corrupt a file: those nodes' values
 *     come from the tokenizer, not from the source offsets, so a placeholder
 *     inside one would be written out as a placeholder. Every span is therefore
 *     checked against the spans micromark itself reports as code or math.
 *   - **What cannot be recovered.** A construct too short to hold a placeholder,
 *     or a throw that does not say what it was reading (see `abandonedTag`), ends
 *     the attempt; the caller then falls back exactly as it did before, so the
 *     worst case here is the behaviour this replaced.
 */

/** Parse a document and return its tree, throwing on a document it cannot read. */
export type Parse = (text: string) => unknown

interface Span {
  start: number
  end: number
}

/** The node types whose value is the author's literally and comes from the
 *  tokenizer rather than from the source offsets — see `readLiteralSpans`. */
const LITERAL = new Set(['code', 'inlineCode', 'math', 'inlineMath'])

/**
 * The identifier a masked `{ … }` is written as, and the element name a masked
 * `< … >` is. Both are only ever a parse-time device: the tree is read off the
 * original source, so neither is ever written anywhere.
 *
 * The element name is padded with digits to fill the space available, which for
 * a short tag can leave it as little as `_`. That is narrow enough to be worth
 * saying why it is safe: `document.ts` folds an element named this way to raw
 * source rather than to a component — and for a name that was NOT a placeholder
 * that fold is a no-op, because a component node writes its source back verbatim
 * anyway. The fold changes the node kind, never the bytes.
 */
const MASK_NAME_RE = /^_\d*$/

/** How many constructs may be masked before the document is left to the Markdown
 *  pipeline. Each attempt costs one parse, and a document this far gone is not
 *  going to be repaired by one more. */
const MAX_MASKED = 64

/** How far a construct may reach, mirroring the runs scanner's cap: one stray
 *  `{` must not let a scan swallow the rest of the note. */
const MAX_CONSTRUCT = 8000

/** The offset an error reports, when it reports one. */
interface Located {
  place?: { offset?: number; line?: number; column?: number }
  offset?: number
  line?: number
  column?: number
}

/** True when an element name is one this module writes. */
export function isMaskName(name: unknown): boolean {
  return typeof name === 'string' && MASK_NAME_RE.test(name)
}

/**
 * `source` with every construct MDX rejects replaced by a placeholder of the
 * same length, ready for both the MDX parse and `normalizeMdxTree`.
 *
 * The returned string is the input when nothing had to be masked — the common
 * case, and the reason this costs one parse for a document that already parses.
 * When the attempt fails it returns what it managed to mask; the caller's parse
 * then throws as it did before, which is what puts the document back on the
 * Markdown pipeline.
 *
 * `parseMarkdown` is the same processor WITHOUT the MDX extension. It never
 * throws, and it is what says which spans are code and which elements are never
 * closed; it may be null, and then neither of those answers is available.
 */
export function maskMdxSource(source: string, parseMdx: Parse, parseMarkdown: Parse | null): string {
  const spans: Span[] = []
  let masked = source
  let literal: Span[] | null = null

  for (let attempt = 0; attempt <= MAX_MASKED; attempt++) {
    try {
      parseMdx(masked)
      return masked
    } catch (error) {
      literal ??= readLiteralSpans(source, parseMarkdown)
      if (literal === null) return masked
      const span =
        rejectedConstruct(source, error) ?? abandonedTag(masked, parseMarkdown, literal, spans)
      if (span === null || overlaps(literal, span) || overlaps(spans, span)) return masked
      if (placeholder(source.slice(span.start, span.end)) === null) return masked
      spans.push(span)
      masked = applyMasks(source, spans)
    }
  }
  return masked
}

// ---------------------------------------------------------------------------
// Locating what the parser rejected
// ---------------------------------------------------------------------------

/**
 * The construct the parser was reading when it gave up.
 *
 * micromark names the rule it failed on (`acorn`, `unexpected-character`, …) and
 * carries a `place` for every parser-level one, so the offset is read from the
 * error rather than inferred. The construct around that offset is then the `{ … }`
 * group or the `< … >` tag that contains it — a guess about the SHAPE only, which
 * the next attempt validates: masking the wrong span leaves the same error in
 * place, the loop runs out, and the document falls back as before.
 */
function rejectedConstruct(source: string, error: unknown): Span | null {
  const offset = errorOffset(source, error)
  if (offset === null) return null
  return braceGroup(source, offset) ?? tagAround(source, offset)
}

function errorOffset(source: string, error: unknown): number | null {
  const located = error as Located | null
  const direct = located?.place?.offset ?? located?.offset
  if (typeof direct === 'number') return direct
  const line = located?.place?.line ?? located?.line
  const column = located?.place?.column ?? located?.column
  if (typeof line !== 'number' || typeof column !== 'number') return null
  let offset = 0
  for (let i = 1; i < line; i++) {
    const next = source.indexOf('\n', offset)
    if (next === -1) return null
    offset = next + 1
  }
  return offset + column - 1
}

/** The outermost balanced `{ … }` containing `offset`, or null. */
function braceGroup(source: string, offset: number): Span | null {
  for (let i = 0; i <= offset && i < source.length; i++) {
    if (source[i] !== '{') continue
    const end = scanExpression(source, i)
    if (end === null) continue
    if (end > offset) return { start: i, end }
    i = end - 1
  }
  return null
}

/** The `< … >` containing `offset`, or null. */
function tagAround(source: string, offset: number): Span | null {
  let tries = 0
  for (let i = offset; i >= 0 && offset - i <= MAX_CONSTRUCT && tries < 32; i--) {
    if (source[i] !== '<') continue
    tries += 1
    const end = tagEnd(source, i)
    if (end !== null && end > offset) return { start: i, end }
  }
  return null
}

/**
 * The offset just past the `>` closing the tag opened at `start`, or null.
 *
 * `runs.ts`'s `scanTag` answers the same question but refuses a tag whose name
 * is not a component's, which is exactly the shape that reaches the parser and
 * fails there (`<https://example.com>`): this one takes any name, and only tracks
 * what could hide a `>` — quotes, braces, a blank line — because what it is for
 * is finding the end of a construct micromark has already rejected.
 */
function tagEnd(source: string, start: number): number | null {
  let quote: string | null = null
  let braces = 0
  const limit = Math.min(source.length, start + MAX_CONSTRUCT)
  for (let i = start + 1; i < limit; i++) {
    const ch = source[i]
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '{') {
      braces += 1
      continue
    }
    if (ch === '}' && braces > 0) {
      braces -= 1
      continue
    }
    if (braces > 0) continue
    if (ch === '>') return i + 1
    if (ch === '<') return null
    if (ch === '\n' && source[i + 1] === '\n') return null
  }
  return null
}

// ---------------------------------------------------------------------------
// Locating the tag the parser could not pair
// ---------------------------------------------------------------------------

/**
 * An element whose open tag is never closed.
 *
 * `<Callout>` with no `</Callout>` anywhere is an `end-tag-mismatch`, and that
 * error is the one micromark does NOT put a place on — `mdast-util-mdx-jsx`
 * builds it in a transformer, with the position only inside its message text.
 * Reading a position back out of a message is not something to build on, so the
 * construct is found instead: the same document is read once by the MARKDOWN
 * parser, which never refuses anything, and every element left with an open tag
 * and no close tag is one the MDX parser will refuse the whole file over.
 *
 * That pass is also the answer to code — a fence is a `code` node there, so a
 * `<Callout>` written inside one is never a candidate.
 */
function abandonedTag(
  masked: string,
  parseMarkdown: Parse | null,
  literal: Span[],
  spans: Span[],
): Span | null {
  if (!parseMarkdown) return null
  type Tree = SourceNode & { children?: SourceNode[] }
  let tree: Tree
  try {
    tree = parseMarkdown(masked) as Tree
  } catch {
    // The Markdown parser does not refuse documents, but a document can still
    // be handled by a plugin that does. Nothing to find, then.
    return null
  }
  if (!tree?.children) return null
  // Merges every element that DOES close into one node, so whatever is left
  // holding an open tag is the one MDX complains about.
  mdxJsxMdast(tree as never, { value: masked })
  const found: Span[] = []
  walk(tree, (node) => {
    if (node.type !== 'html' || typeof node.value !== 'string') return
    if (!isOpenTag(node.value) || /\/\s*>$/.test(node.value)) return
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (start === undefined || end === undefined || end <= start) return
    found.push({ start, end })
  })
  return found.find((span) => !overlaps(literal, span) && !overlaps(spans, span)) ?? null
}

function walk(node: SourceNode & { children?: SourceNode[] }, visit: (node: SourceNode) => void): void {
  visit(node)
  for (const child of node.children ?? []) walk(child as SourceNode & { children?: SourceNode[] }, visit)
}

/**
 * The spans whose content is the author's literally: code, and math.
 *
 * Nothing inside one is MDX, and nothing inside one may be rewritten. A `code`
 * node's value and a `math` node's value come from the tokenizer rather than from
 * the source offsets, so a placeholder written into one would come back out as
 * the placeholder — the one way this module could corrupt a file, and the reason
 * an answer that is not a list of spans (`null`) stops the masking rather than
 * leaving it unchecked.
 *
 * Math belongs on the list even though it is not code: `$\frac{a}{b}$` is braces
 * to a scanner, and a formula holds plenty that is not JavaScript (`$e^{i\pi}$`
 * has a `\` in it). MDX never sees inside one, so the parse-driven loop cannot
 * point here — but the scan that ENCLOSES an offset could, and a mask that
 * reached a formula would be written into the file.
 */
function readLiteralSpans(source: string, parseMarkdown: Parse | null): Span[] | null {
  if (!parseMarkdown) return null
  let tree: unknown
  try {
    tree = parseMarkdown(source)
  } catch {
    // The Markdown parser does not refuse documents; a plugin around it can
    // still throw, and a document it cannot read is a document whose code
    // regions are unknown.
    return null
  }
  const spans: Span[] = []
  const root = tree as SourceNode & { children?: SourceNode[] } | null
  if (!root?.children) return null
  walk(root, (node) => {
    if (!LITERAL.has(node.type ?? '')) return
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (start !== undefined && end !== undefined && end > start) spans.push({ start, end })
  })
  return spans
}

// ---------------------------------------------------------------------------
// Writing the placeholders
// ---------------------------------------------------------------------------

/**
 * A form of `text` that MDX reads and that is EXACTLY as long as `text`, or null
 * when there is not room for one.
 *
 * A `{ … }` is masked as another expression and a `< … >` as another element, so
 * the placeholder is read as the same kind of thing the original was and lands in
 * the same place in the tree. The length is the load-bearing part: it is what lets
 * the tree's offsets keep addressing the original source, which is what puts the
 * author's bytes back without a restore step to get wrong.
 */
function placeholder(text: string): string | null {
  return text.startsWith('<') ? element(text.length) : expression(text.length)
}

function expression(length: number): string | null {
  const inner = length - 2
  if (inner < 1) return null
  return `{_${'0'.repeat(inner - 1)}}`
}

function element(length: number): string | null {
  const inner = length - 3
  if (inner < 1) return null
  return `<${'_'.concat('0'.repeat(inner - 1))}/>`
}

function applyMasks(source: string, spans: Span[]): string {
  const ordered = [...spans].sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const span of ordered) {
    if (span.start < cursor) continue
    const replacement = placeholder(source.slice(span.start, span.end))
    if (replacement === null) continue
    out += source.slice(cursor, span.start) + replacement
    cursor = span.end
  }
  return out + source.slice(cursor)
}

function overlaps(spans: Span[], span: Span): boolean {
  return spans.some((other) => span.start < other.end && other.start < span.end)
}
