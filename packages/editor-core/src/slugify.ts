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
