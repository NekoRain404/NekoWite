/**
 * The memory fs's trash: parking a deleted note, listing what is parked, putting
 * one back, and emptying the lot.
 *
 * A deletion MOVES the content here rather than dropping it, which is what lets
 * `restoreFromTrash` hand back the file that was deleted instead of an empty
 * one. The key comes from {@link encode} — the mirror of the Rust
 * `encode_rel_path` — so an entry names the path it came from, and deleting the
 * same path twice gets a timestamped key rather than overwriting the entry
 * already parked under it.
 *
 * The maps are taken rather than owned, as in `memory-attachments.ts`: the vault
 * map is the same one every area of the gateway operates on — a delete removes
 * from it and a restore writes back into it — so it belongs to the gateway that
 * composes the areas.
 */

import type { FsPort, TrashEntry } from './contracts'

/** The four {@link FsPort} members this area implements. */
export type TrashArea = Pick<
  FsPort,
  'deleteFile' | 'listTrash' | 'restoreFromTrash' | 'clearTrash'
>

/** A parked file: the port's {@link TrashEntry} plus the content a restore puts
 *  back. Part of {@link TrashAreaDeps}, so the gateway that owns the map names
 *  it too. */
export interface TrashItem extends TrashEntry {
  content: string
}

export interface TrashAreaDeps {
  /** Every key in the vault — notes and attachments alike. */
  files: Map<string, string>
  /** Parked files by trash key, with the content a restore puts back. */
  trash: Map<string, TrashItem>
}

/** Mirrors the Rust `encode_rel_path` so trash/history keys stay pure and
 * readable: `/` becomes `__`, a leading dot run is dropped, and an interior
 * `..` run collapses to `_` (no path traversal can leak into a key). */
function encode(p: string): string {
  let out = ''
  for (const c of p) {
    if (c === '/') {
      out += '__'
    } else if (c === '.') {
      if (out === '') {
        // leading dot dropped
      } else if (out.endsWith('.')) {
        out = out.slice(0, -1) + '_'
      } else {
        out += '.'
      }
    } else {
      out += c
    }
  }
  while (out.endsWith('.')) out = out.slice(0, -1)
  return out === '' ? '_' : out
}

export function createTrashArea(deps: TrashAreaDeps): TrashArea {
  return {
    deleteFile: async (_vault, path) => {
      const content = deps.files.get(path)
      if (content === undefined) {
        throw new Error(`No such file in demo vault: ${path}`)
      }
      deps.files.delete(path)
      let name = encode(path)
      if (deps.trash.has(name)) {
        name = `${name}-${Date.now()}`
      }
      deps.trash.set(name, {
        name,
        display_name: path.replace(/\\/g, '/').split('/').pop() || name,
        trash_path: name,
        original_path: path,
        is_dir: false,
        content,
      })
      return name
    },
    listTrash: async () =>
      [...deps.trash.values()]
        .map(({ name, display_name, trash_path, original_path, is_dir }) => ({
          name,
          display_name,
          trash_path,
          original_path,
          is_dir,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    restoreFromTrash: async (_vault, trashPath) => {
      const entry = deps.trash.get(trashPath)
      if (!entry) {
        throw new Error(`No such file in trash: ${trashPath}`)
      }
      if (deps.files.has(entry.original_path)) {
        throw new Error(`Cannot restore: ${entry.original_path} already exists`)
      }
      deps.files.set(entry.original_path, entry.content)
      deps.trash.delete(trashPath)
      return entry.original_path
    },
    clearTrash: async () => {
      // The in-memory fs never has a locked file, so a pass is always total;
      // the report shape is still the port contract.
      const removed = deps.trash.size
      deps.trash.clear()
      return { removed, failed: [] }
    },
  }
}
