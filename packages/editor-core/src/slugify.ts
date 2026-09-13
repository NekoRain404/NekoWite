// Convert a heading's text into the fragment used for heading deep-links.
// Pure, dependency-free, and intentionally conservative: headings that produce
// an empty slug (e.g. punctuation-only) fall back to a stable placeholder so
// the anchor is always addressable.

/** Lowercase, normalise whitespace, drop characters unsuitable for an HTML
 *  id / URL fragment, and hyphenate the remainder. */
export function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || 'section'
}

/**
 * The anchor ids for a document's headings, in document order.
 *
 * Two headings with the same text slug to the same fragment, so the second and
 * later occurrences get a `-<n>` suffix (the scheme GitHub uses). This is the
 * single definition shared by three consumers that must agree, or the links one
 * produces do not resolve in the other:
 *
 *  - the heading anchors that COPY a deep link,
 *  - the exported HTML that has to expose the matching `id`, and
 *  - the handler that scrolls to an anchor.
 *
 * Note the inherent ambiguity, also present on GitHub: a heading literally
 * titled "Same 1" slugs to `same-1`, which is also what a second "Same" gets.
 * Resolution is positional (first match in document order wins), so a link
 * always lands on the heading that produced it.
 */
export function headingAnchorIds(texts: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return texts.map((text) => {
    const base = slugify(text)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}-${count}`
  })
}
