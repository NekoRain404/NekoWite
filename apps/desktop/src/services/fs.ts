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
  read: (vault: string, path: string) =>
    invoke<string>('read_file', { vault_root: vault, path }),
  write: (vault: string, path: string, content: string) =>
    invoke<void>('write_file', { vault_root: vault, path, content }),
  list: (vault: string, dir: string) =>
    invoke<FileEntry[]>('list_dir', { vault_root: vault, path: dir }),
  watch: (vault: string) =>
    invoke<void>('watch_folder', { vault_root: vault, path: null }),
  openFolderDialog: () => invoke<string | null>('open_folder_dialog'),
  saveFileDialog: (defaultName: string, startDir?: string) =>
    invoke<string | null>('save_file_dialog', { default_name: defaultName, start_dir: startDir ?? null }),
  onFsChange: (cb: (e: FsChangeEvent) => void): Promise<UnlistenFn> =>
    listen<FsChangeEvent>('fs-change', (e) => cb(e.payload)),
}