/**
 * In-memory gateway adapters.
 *
 * A zero-backend implementation of the gateway ports so core application
 * services can be unit-tested (or run the browser demo) without a Tauri
 * bridge. It mirrors the Rust `encode_rel_path` keying and adds **controllable
 * failure + event simulation** so tests can exercise:
 *
 *  - *errors*: an injected `fail` map makes a named FS command reject.
 *  - *timeout*: an injected `delayMs` postpones every FS call (drive with fake
 *    timers to model a slow backend or a timed-out operation).
 *  - *cancellation*: `onFsChange` returns an unsubscribe; an emitted `fs-change`
 *    after cancelling is not delivered. The shared `events` port also drives the
 *    AI lifecycle stream so a stream can be cancelled mid-flight.
 *  - *fs-change events*: `events.emit('fs-change', { path, kind })` fans out to
 *    every current `onFsChange` subscriber.
 *
 * Every adapter is a pure closure over its own state — creating two gateways
 * yields two independent stores, so tests never leak state across instances.
 */

import type {
  AiPort,
  DialogPort,
  EventPort,
  FileEntry,
  FsChangeEvent,
  FsGateway,
  HistoryEntry,
  KeyPort,
  TrashEntry,
} from './contracts'
import { createMemoryEventAdapter } from '../events/memoryEventAdapter'

const DEFAULT_SEED: Record<string, string> = {
  'welcome.md':
    '# Welcome to NekoWite (demo)\n\nThis is the in-browser demo vault.',
}

/**
 * Picked-file payloads for the browser demo.
 *
 * The real picker returns absolute paths and the Rust side reads the bytes
 * itself, so no file content ever crosses IPC. The demo has neither a native
 * dialog nor a real filesystem: a test queues `path -> base64` here and this
 * makes `pickImageFiles` hand those paths back, which keeps the whole
 * pick -> import -> insert flow exercisable in a browser.
 */
const demoPickedFiles = new Map<string, string>()
let demoPickQueue: string[] = []

/** Queue the files the next `dialogs.pickImageFiles()` call should return. */
export function seedMemoryPickedFiles(files: Record<string, string>): void {
  for (const [path, base64] of Object.entries(files)) {
    const name = path.replace(/\\/g, '/').split('/').pop() ?? path
    demoPickedFiles.set(path, base64)
    demoPickedFiles.set(name, base64)
    demoPickQueue.push(path)
  }
}

/** Drop every queued demo pick (test isolation). */
export function resetMemoryPickedFiles(): void {
  demoPickedFiles.clear()
  demoPickQueue = []
}

// Inlined from services/attachments so `platform` never depends back on a
// service module (docs/dev.md §5.3 forbids platform → service).
const ATTACHMENT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
}

function mimeFromExtension(extension: string): string {
  return ATTACHMENT_MIME[extension.toLowerCase()] ?? 'application/octet-stream'
}

function attachmentMonthDir(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

interface Snapshot extends HistoryEntry {
  content: string
}

interface TrashItem extends TrashEntry {
  content: string
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

/** Tuning knobs for the memory FS adapter's controllable-failure simulation. */
export interface MemoryFsOptions {
  /** Fail every call to the named method (e.g. `read`, `write`, `stat`). The
   * value is a static error or a factory that builds a fresh error each call. */
  fail?: Record<string, Error | (() => Error)>
  /** Artificial latency (ms) before every FS call settles, simulating a slow
   * backend or a timed-out operation. */
  delayMs?: number
  /** Shared event bus. When supplied, `onFsChange` subscribes to it and a test
   * can simulate `fs-change` events by emitting on the same port. */
  events?: EventPort
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Wrap a built gateway so every method honors `fail`/`delayMs` first, keeping
 * the base implementation itself free of failure-injection concerns. */
function withBehavior(base: FsGateway, opts: MemoryFsOptions): FsGateway {
  if (!opts.fail && !opts.delayMs) return base
  const out = { ...base } as FsGateway
  for (const key of Object.keys(base) as (keyof FsGateway)[]) {
    const fn = base[key] as (...a: unknown[]) => unknown
    ;(out as Record<keyof FsGateway, (...a: unknown[]) => unknown>)[key] = async (...a) => {
      if (opts.delayMs) await sleep(opts.delayMs)
      const err = opts.fail?.[key]
      if (err) throw typeof err === 'function' ? err() : err
      return fn(...a)
    }
  }
  return out
}

export function createMemoryFsGateway(
  seed: Record<string, string> = DEFAULT_SEED,
  opts: MemoryFsOptions = {},
): FsGateway {
  const files = new Map(Object.entries(seed))
  const attachments = new Map<string, string>()
  const virtualDirs = new Set<string>()
  const history = new Map<string, Snapshot[]>()
  const trash = new Map<string, TrashItem>()
  const modified = new Map<string, number>()
  // The shared event bus drives simulated fs-change events. When the caller
  // hands one in (as createGateways does) `onFsChange` shares it with the rest
  // of the runtime; otherwise a private bus is created.
  const events = opts.events ?? createMemoryEventAdapter()
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

  const base: FsGateway = {
    registerVault: async () => {},
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
      // The in-memory gateway has no separate history backend that could fail,
      // so there is never a warning to report.
      return null
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
      trash.set(name, {
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
      [...trash.values()]
        .map(({ name, display_name, trash_path, original_path, is_dir }) => ({
          name,
          display_name,
          trash_path,
          original_path,
          is_dir,
        }))
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
    clearTrash: async () => {
      // The in-memory fs never has a locked file, so a pass is always total;
      // the report shape is still the port contract.
      const removed = trash.size
      trash.clear()
      return { removed, failed: [] }
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
      const baseDir = normalizeDir(dir)
      const prefix = baseDir === '' ? '' : `${baseDir}/`
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
    // Simulated native dialogs: the demo always "picks" the in-memory vault.
    openFolderDialog: async () => 'memoir://demo',
    saveFileDialog: async () => null,
    // One-shot, like the native dialog: a queued pick is consumed by the call
    // that reads it, so reopening the picker starts empty instead of
    // re-importing the previous selection.
    pickImageFiles: async () => {
      const next = demoPickQueue
      demoPickQueue = []
      return next
    },
    // Simulated fs-change subscription: emit on the shared event bus to fire it.
    onFsChange: (cb) => events.on<FsChangeEvent>('fs-change', cb),
    saveAttachment: async (_vault, fileName, base64, dir) => {
      const cleanDir = dir && dir.trim() ? dir.trim().replace(/^\/+|\/+$/g, '') : ''
      const targetDir = cleanDir || `attachments/${attachmentMonthDir()}`
      const dot = fileName.lastIndexOf('.')
      const stem = dot > 0 ? fileName.slice(0, dot) : fileName
      const ext = dot > 0 ? fileName.slice(dot) : ''
      let relPath = `${targetDir}/${fileName}`
      let n = 0
      while (files.has(relPath) || attachments.has(relPath)) {
        n += 1
        relPath = `${targetDir}/${stem}-${n}${ext}`
      }
      // Stored in the same key space as notes so list()'s virtual-directory
      // derivation surfaces the attachments tree for free.
      files.set(relPath, base64)
      attachments.set(relPath, base64)
      modified.set(relPath, Date.now())
      return relPath
    },
    // The demo has no real filesystem, so the picked "path" is the file name
    // and the payload is whatever the harness stashed for it. This mirrors the
    // real command's contract (absolute source path in, vault-relative out)
    // closely enough for the UI flow to be exercised in a browser.
    importAttachment: async (_vault, sourcePath, dir) => {
      const name = sourcePath.replace(/\\/g, '/').split('/').pop() ?? ''
      if (!name) throw new Error(`Picked file has no usable name: ${sourcePath}`)
      const payload = demoPickedFiles.get(sourcePath) ?? demoPickedFiles.get(name)
      if (payload === undefined) {
        throw new Error(`No such picked file in demo vault: ${sourcePath}`)
      }
      const cleanDir = dir && dir.trim() ? dir.trim().replace(/^\/+|\/+$/g, '') : ''
      const targetDir = cleanDir || `attachments/${attachmentMonthDir()}`
      const dot = name.lastIndexOf('.')
      const stem = dot > 0 ? name.slice(0, dot) : name
      const ext = dot > 0 ? name.slice(dot) : ''
      let relPath = `${targetDir}/${name}`
      let n = 0
      while (files.has(relPath) || attachments.has(relPath)) {
        n += 1
        relPath = `${targetDir}/${stem}-${n}${ext}`
      }
      files.set(relPath, payload)
      attachments.set(relPath, payload)
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
      return clean
    },
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

  return withBehavior(base, opts)
}

export const memoryFsGateway = createMemoryFsGateway()

/** Re-export so createGateways and tests can address the same event bus. */
export { createMemoryEventAdapter }

export interface MemoryAiOptions {
  /** Fail `complete` with this error (or a factory for a fresh one per call). */
  fail?: Error | (() => Error)
  /** Artificial latency (ms) before `complete` settles, to simulate a timeout. */
  delayMs?: number
}

export function createMemoryAiGateway(opts: MemoryAiOptions = {}): AiPort {
  return {
    // The memory port answers immediately and emits no events; the id is part
    // of the port contract for the real (streaming) gateways.
    complete: async () => {
      if (opts.delayMs) await sleep(opts.delayMs)
      const err = opts.fail
      if (err) throw typeof err === 'function' ? err() : err
    },
    cancel: async () => undefined,
    listModels: async () => [],
  }
}

export const memoryAiGateway = createMemoryAiGateway()

export const memoryKeyPort: KeyPort = {
  storeAiKey: async () => undefined,
  loadAiKey: async () => null,
}

/** A {@link DialogPort} view over a (combined) memory FS gateway. */
export function createMemoryDialogPort(fs: FsGateway): DialogPort {
  return {
    openFolderDialog: () => fs.openFolderDialog(),
    saveFileDialog: (defaultName, startDir) => fs.saveFileDialog(defaultName, startDir),
    pickImageFiles: () => fs.pickImageFiles(),
  }
}
