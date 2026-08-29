import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'

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

export const fsService = {
  read: (path: string) => invoke<string>('read_file', { path }),
  write: (path: string, content: string) => invoke<void>('write_file', { path, content }),
  list: (dir: string) => invoke<FileEntry[]>('list_dir', { path: dir }),
  watch: (dir: string) => invoke<void>('watch_folder', { path: dir }),
  openFolderDialog: () => invoke<string | null>('open_folder_dialog'),
  onFsChange: (cb: (e: FsChangeEvent) => void): Promise<UnlistenFn> =>
    listen<FsChangeEvent>('fs-change', (e) => cb(e.payload)),
}