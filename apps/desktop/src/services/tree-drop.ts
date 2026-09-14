/**
 * Pure drop-resolution logic for the file tree's drag-and-drop "move" gesture.
 *
 * Given the visible tree rows (a flattened `{ path, isDir }` list), the source
 * path being dragged, the target row it was dropped on and the vault root path,
 * this decides whether the move is legal and, if so, computes the destination
 * path. Everything here is path arithmetic — no filesystem I/O — so it can be
 * unit-tested without a gateway.
 */
import { baseName, dirName, joinPath as joinPathOf } from './paths'


export type DropReason = 'ok' | 'self' | 'descendant' | 'conflict' | 'invalid'

export interface DropRow {
  path: string
  isDir: boolean
}

export interface DropResult {
  ok: boolean
  reason: DropReason
  /** The source path, as passed in (kept verbatim for the rename call). */
  from: string
  /** The destination path, set only when `ok` is true. */
  to: string | null
}

/** Last `/`-separated segment of a path (the entry name). Tolerates a trailing
 * slash and bare names without a separator. */
export function basename(path: string): string {
  // Tree rows carry absolute paths in the platform's native spelling, so a
  // `/`-only split returned the whole path on Windows.
  return baseName(path)
}

/** Everything before the last `/`-separated segment (the containing dir). */
export function dirname(path: string): string {
  return dirName(path)
}

/** Join a directory and a name with exactly one `/`. */
export function joinPath(dir: string, name: string): string {
  // Match the separator style already present in `dir`, so a Windows tree
  // path is never rewritten into a mixed spelling.
  return joinPathOf(dir, name)
}

/**
 * Decide whether dropping `dragPath` onto `targetPath` is a legal move.
 *
 * Rules:
 * - The source must be a known row (can only drag what the tree shows).
 * - Dropping a node onto itself is a rejected no-op (`self`).
 * - A directory cannot be moved into its own subtree (`descendant`).
 * - Only the vault root or an existing directory accepts a drop (`invalid`
 *   for files/unknown targets).
 * - A destination that already exists at the new location is a `conflict`
 *   (the `rename_entry` backend would refuse it; catch it up front).
 * - A destination equal to the source is a no-op reposition (`self`).
 */
export function resolveDropTarget(
  rows: DropRow[],
  dragPath: string,
  targetPath: string,
  rootPath?: string,
): DropResult {
  const from = dragPath
  const drag = rows.find((r) => r.path === dragPath)
  if (!drag) {
    return { ok: false, reason: 'invalid', from, to: null }
  }

  // Dropping a node onto itself: nothing to do.
  if (targetPath === dragPath) {
    return { ok: false, reason: 'self', from, to: null }
  }

  // A directory must never be moved inside a location it already contains.
  // Either separator: row paths are native, so on Windows a '/' suffix test
  // never matched and dropping a folder into its own descendant was allowed.
  if (targetPath.startsWith(`${dragPath}/`) || targetPath.startsWith(`${dragPath}\\`)) {
    return { ok: false, reason: 'descendant', from, to: null }
  }

  // Only directories (and the vault root, itself a dir) accept a drop.
  const target = rows.find((r) => r.path === targetPath)
  if (!target || !target.isDir) {
    return { ok: false, reason: 'invalid', from, to: null }
  }

  const name = basename(dragPath)
  // Always build the destination as an absolute path (the same space `from`
  // and the row paths live in). Dropping onto the vault root re-parents the
  // entry to the root, so the destination is `<rootPath>/<name>`.
  const to = rootPath !== undefined && targetPath === rootPath
    ? joinPath(rootPath, name)
    : joinPath(targetPath, name)

  // Relocating to the place it already lives (e.g. dragging a root file who
  // lives at root onto the root row) — no-op.
  if (to === from) {
    return { ok: false, reason: 'self', from, to: null }
  }

  // The destination already exists among the visible nodes.
  if (rows.some((r) => r.path === to)) {
    return { ok: false, reason: 'conflict', from, to: null }
  }

  return { ok: true, reason: 'ok', from, to }
}
