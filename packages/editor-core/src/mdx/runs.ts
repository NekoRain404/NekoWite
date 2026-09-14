/**
 * The MDX runs hiding inside a Markdown text node.
 *
 * A text node is not prose just because remark says so. micromark only turns a
 * `<Tag …>` into an `html` node when CommonMark's attribute grammar accepts it,
 * so everything JSX-shaped that it cannot read — a spread attribute
 * (`<Callout {...props} />`), a prop expression (`onClick={() => go()}`), a
 * fragment (`<>…</>`) — arrives as ordinary `text`, and so does every `{…}`
 * expression. The Markdown stringifier then escapes that text for Markdown:
 * `<Callout {...props} />` leaves as `\<Callout {...props} />` and `{a * b}` as
 * `{a \* b}` — the first is no longer JSX, the second is no longer JavaScript.
 *
 * Nothing inside one of these runs is Markdown, so nothing inside it may be
 * escaped. `findMdxRuns` marks the spans that are MDX rather than prose; the
 * serializers (see `text.ts`) write those spans out byte for byte and escape only
 * the text around them.
 *
 * A malformed run is deliberately NOT returned: an unterminated `<Callout foo=`
 * or an unbalanced `{` stays Markdown text and keeps the escaping it has today.
 */

export interface MdxRun {
  start: number
  /** Exclusive. */
  end: number
}

/** JSX name: an identifier, possibly dotted (`Foo.Bar`) or dashed.
 *  `[A-Za-z_$]` first, which is what keeps `<https://x.test>` (an autolink) out. */
const TAG_NAME_RE = /^\/?([A-Za-z_$][\w$.-]*)/

/** Give up on a tag whose `>` is this far away: that `<` is prose, not a tag, and
 *  an unbounded scan would let one stray `<Callout` swallow the rest of the note. */
const MAX_TAG_LENGTH = 2000

/**
 * What a scan of `<…>` found: the offset just past a terminating `>`, `'open'`
 * when the run is a tag that simply has not closed yet (the scan ran out of text
 * with its quotes and braces still balanced — a tag the Markdown parser could not
 * finish, whose `>` is in a later block), or null when it is not one tag at all.
 */
export type TagScan = number | 'open' | null

/** JSX component names are capitalised; a lowercase tag is ordinary HTML, which
 *  remark already handles as its own `html` node. */
function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name)
}

/**
 * Scan a `<…>` run starting at `start`, or return null when it is not one.
 *
 * Quoted attribute values (`hint="a > b"`) and brace groups (`onClick={() => go()}`)
 * may hold `>`, so the scan tracks both; it ends at the first `>` outside them.
 * A blank line ends the scan too — nothing else about a tag is line-bounded, and
 * a multi-line tag is exactly the shape a reader would write.
 */
function scanTag(text: string, start: number): TagScan {
  const after = text.slice(start + 1)
  // Fragments have no name at all: `<>` … `</>`.
  if (after.startsWith('>')) return start + 2
  if (after.startsWith('/>')) return start + 3
  const name = TAG_NAME_RE.exec(after)
  if (!name) return null

  let quote: string | null = null
  let braces = 0
  let jsAttribute = false
  const limit = Math.min(text.length, start + MAX_TAG_LENGTH)
  for (let i = start + 1 + name[0].length; i < limit; i++) {
    const ch = text[i]
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
      jsAttribute = true
      continue
    }
    if (ch === '}' && braces > 0) {
      braces -= 1
      continue
    }
    if (braces > 0) continue
    if (ch === '>') {
      // `{…}` in the attributes is what micromark cannot read as HTML, so a
      // lowercase tag carrying one (`<my-widget a={1} />`) is JSX too.
      return isComponentName(name[1]) || jsAttribute ? i + 1 : null
    }
    if (ch === '<') return null
    if (ch === '\n' && text[i + 1] === '\n') return null
  }
  // Out of characters rather than out of tag: `<Callout\n  title="x"\n` is the
  // beginning of an element whose `>` and body are in later blocks. A truncated
  // scan (the length cap) is not evidence of that, and neither is an unclosed
  // quote — that is a malformed tag, not a long one.
  if (limit < text.length || quote !== null) return null
  return 'open'
}

/**
 * Scan a `{…}` expression starting at `start`, or return null when the braces do
 * not balance.
 *
 * Exported because the masker (`mask.ts`) asks the same question about the same
 * source — which `{ … }` group encloses this offset — and a second brace matcher
 * would be a second set of rules for where a `}` is.
 *
 * Braces nest (`{f({a: 1})}`) and strings inside the expression may hold one
 * (`{"}"}`), so both are tracked. A brace pair in prose (`a {note} here`) is
 * returned as a run as well: it costs nothing, and choosing between "expressions"
 * and "braces the author liked" is MDX's job, not this scanner's.
 */
export function scanExpression(text: string, start: number): number | null {
  let quote: string | null = null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return null
}

/** Every MDX run in `text`, in source order and non-overlapping. */
export function findMdxRuns(text: string): MdxRun[] {
  const runs: MdxRun[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const scan = ch === '<' ? scanTag(text, i) : ch === '{' ? scanExpression(text, i) : null
    if (typeof scan !== 'number') {
      i += 1
      continue
    }
    runs.push({ start: i, end: scan })
    i = scan
  }
  return runs
}

/**
 * The component name when `text` OPENS an element that this text does not finish
 * — `<Callout\n  title="x"\n  kind="info"\n` — or null.
 *
 * Micromark hands back the rest of such a tag as text and reads whatever follows
 * as its own blocks: for a tag written with `>` on its own line, that line parses
 * as an empty blockquote and the body becomes a separate paragraph, so the file
 * is restructured on save. The element is one token to its author; the caller
 * (`mdx/remark.ts`) rebuilds it from the source between this offset and its close
 * tag.
 */
export function openTagName(text: string): string | null {
  const name = TAG_NAME_RE.exec(text.slice(1))
  if (!name || !isComponentName(name[1])) return null
  return scanTag(text, 0) === 'open' ? name[1] : null
}
