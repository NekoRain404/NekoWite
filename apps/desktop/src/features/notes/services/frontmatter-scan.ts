/**
 * Finding a note's frontmatter block, and the lightweight read of it the index
 * needs.
 *
 * This is the reading layer of the frontmatter concern. `splitFrontmatterRaw`
 * and `splitNoteForSummary` decide where the block ends and the body begins;
 * `parseFrontmatterBlock` takes only the title and the tags — all the note list,
 * the tag filter, the aggregate counts and the search index share. The panel's
 * full-fidelity model, the one that round-trips every unknown key byte for byte,
 * is `frontmatter-panel.ts`, which builds on this module instead of re-deriving
 * the fences a second time.
 *
 * Pure: no fs, no gateway, no store.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---((?:\r?\n)+|$)/

/**
 * How much of a note the library scan reads for its metadata.
 *
 * The block used to be sliced to `SNAPSHOT_CHARS` BEFORE being split, so a
 * frontmatter block longer than that slice never closed inside it: `front` came
 * back empty and the note lost its title and tags in the list, in the tag
 * filter, in the aggregate counts and in the search index — while the
 * frontmatter panel (which reads the whole block) still showed them, so the two
 * surfaces disagreed about the same note. The scan is bounded instead: the
 * frontmatter is found first, and only the BODY after it is sampled.
 *
 * A note that opens with `---` and never closes it would otherwise make the
 * lazy match scan the entire file, so the search for the closing fence is
 * capped well above any realistic block.
 */
const FRONTMATTER_SCAN_CHARS = 8192
const SNAPSHOT_CHARS = 400

export function splitFrontmatterRaw(md: string): { front: string; body: string } {
  const match = FRONTMATTER_RE.exec(md)
  if (!match) return { front: '', body: md }
  return { front: match[1] ?? '', body: md.slice(match[0].length) }
}

/**
 * The metadata-relevant view of a note: its frontmatter block (found within the
 * scan cap) and a sample of the BODY that follows it.
 *
 * Returning the body from AFTER the block matters as much as the block itself:
 * sampling the first 400 characters meant a long frontmatter ate the sample
 * too, so the summary and the H1 fallback were taken from YAML text.
 */
export function splitNoteForSummary(md: string): { front: string; body: string } {
  const head = md.length > FRONTMATTER_SCAN_CHARS ? md.slice(0, FRONTMATTER_SCAN_CHARS) : md
  const match = FRONTMATTER_RE.exec(head)
  if (!match) return { front: '', body: md.slice(0, SNAPSHOT_CHARS) }
  const bodyStart = match[0].length
  return { front: match[1] ?? '', body: md.slice(bodyStart, bodyStart + SNAPSHOT_CHARS) }
}

export function hasFrontmatter(md: string): boolean {
  return splitFrontmatterRaw(md).front !== ''
}

/** Exported for `frontmatter-panel.ts`, its only other caller: both layers read
 *  YAML scalars and must agree on what "quoted" means, so the rule lives once.
 *  It is not re-exported by the feature's public API. */
export function stripQuotes(value: string): string {
  const t = value.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).trim()
  }
  return t
}

/** Lightweight frontmatter scan: `title:` string plus `tags:` as a YAML block
 * array, an inline `[a, b]` list, or a comma-separated value. */
export function parseFrontmatterBlock(front: string): { title: string; tags: string[] } {
  let title = ''
  let tags: string[] = []
  let collectingTags = false
  for (const line of front.split(/\r?\n/)) {
    if (collectingTags) {
      const item = /^\s+-\s*(.+?)\s*$/.exec(line)
      if (item) {
        const tag = stripQuotes(item[1])
        if (tag) tags.push(tag)
        continue
      }
      if (line.trim() === '') continue
      collectingTags = false
    }
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!pair) continue
    const key = pair[1].toLowerCase()
    const value = pair[2].trim()
    if (key === 'title') {
      title = stripQuotes(value)
      collectingTags = false
    } else if (key === 'tags') {
      tags = []
      if (value === '') {
        collectingTags = true
      } else {
        const cleaned = value.replace(/^\[/, '').replace(/\]$/, '')
        tags = cleaned
          .split(',')
          .map((piece) => stripQuotes(piece))
          .filter(Boolean)
      }
    } else {
      collectingTags = false
    }
  }
  return { title, tags }
}
