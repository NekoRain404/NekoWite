/**
 * Gateway ports (contracts).
 *
 * This module is the dependency boundary between the application/feature layer
 * and the platform adapters. It knows nothing about Tauri, Vue, the browser DOM
 * or business rules. A port is a narrow capability; the adapters
 * (`tauri.ts`, `memory.ts`, the event adapters) implement the same interface
 * with the same error surface so an application service can run against a real
 * backend or an in-memory test double interchangeably.
 *
 * Direction (see docs/dev.md §5.3):
 *   UI → composable/store → service → gateway → platform
 * `platform` must never import back into `services`, `features` or `stores`.
 */

export interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  is_mdx: boolean
}

/**
 * The watcher vocabulary, spelled exactly as the Rust `watch_folder` command
 * emits it. This used to be a bare `string`, which let consumers test for
 * `'remove'` while the backend sent `'removed'`: the branch never ran and a
 * deleted note kept its cache and its persistent index entry. A union makes a
 * mismatched literal a compile error instead of a silent no-op.
 */
export type FsChangeKind = 'created' | 'modified' | 'removed'

export interface FsChangeEvent {
  path: string
  kind: FsChangeKind
}

export interface TrashEntry {
  /** The on-disk key inside the trash (percent-encoded); what restore needs. */
  name: string
  /**
   * The file's own name, decoded from the key. The trash key is not what the
   * user deleted (`docs%2Fa.md` for `docs/a.md`), and a collision key carries a
   * timestamp that is not part of the name either, so the label is computed
   * once on the Rust side rather than guessed per surface.
   */
  display_name: string
  trash_path: string
  original_path: string
  /** A deleted folder is listed too, and restores with its contents. */
  is_dir: boolean
}

export interface HistoryEntry {
  id: string
  size: number
  mtime: number
}

export interface FileStat {
  size: number
  mtime: number
}

/** Filesystem operations, confined to an authorized vault root. */
export interface FsPort {
  /** Authorize a vault root with the backend before issuing any path-confined
   * command. The Rust path-confined commands reject any root that was not
   * registered this session, so this must run before the first read/list. */
  registerVault(vault: string): Promise<void>
  read(vault: string, path: string): Promise<string>
  stat(vault: string, path: string): Promise<FileStat>
  write(vault: string, path: string, content: string, maxHistory?: number): Promise<void>
  list(vault: string, dir: string): Promise<FileEntry[]>
  searchNotes(vault: string, query: string): Promise<FileEntry[]>
  watch(vault: string): Promise<void>
  deleteFile(vault: string, path: string): Promise<string>
  listTrash(vault: string): Promise<TrashEntry[]>
  restoreFromTrash(vault: string, trashPath: string): Promise<string>
  /** Permanently delete every entry in the trash; returns how many were removed. */
  clearTrash(vault: string): Promise<number>
  listHistory(vault: string, path: string): Promise<HistoryEntry[]>
  readHistory(vault: string, path: string, id: string): Promise<string>
  restoreHistory(vault: string, path: string, id: string): Promise<string>
  /** Persist attachment bytes (base64) and return the vault-relative path it
   * was stored at. `dir` is an optional vault-relative target directory (e.g.
   * `notes/foo_assets` or `.tmp`); when omitted the legacy
   * `attachments/{YYYY-MM}` layout is used. */
  saveAttachment(vault: string, fileName: string, base64: string, dir?: string): Promise<string>
  /** Copy an image the user picked from disk into the vault, returning its
   * vault-relative path. `sourcePath` is an absolute path returned by
   * {@link DialogPort.pickImageFiles}; the bytes never cross the IPC boundary.
   * `dir` is the optional vault-relative target directory. */
  importAttachment(vault: string, sourcePath: string, dir?: string): Promise<string>
  /** Turn a vault-relative attachment path into a URL usable as <img src>. */
  resolveMediaPath(vault: string, relPath: string): Promise<string>
  /** Create a directory (with parents) inside the vault; returns its
   * vault-relative path. */
  createDir(vault: string, path: string): Promise<string>
  /** Rename (move) a file or directory within the vault; returns the new
   * vault-relative path. */
  renameEntry(vault: string, from: string, to: string): Promise<string>
}

/** Native (or simulated) open/save file dialogs. */
export interface DialogPort {
  openFolderDialog(): Promise<string | null>
  saveFileDialog(defaultName: string, startDir?: string): Promise<string | null>
  /** Native multi-select image picker. Returns the absolute paths chosen, or an
   * empty array when the dialog was cancelled. */
  pickImageFiles(): Promise<string[]>
}

/**
 * Subscribe/publish application events (fs changes, AI stream lifecycle, ...).
 *
 * `on` delivers the event *payload* directly — never a platform envelope — so a
 * business service that consumes `ai-chunk` sees `{ id, text }`, not
 * `{ payload: { id, text } }`. Cancellation is `await on(...)` then calling the
 * returned unsubscribe (or awaiting the Promise and discarding it upfront).
 */
export interface EventPort {
  on<T>(event: string, cb: (payload: T) => void): Promise<() => void>
  emit<T>(event: string, payload: T): Promise<void>
}

export interface AiPort {
  /**
   * Start a streaming completion. `id` identifies the request for every event
   * (`ai-chunk` / `ai-reasoning` / `ai-done` / `ai-error`) and for
   * {@link cancel}: the CALLER picks it, because a reasoning model can stay
   * silent for seconds and a backend-chosen id would leave nothing to cancel
   * during that window.
   */
  complete(config: unknown, prompt: string, images?: string[], id?: string): Promise<void>
  cancel(id: string): Promise<void>
  listModels(config: unknown): Promise<string[]>
}

export interface KeyPort {
  storeAiKey(provider: string, key: string): Promise<void>
  loadAiKey(provider: string): Promise<string | null>
}

/**
 * The composite gateway a runtime assembles from the ports above.
 *
 * `.fs` keeps the legacy combined shape (fs ops + dialogs + the `onFsChange`
 * subscription) so un-migrated callers keep resolving; new code should depend
 * on the narrow ports directly — use `.dialogs` for dialogs and `.events` for
 * event subscriptions instead of the members still exposed on `.fs`.
 */
export interface AppGateways {
  fs: FsGateway
  dialogs: DialogPort
  events: EventPort
  ai: AiPort
  keys: KeyPort
}

// Backward-compat names: the original FsGateway conflated fs ops, dialogs and
// the fs-change listener. New code uses FsPort / DialogPort / EventPort.
export type FsGateway = FsPort &
  DialogPort & {
    onFsChange(cb: (e: FsChangeEvent) => void): Promise<() => void>
  }

// Rename aliases kept for a type-only transition period (nothing external uses
// these yet, but a manual `export type` keeps module resolution stable).
export type AiGateway = AiPort
export type KeyGateway = KeyPort
