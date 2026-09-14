/**
 * The memory fs's version history: the snapshots a write keeps of the content
 * it replaces.
 *
 * `write` decides when a version is worth keeping — not for a first write
 * (there is no earlier content), not for an empty file, and not for a write
 * that changes nothing, because a history full of identical copies would bury
 * the version the user does want back — and this area records what it is handed.
 * The list is pruned to `maxHistory` (the caller's, else 10) keeping the newest,
 * `listHistory` reports it newest-first, which is the order the history panel
 * reads, and `readHistory`/`restoreHistory` take the id it handed out.
 *
 * The maps are taken rather than owned, as in `memory-attachments.ts`: snapshots
 * and notes are the same vault, so `renameEntry` moves a path's history along
 * with the file and the map belongs to the gateway that composes the areas.
 */

import type { FsPort, HistoryEntry } from './contracts'

/**
 * The three {@link FsPort} members this area implements, plus the recorder the
 * file area's `write` calls. The recorder is the write-side entry point rather
 * than a port member, so the gateway keeps it off its own surface — see
 * `createMemoryFsGateway`.
 */
export type HistoryArea = Pick<FsPort, 'listHistory' | 'readHistory' | 'restoreHistory'> & {
  /** Record `oldContent` as `path`'s newest snapshot, pruning to `maxHistory`. */
  snapshot(path: string, oldContent: string, maxHistory?: number): void
}

/** One version of a file: the port's {@link HistoryEntry} plus the content it
 *  held. Part of {@link HistoryAreaDeps}, so the gateway that owns the map
 *  names it too. */
export interface Snapshot extends HistoryEntry {
  content: string
}

export interface HistoryAreaDeps {
  /** Every key in the vault — notes and attachments alike. */
  files: Map<string, string>
  /** Snapshots by vault path, oldest first. */
  history: Map<string, Snapshot[]>
}

export function createHistoryArea(deps: HistoryAreaDeps): HistoryArea {
  // Ids only have to be unique within one gateway's history, and the clock is
  // the part a user reads: the counter breaks a same-millisecond tie between two
  // writes, which is as much as they can collide.
  let idSeq = 0

  function snapshot(path: string, oldContent: string, maxHistory?: number): void {
    const max = maxHistory ?? 10
    const list = deps.history.get(path) ?? []
    idSeq += 1
    list.push({
      id: `${Date.now()}-${idSeq}`,
      size: oldContent.length,
      mtime: Date.now(),
      content: oldContent,
    })
    while (list.length > max) list.shift()
    deps.history.set(path, list)
  }

  return {
    listHistory: async (_vault, path) =>
      [...(deps.history.get(path) ?? [])]
        .reverse()
        .map(({ id, size, mtime }) => ({ id, size, mtime })),
    readHistory: async (_vault, path, id) => {
      const snap = (deps.history.get(path) ?? []).find((s) => s.id === id)
      if (!snap) {
        throw new Error(`No history snapshot ${id} for ${path}`)
      }
      return snap.content
    },
    restoreHistory: async (_vault, path, id) => {
      const snap = (deps.history.get(path) ?? []).find((s) => s.id === id)
      if (!snap) {
        throw new Error(`No history snapshot ${id} for ${path}`)
      }
      deps.files.set(path, snap.content)
      return snap.content
    },
    snapshot,
  }
}
