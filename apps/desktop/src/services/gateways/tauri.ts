import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  AiGateway,
  FileEntry,
  FsChangeEvent,
  FsGateway,
  KeyGateway,
} from './contracts'

export const tauriFsGateway: FsGateway = {
  read: (vault, path) => invoke<string>('read_file', { vault_root: vault, path }),
  write: (vault, path, content) =>
    invoke<void>('write_file', { vault_root: vault, path, content }),
  list: (vault, dir) => invoke<FileEntry[]>('list_dir', { vault_root: vault, path: dir }),
  watch: (vault) => invoke<void>('watch_folder', { vault_root: vault, path: null }),
  openFolderDialog: () => invoke<string | null>('open_folder_dialog'),
  saveFileDialog: (defaultName, startDir) =>
    invoke<string | null>('save_file_dialog', {
      default_name: defaultName,
      start_dir: startDir ?? null,
    }),
  onFsChange: (cb) => listen<FsChangeEvent>('fs-change', (e) => cb(e.payload)),
}

export const tauriAiGateway: AiGateway = {
  complete: (config, prompt) => invoke<void>('ai_complete', { config, prompt }),
  cancel: (id) => invoke<void>('ai_cancel', { id }),
}

export const tauriKeyGateway: KeyGateway = {
  storeAiKey: (provider, key) => invoke<void>('store_ai_key', { provider, key }),
  loadAiKey: (provider) => invoke<string | null>('load_ai_key', { provider }),
}
