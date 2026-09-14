/**
 * The memory fs's plain file operations: reading, writing, stating, the derived
 * directory listing and mkdir.
 *
 * `list` derives the directories from the keys themselves rather than from a
 * tree the adapter maintains: under the prefix, a key with a further `/` is a
 * directory and one without is a file. `virtualDirs` holds the one thing that
 * cannot be derived — a directory the user created that no note lives in yet.
 * Hidden keys (any segment starting with a dot) are skipped, which keeps `.tmp`
 * attachment staging out of the listing while `read`/`write` still reach it by
 * path.
 *
 * A write records the content it replaces through the injected `snapshot`: the
 * history is a different concern with its own module, so it is taken as a
 * dependency rather than reimplemented here.
 *
 * The maps are taken rather than owned, as in `memory-attachments.ts`: read,
 * write, rename and trash all operate on the same vault, so it belongs to the
 * gateway that composes the areas.
 */

import type { FileEntry, FsPort } from './contracts'

/** The {@link FsPort} members this area implements. `renameEntry` is not one of
 *  them: moving a path has to carry the history and the attachment bytes with
 *  it, so it stays in the gateway that holds every map. */
export type FileOpsArea = Pick<
  FsPort,
  'registerVault' | 'read' | 'write' | 'stat' | 'list' | 'watch' | 'createDir'
>

export interface FileOpsAreaDeps {
  /** Every key in the vault — notes and attachments alike. */
  files: Map<string, string>
  /** Directories that exist without a note under them. */
  virtualDirs: Set<string>
  /** Write times, so a written file stats with the time it was written. */
  modified: Map<string, number>
  /** The history area's recorder — called with the content a write replaces. */
  snapshot(path: string, oldContent: string, maxHistory?: number): void
}

function normalizeDir(dir: string): string {
  if (dir === '.' || dir === '' || dir === 'memoir://demo') return ''
  if (dir.startsWith('memoir://demo/')) return dir.slice('memoir://demo/'.length)
  return dir.replace(/\/+$/, '')
}

function isHiddenKey(key: string): boolean {
  return key.split('/').some((seg) => seg.startsWith('.'))
}

export function createFileOpsArea(deps: FileOpsAreaDeps): FileOpsArea {
  return {
    registerVault: async () => {},
    read: async (_vault, path) => {
      const content = deps.files.get(path)
      if (content === undefined) {
        throw new Error(`No such file in demo vault: ${path}`)
      }
      return content
    },
    write: async (_vault, path, content, maxHistory) => {
      const old = deps.files.get(path)
      if (old !== undefined && old !== '' && old !== content) {
        deps.snapshot(path, old, maxHistory)
      }
      deps.files.set(path, content)
      deps.modified.set(path, Date.now())
      // The in-memory gateway has no separate history backend that could fail,
      // so there is never a warning to report.
      return null
    },
    stat: async (_vault, path) => {
      const content = deps.files.get(path)
      if (content === undefined) {
        throw new Error(`No such file in demo vault: ${path}`)
      }
      return { size: content.length, mtime: deps.modified.get(path) ?? 0 }
    },
    list: async (_vault, dir) => {
      const baseDir = normalizeDir(dir)
      const prefix = baseDir === '' ? '' : `${baseDir}/`
      const derivedDirs = new Set<string>()
      const fileKeys = new Map<string, string>()
      for (const key of deps.files.keys()) {
        if (!key.startsWith(prefix) || isHiddenKey(key)) continue
        const rest = key.slice(prefix.length)
        if (rest === '') continue
        const [seg] = rest.split('/')
        if (rest.includes('/')) derivedDirs.add(seg)
        else fileKeys.set(seg, key)
      }
      for (const explicit of deps.virtualDirs) {
        if (explicit === baseDir || !explicit.startsWith(prefix)) continue
        const rest = explicit.slice(prefix.length)
        if (rest !== '') derivedDirs.add(rest.split('/')[0])
      }
      const entries: FileEntry[] = []
      for (const name of derivedDirs) {
        entries.push({
          name,
          path: baseDir === '' ? name : `${baseDir}/${name}`,
          is_dir: true,
          is_mdx: false,
        })
      }
      for (const [name, key] of fileKeys) {
        entries.push({
          name,
          path: key,
          is_dir: false,
          is_mdx: /\.(md|mdx)$/i.test(name),
        })
      }
      return entries.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    },
    watch: async () => undefined,
    createDir: async (_vault, path) => {
      const clean = path.replace(/^\/+|\/+$/g, '')
      if (clean === '' || clean.split('/').some((seg) => seg === '.' || seg === '..')) {
        throw new Error(`Invalid directory name: ${path}`)
      }
      if ([...deps.files.keys()].some((key) => key === clean || key.startsWith(`${clean}/`))) {
        throw new Error(`Already exists: ${clean}`)
      }
      deps.virtualDirs.add(clean)
      return clean
    },
  }
}
