import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  AiGateway,
  FileEntry,
  FileStat,
  FsChangeEvent,
  FsGateway,
  HistoryEntry,
  KeyGateway,
  TrashEntry,
} from './contracts'

export const tauriFsGateway: FsGateway = {
  read: (vault, path) => invoke<string>('read_file', { vault_root: vault, path }),
  stat: (vault, path) => invoke<FileStat>('stat_file', { vault_root: vault, path }),
  write: (vault, path, content, maxHistory) =>
    invoke<void>('write_file', {
      vault_root: vault,
      path,
      content,
      max_history: maxHistory ?? null,
    }),
  list: (vault, dir) => invoke<FileEntry[]>('list_dir', { vault_root: vault, path: dir }),
  searchNotes: (vault, query) =>
    invoke<FileEntry[]>('search_notes', { vault_root: vault, query }),
  watch: (vault) => invoke<void>('watch_folder', { vault_root: vault, path: null }),
  openFolderDialog: () => invoke<string | null>('open_folder_dialog'),
  saveFileDialog: (defaultName, startDir) =>
    invoke<string | null>('save_file_dialog', {
      default_name: defaultName,
      start_dir: startDir ?? null,
    }),
  onFsChange: (cb) => listen<FsChangeEvent>('fs-change', (e) => cb(e.payload)),
  deleteFile: (vault, path) =>
    invoke<string>('delete_file', { vault_root: vault, path }),
  listTrash: (vault) => invoke<TrashEntry[]>('list_trash', { vault_root: vault }),
  restoreFromTrash: (vault, trashPath) =>
    invoke<string>('restore_from_trash', { vault_root: vault, trash_path: trashPath }),
  listHistory: (vault, path) =>
    invoke<HistoryEntry[]>('list_history', { vault_root: vault, path }),
  readHistory: (vault, path, id) =>
    invoke<string>('read_history', { vault_root: vault, path, id }),
  restoreHistory: (vault, path, id) =>
    invoke<string>('restore_history', { vault_root: vault, path, id }),
  saveAttachment: (vault, fileName, base64) =>
    invoke<string>('save_attachment', { vault, fileName, base64 }),
  resolveMediaPath: async (vault, relPath) => {
    const absolute = await invoke<string>('resolve_media_path', { vault, relPath })
    return convertFileSrc(absolute)
  },
  createDir: (vault, path) => invoke<string>('create_dir', { vault, path }),
  renameEntry: (vault, from, to) => invoke<string>('rename_entry', { vault, from, to }),
}

export const tauriAiGateway: AiGateway = {
  complete: (config, prompt) => invoke<void>('ai_complete', { config, prompt }),
  cancel: (id) => invoke<void>('ai_cancel', { id }),
}

export const tauriKeyGateway: KeyGateway = {
  storeAiKey: (provider, key) => invoke<void>('store_ai_key', { provider, key }),
  loadAiKey: (provider) => invoke<string | null>('load_ai_key', { provider }),
}
