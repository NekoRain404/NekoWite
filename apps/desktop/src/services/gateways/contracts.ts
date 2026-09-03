export interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  is_mdx: boolean
}

export interface FsChangeEvent {
  path: string
  kind: string
}

export interface TrashEntry {
  name: string
  trash_path: string
  original_path: string
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

export interface FsGateway {
  read(vault: string, path: string): Promise<string>
  stat(vault: string, path: string): Promise<FileStat>
  write(vault: string, path: string, content: string, maxHistory?: number): Promise<void>
  list(vault: string, dir: string): Promise<FileEntry[]>
  searchNotes(vault: string, query: string): Promise<FileEntry[]>
  watch(vault: string): Promise<void>
  openFolderDialog(): Promise<string | null>
  saveFileDialog(defaultName: string, startDir?: string): Promise<string | null>
  onFsChange(cb: (e: FsChangeEvent) => void): Promise<() => void>
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
  /** Turn a vault-relative attachment path into a URL usable as <img src>. */
  resolveMediaPath(vault: string, relPath: string): Promise<string>
  /** Create a directory (with parents) inside the vault; returns its
   * vault-relative path. */
  createDir(vault: string, path: string): Promise<string>
  /** Rename (move) a file or directory within the vault; returns the new
   * vault-relative path. */
  renameEntry(vault: string, from: string, to: string): Promise<string>
}

export interface AiGateway {
  complete(config: unknown, prompt: string, images?: string[]): Promise<void>
  cancel(id: string): Promise<void>
  listModels(config: unknown): Promise<string[]>
}

export interface KeyGateway {
  storeAiKey(provider: string, key: string): Promise<void>
  loadAiKey(provider: string): Promise<string | null>
}

export interface AppGateways {
  fs: FsGateway
  ai: AiGateway
  keys: KeyGateway
}
