/**
 * Pure read-only selectors over note-list state.
 *
 * These functions never touch a store, a gateway or the filesystem: they take a
 * snapshot of the note list + vault and return a derived value (filtered/sorted
 * notes, tag/count aggregates, link resolution). Keeping them side-effect free
 * makes every projection independently testable and lets a store mirror them as
 * computed getters without re-reading the index.
 */

// Cycle-blocked deep imports (§13.11): `features/notes` pulls in NoteListPanel,
// which reaches back here through `features/vault`. The query, summary and path
// modules reach nothing but i18n and the path helpers, so reading them directly
// is the one edge that does not close the loop.
import {
  aggregateTagCounts,
  computeLibraryCounts,
  type LibraryCounts,
} from '../../notes/services/note-query'
import { extractOutlinks, type MdLink, type NoteSummary } from '../../notes/services/note-summary'
import { relPathOf, resolveLinkTarget } from '../../notes/services/note-paths'

// `queryVisibleNotes` and its `NoteListQuery` were here, and are gone. They were a second spelling
// of the list the note panel draws — `features/notes/services/note-list-query.ts`'s `filter`/`sort`,
// driven by `use-note-list.ts` — over the very same `filterAndSortNotes`. Their only caller was
// `stores/document-list.ts`'s `visibleNotes` computed, which nothing read either; both went in the
// same change. What is left in this module is the aggregating half (tag counts, nav counts, link
// resolution), which is what a store actually mirrors.

/** Aggregate tag → count for the sidebar/frontmatter suggestions. */
export function queryTagCounts(
  notes: readonly NoteSummary[],
  limit = 8,
): Array<{ tag: string; count: number }> {
  return aggregateTagCounts([...notes], limit)
}

/** Library nav counts (all / recent / favorites / uncategorized). */
export function queryCounts(
  notes: readonly NoteSummary[],
  favorites: readonly string[],
  recents: readonly string[],
): LibraryCounts {
  return computeLibraryCounts([...notes], favorites, recents)
}

/** Resolve a markdown link target found in a note under `fromRelDir` to the
 * indexed note's openable path (falls back to `target + '.md'`). */
export function resolveLinkPath(
  notes: readonly NoteSummary[],
  vault: string | null,
  fromRelDir: string,
  target: string,
): string | null {
  if (!vault) return null
  const rel = resolveLinkTarget(fromRelDir, target)
  if (!rel) return null
  const candidates = [rel, `${rel}.md`]
  for (const note of notes) {
    const noteRel = relPathOf(note)
    if (candidates.includes(noteRel)) return note.path
  }
  for (const candidate of candidates) {
    // Suffix match against the VAULT-RELATIVE path, not the raw one: note paths
    // are native (backslash-separated on Windows), so a '/'-prefixed suffix test
    // never matched there and this whole fallback was dead on the platform the
    // app ships to.
    const hit = notes.find((n) => {
      const noteRel = relPathOf(n)
      return noteRel === candidate || noteRel.endsWith(`/${candidate}`)
    })
    if (hit) return hit.path
  }
  return null
}

/** Outlinks of a document: parsed from its content and resolved against the
 * index. Unresolvable targets are kept with path = null. */
export function outlinksOf(
  notes: readonly NoteSummary[],
  vault: string | null,
  fromRelDir: string,
  content: string,
): Array<MdLink & { path: string | null }> {
  const out: Array<MdLink & { path: string | null }> = []
  const seen = new Set<string>()
  for (const link of extractOutlinks(content)) {
    const key = `${link.target}\u0000${link.text}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...link, path: resolveLinkPath(notes, vault, fromRelDir, link.target) })
  }
  return out
}

/** Backlinks: indexed notes whose pre-parsed links point at `relPath`. */
export function inlinksOf(notes: readonly NoteSummary[], relPath: string | null): NoteSummary[] {
  if (!relPath) return []
  const withExt = /\.(md|mdx)$/i.test(relPath) ? [relPath] : [relPath, `${relPath}.md`]
  return notes.filter((n) => n.links.some((l) => withExt.includes(l)))
}
