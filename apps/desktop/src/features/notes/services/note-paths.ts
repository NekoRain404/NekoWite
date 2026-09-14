/**
 * Note paths, expressed the way the app needs them: relative to the vault.
 *
 * The vault prefix is not a detail the callers can agree on by convention.
 * `tab.path` is vault-relative in some flows and an absolute (vault-prefixed)
 * path in others — `list_dir` returns the resolved path while the link index
 * returns a vault-relative one — so every consumer that needs to JOIN the vault
 * back onto a path has to strip whatever prefix is already there first. This
 * module is that one place, plus the relative-segment resolution a markdown
 * link target needs.
 *
 * Leaf module by design: it imports the shared path grammar and nothing from
 * the notes feature, so the summary, query and link layers can all build on it.
 */

import { dirName, stripVaultPrefix } from '../../../services/paths'

/**
 * A note path with the vault prefix removed, so it can be re-rooted at the
 * vault.
 *
 * `tab.path` is vault-relative in some flows and an absolute (vault-prefixed)
 * path in others — `list_dir` returns the resolved path, while the link index
 * returns a vault-relative one — so anything that needs to JOIN the vault back
 * onto a note path must strip whatever prefix is already there first. Joining
 * without stripping is what produced a doubled path in copied heading links.
 */
export function notePathRelativeToVault(path: string, vault: string): string {
  // Separator-agnostic: both the note path and the vault arrive in the
  // platform's native spelling (backslashes on Windows), so a `/`-only prefix
  // test never matched and the absolute path was returned unchanged.
  return stripVaultPrefix(path, vault)
}

/** Directory of `path` relative to the vault. Absolute paths (Tauri) get the
 * vault prefix stripped; already-relative paths (demo gateway) are kept as-is. */
export function dirRelativeToVault(path: string, vault: string): string {
  const p = notePathRelativeToVault(path, vault)
  const dir = dirName(p)
  return dir === p ? '' : dir
}

/** The note's path as the vault sees it. Takes the two fields structurally
 *  rather than as `Pick<NoteSummary, …>` so this module stays a leaf — the
 *  summary module depends on it, never the other way round. */
export function relPathOf(note: { dir: string; name: string }): string {
  return note.dir ? `${note.dir}/${note.name}` : note.name
}

/** Resolve a markdown link target against the note's vault-relative dir. */
export function resolveLinkTarget(fromRelDir: string, target: string): string {
  const clean = target.split('#')[0].trim()
  if (!clean) return ''
  const segs = fromRelDir ? fromRelDir.split('/') : []
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') segs.pop()
    else segs.push(part)
  }
  return segs.join('/')
}
