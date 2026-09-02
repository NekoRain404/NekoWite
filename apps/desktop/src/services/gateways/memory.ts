import type {
  AiGateway,
  FileEntry,
  FsGateway,
  HistoryEntry,
  KeyGateway,
  TrashEntry,
} from './contracts'

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
      const dirs = new Set<string>()
      const fileKeys = new Map<string, string>()
      for (const key of files.keys()) {
        if (!key.startsWith(prefix) || isHiddenKey(key)) continue
        const rest = key.slice(prefix.length)
        if (rest === '') continue
        const [seg] = rest.split('/')
        if (rest.includes('/')) dirs.add(seg)
        else fileKeys.set(seg, key)
      }
      const entries: FileEntry[] = []
      for (const name of dirs) {
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
    watch: async () => undefined,
    openFolderDialog: async () => 'memoir://demo',
    saveFileDialog: async () => null,
    onFsChange: () => Promise.resolve(() => undefined),
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
