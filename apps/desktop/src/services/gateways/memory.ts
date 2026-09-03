import type {
  AiGateway,
  FileEntry,
  FsGateway,
  HistoryEntry,
  KeyGateway,
  TrashEntry,
} from './contracts'
import { attachmentMonthDir, mimeFromExtension } from '../attachments'

const DEFAULT_SEED: Record<string, string> = {
  'welcome.md':
    '# Welcome to NekoWite (demo)\n\nThis is the in-browser demo vault.',
}

interface Snapshot extends HistoryEntry {
  content: string
}

interface TrashItem extends TrashEntry {
  content: string
}

// Mirrors the Rust `encode_rel_path` so trash/history keys stay pure and
// readable: `/` becomes `__`, a leading dot run is dropped, and an interior
// `..` run collapses to `_` (no path traversal can leak into a key).
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

export function createMemoryFsGateway(
  seed: Record<string, string> = DEFAULT_SEED,
): FsGateway {
  const files = new Map(Object.entries(seed))
  const attachments = new Map<string, string>()
  const virtualDirs = new Set<string>()
  const history = new Map<string, Snapshot[]>()
  const trash = new Map<string, TrashItem>()
  const modified = new Map<string, number>()
  let idSeq = 0

  function snapshot(path: string, oldContent: string, maxHistory?: number): void {
    const max = maxHistory ?? 10
    const list = history.get(path) ?? []
    idSeq += 1
    list.push({
      id: `${Date.now()}-${idSeq}`,
      size: oldContent.length,
      mtime: Date.now(),
      content: oldContent,
    })
    while (list.length > max) list.shift()
    history.set(path, list)
  }

  function normalizeDir(dir: string): string {
    if (dir === '.' || dir === '' || dir === 'memoir://demo') return ''
    if (dir.startsWith('memoir://demo/')) return dir.slice('memoir://demo/'.length)
    return dir.replace(/\/+$/, '')
  }

  function isHiddenKey(key: string): boolean {
    return key.split('/').some((seg) => seg.startsWith('.'))
  }

  return {
    read: async (_vault, path) => {
      const content = files.get(path)
      if (content === undefined) {
        throw new Error(`No such file in demo vault: ${path}`)
      }
      return content
    },
    write: async (_vault, path, content, maxHistory) => {
      const old = files.get(path)
      if (old !== undefined && old !== '' && old !== content) {
        snapshot(path, old, maxHistory)
      }
      files.set(path, content)
      modified.set(path, Date.now())
    },
    stat: async (_vault, path) => {
      const content = files.get(path)
      if (content === undefined) {
        throw new Error(`No such file in demo vault: ${path}`)
      }
      return { size: content.length, mtime: modified.get(path) ?? 0 }
    },
    deleteFile: async (_vault, path) => {
      const content = files.get(path)
      if (content === undefined) {
        throw new Error(`No such file in demo vault: ${path}`)
      }
      files.delete(path)
      let name = encode(path)
      if (trash.has(name)) {
        name = `${name}-${Date.now()}`
      }
      trash.set(name, { name, trash_path: name, original_path: path, content })
      return name
    },
    listTrash: async () =>
      [...trash.values()]
        .map(({ name, trash_path, original_path }) => ({ name, trash_path, original_path }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    restoreFromTrash: async (_vault, trashPath) => {
      const entry = trash.get(trashPath)
      if (!entry) {
        throw new Error(`No such file in trash: ${trashPath}`)
      }
      if (files.has(entry.original_path)) {
        throw new Error(`Cannot restore: ${entry.original_path} already exists`)
      }
      files.set(entry.original_path, entry.content)
      trash.delete(trashPath)
      return entry.original_path
    },
    listHistory: async (_vault, path) =>
      [...(history.get(path) ?? [])]
        .reverse()
        .map(({ id, size, mtime }) => ({ id, size, mtime })),
    readHistory: async (_vault, path, id) => {
      const snap = (history.get(path) ?? []).find((s) => s.id === id)
      if (!snap) {
        throw new Error(`No history snapshot ${id} for ${path}`)
      }
      return snap.content
    },
    restoreHistory: async (_vault, path, id) => {
      const snap = (history.get(path) ?? []).find((s) => s.id === id)
      if (!snap) {
        throw new Error(`No history snapshot ${id} for ${path}`)
      }
      files.set(path, snap.content)
      return snap.content
    },
    list: async (_vault, dir) => {
      const base = normalizeDir(dir)
      const prefix = base === '' ? '' : `${base}/`
      const derivedDirs = new Set<string>()
      const fileKeys = new Map<string, string>()
      for (const key of files.keys()) {
        if (!key.startsWith(prefix) || isHiddenKey(key)) continue
        const rest = key.slice(prefix.length)
        if (rest === '') continue
        const [seg] = rest.split('/')
        if (rest.includes('/')) derivedDirs.add(seg)
        else fileKeys.set(seg, key)
      }
      for (const explicit of virtualDirs) {
        if (explicit === base || !explicit.startsWith(prefix)) continue
        const rest = explicit.slice(prefix.length)
        if (rest !== '') derivedDirs.add(rest.split('/')[0])
      }
      const entries: FileEntry[] = []
      for (const name of derivedDirs) {
        entries.push({
          name,
          path: base === '' ? name : `${base}/${name}`,
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
    searchNotes: async (_vault, query) => {
      const q = query.trim().toLowerCase()
      if (q === '') return []
      const out: FileEntry[] = []
      for (const key of files.keys()) {
        if (out.length >= 100) break
        if (isHiddenKey(key) || !/\.(md|mdx|markdown)$/i.test(key)) continue
        if (key.toLowerCase().includes(q)) {
          out.push({
            name: key.split('/').pop() ?? key,
            path: key,
            is_dir: false,
            is_mdx: true,
          })
        }
      }
      return out
    },
    watch: async () => undefined,
    openFolderDialog: async () => 'memoir://demo',
    saveFileDialog: async () => null,
    onFsChange: () => Promise.resolve(() => undefined),
    saveAttachment: async (_vault, fileName, base64) => {
      const dir = `attachments/${attachmentMonthDir()}`
      const dot = fileName.lastIndexOf('.')
      const stem = dot > 0 ? fileName.slice(0, dot) : fileName
      const ext = dot > 0 ? fileName.slice(dot) : ''
      let relPath = `${dir}/${fileName}`
      let n = 0
      while (files.has(relPath) || attachments.has(relPath)) {
        n += 1
        relPath = `${dir}/${stem}-${n}${ext}`
      }
      // Stored in the same key space as notes so list()'s virtual-directory
      // derivation surfaces the attachments tree for free.
      files.set(relPath, base64)
      attachments.set(relPath, base64)
      modified.set(relPath, Date.now())
      return relPath
    },
    resolveMediaPath: async (_vault, relPath) => {
      const base64 = attachments.get(relPath) ?? files.get(relPath)
      if (base64 === undefined) {
        throw new Error(`No such attachment in demo vault: ${relPath}`)
      }
      const ext = relPath.split('.').pop() ?? ''
      return `data:${mimeFromExtension(ext)};base64,${base64}`
    },
    createDir: async (_vault, path) => {
      const clean = path.replace(/^\/+|\/+$/g, '')
      if (clean === '' || clean.split('/').some((seg) => seg === '.' || seg === '..')) {
        throw new Error(`Invalid directory name: ${path}`)
      }
      if ([...files.keys()].some((key) => key === clean || key.startsWith(`${clean}/`))) {
        throw new Error(`Already exists: ${clean}`)
      }
      virtualDirs.add(clean)
      return clean    },
    renameEntry: async (_vault, from, to) => {
      const fromClean = from.replace(/^\/+|\/+$/g, '')
      const toClean = to.replace(/^\/+|\/+$/g, '')
      if (toClean === '' || toClean.split('/').some((seg) => seg === '.' || seg === '..')) {
        throw new Error(`Invalid target path: ${to}`)
      }
      const isDirMove = (key: string): boolean =>
        key === fromClean || key.startsWith(`${fromClean}/`)
      const moved: Array<[string, string]> = []
      for (const key of files.keys()) {
        if (isDirMove(key)) {
          const next = toClean + key.slice(fromClean.length)
          if (files.has(next)) {
            throw new Error(`Target already exists: ${next}`)
          }
          moved.push([key, next])
        }
      }
      if (moved.length === 0) {
        throw new Error(`Not found in demo vault: ${from}`)
      }
      for (const dir of [...virtualDirs]) {
        if (isDirMove(dir)) {
          virtualDirs.delete(dir)
          virtualDirs.add(toClean + dir.slice(fromClean.length))
        }
      }
      for (const [key, next] of moved) {
        files.set(next, files.get(key) ?? '')
        if (attachments.has(key)) {
          attachments.set(next, attachments.get(key) ?? '')
          attachments.delete(key)
        }
        files.delete(key)
      }
      for (const [key, next] of moved) {
        const snaps = history.get(key)
        if (snaps) {
          history.set(next, snaps)
          history.delete(key)
        }
        const mtime = modified.get(key)
        if (mtime !== undefined) {
          modified.set(next, mtime)
          modified.delete(key)
        }
      }
      return toClean
    },
  }
}

export const memoryFsGateway = createMemoryFsGateway()

export const memoryAiGateway: AiGateway = {
  complete: async () => undefined,
  cancel: async () => undefined,
}

export const memoryKeyGateway: KeyGateway = {
  storeAiKey: async () => undefined,
  loadAiKey: async () => null,
}
