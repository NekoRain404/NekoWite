import { parseFrontmatterForPanel, replaceFrontmatter, splitFrontmatterRaw } from '../features/notes'

/** Normalize a single tag: strip surrounding whitespace and leading `#`s, then
 * collapse inner runs of whitespace. Empty results are dropped by callers. */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim()
}

/** Normalize a list of tags: dedupe (case-sensitive), strip noise, drop
 * empties, and preserve first-occurrence order. */
export function normalizeTags(raw: Iterable<string | null | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    if (!r) continue
    const t = normalizeTag(r)
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/** Union of two tag lists, normalized and deduplicated. */
export function mergeTags(a: readonly string[], b: readonly string[]): string[] {
  return normalizeTags([...a, ...b])
}

/** Remove the given tags from a list (comparing by normalized form). */
export function removeTags(tags: readonly string[], remove: readonly string[]): string[] {
  const removeSet = new Set(normalizeTags(remove))
  return tags.filter((t) => !removeSet.has(normalizeTag(t)))
}

/** Remove `tag` from the frontmatter of `content`, returning the new document
 * text. Returns `content` unchanged when the tag (or any frontmatter) is absent. */
export function removeTagFromContent(content: string, tag: string): string {
  const { front } = splitFrontmatterRaw(content)
  if (!front) return content
  const fields = parseFrontmatterForPanel(front)
  const next = removeTags(fields.tags, [tag])
  if (next.length === fields.tags.length) return content
  return replaceFrontmatter(content, { ...fields, tags: next }).content
}
