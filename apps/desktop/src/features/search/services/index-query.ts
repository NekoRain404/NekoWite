/** The query path: answering over an already-built index.
 *
 * Both functions are pure, synchronous and store-free over the in-memory
 * document — no storage, no filesystem — so matching and index state can be
 * tested over a fixture index. The live full-body scan (contentSearch's
 * `searchWithIndex`) stays the source of truth for the snippet; this path only
 * decides which notes cannot match.
 */

import type { IndexState, StoredIndex } from './index-model'

/** Candidate note paths whose indexed text contains `query`. Returns an empty
 *  array for a blank query. The result is sorted so the UI stays stable. */
export function queryIndex(index: StoredIndex, query: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: string[] = []
  for (const [path, doc] of Object.entries(index.notes)) {
    if (doc.text.includes(q)) out.push(path)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

/** Coarse index state from the stored blob and the current file list. Does not
 *  stat disks — the build step reconciles mtime/size and sets a finer state.
 *
 *  Both directions count: a path with no entry means the index is missing
 *  something, and an entry with no path means it still describes a note the
 *  vault no longer has (a delete or rename leaves the entry behind until the
 *  next build). Reporting 'up-to-date' for the latter let a caller skip the
 *  reconcile that would drop it, so searches kept answering with a note that was
 *  gone and the click on that result failed. */
export function indexStateOf(index: StoredIndex | null, paths: string[]): IndexState {
  if (!index) return 'needs-rebuild'
  const current = new Set(paths)
  for (const path of paths) {
    if (!index.notes[path]) return 'stale'
  }
  for (const path of Object.keys(index.notes)) {
    if (!current.has(path)) return 'stale'
  }
  return 'up-to-date'
}
