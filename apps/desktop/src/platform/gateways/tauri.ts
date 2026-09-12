/**
 * Tauri gateway adapters.
 *
 * This is the ONLY module that maps port calls to `@tauri-apps/api/core`'s
 * `invoke`. It contains no business logic: each method is a thin, one-line
 * command mapping. Event subscriptions live in `platform/events` (the Tauri
 * event adapter) rather than here, so this module stays a pure fs/dialog/AI/key
 * invoke translator.
 *
 * Only this file, `platform/events`, `platform/runtime` and `app/` may import
 * `@tauri-apps/api`. Business/feature/service code never does.
 */

import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import type {
  AiPort,
  DialogPort,
  FileEntry,
  FileStat,
  FsPort,
  HistoryEntry,
  KeyPort,
  TrashEntry,
} from './contracts'

export const tauriFsPort: FsPort = {
  registerVault: (vault) => invoke<void>('register_vault', { vault_root: vault }),
  read: (vault, path) => invoke<string>('read_file', { vault_root: vault, path }),
  stat: (vault, path) => invoke<FileStat>('stat_file', { vault_root: vault, path }),
  write: (vault, path, content, maxHistory) =>
    invoke<string | null>('write_file', {
      vault_root: vault,
      path,
      content,
      max_history: maxHistory ?? null,
    }),
  list: (vault, dir) => invoke<FileEntry[]>('list_dir', { vault_root: vault, path: dir }),
  searchNotes: (vault, query) =>
    invoke<FileEntry[]>('search_notes', { vault_root: vault, query }),
  watch: (vault) => invoke<void>('watch_folder', { vault_root: vault, path: null }),
  deleteFile: (vault, path) =>
    invoke<string>('delete_file', { vault_root: vault, path }),
  listTrash: (vault) => invoke<TrashEntry[]>('list_trash', { vault_root: vault }),
  restoreFromTrash: (vault, trashPath) =>
    invoke<string>('restore_from_trash', { vault_root: vault, trash_path: trashPath }),
  clearTrash: (vault) => invoke<number>('clear_trash', { vault }),
  listHistory: (vault, path) =>
    invoke<HistoryEntry[]>('list_history', { vault_root: vault, path }),
  readHistory: (vault, path, id) =>
    invoke<string>('read_history', { vault_root: vault, path, id }),
  restoreHistory: (vault, path, id) =>
    invoke<string>('restore_history', { vault_root: vault, path, id }),
  // NOTE: the Rust commands are declared #[tauri::command(rename_all =
  // "snake_case")] and @tauri-apps/api passes the JS args VERBATIM (no case
  // conversion), so the object keys MUST be the Rust parameter names
  // (`file_name`, `rel_path`, ...) — a camelCase key makes the invoke reject
  // and the image save/display silently break (real WebKitGTK-verified).
  saveAttachment: (vault, fileName, base64, dir) =>
    invoke<string>('save_attachment', { vault, file_name: fileName, base64, dir: dir ?? '' }),
  resolveMediaPath: async (vault, relPath) => {
    const absolute = await invoke<string>('resolve_media_path', { vault, rel_path: relPath })
    return convertFileSrc(absolute)
  },
  createDir: (vault, path) => invoke<string>('create_dir', { vault, path }),
  renameEntry: (vault, from, to) => invoke<string>('rename_entry', { vault, from, to }),
  importAttachment: (vault, sourcePath, dir) =>
    invoke<string>('import_attachment', { vault, source_path: sourcePath, dir: dir ?? '' }),
}

export const tauriDialogPort: DialogPort = {
  openFolderDialog: () => invoke<string | null>('open_folder_dialog'),
  saveFileDialog: (defaultName, startDir) =>
    invoke<string | null>('save_file_dialog', {
      default_name: defaultName,
      start_dir: startDir ?? null,
    }),
  pickImageFiles: () => invoke<string[]>('pick_image_files'),
}

export const tauriAiPort: AiPort = {
  complete: (config, prompt, images, id) =>
    invoke<void>('ai_complete', { config, prompt, images: images ?? [], id: id ?? null }),
  cancel: (id) => invoke<void>('ai_cancel', { id }),
  listModels: (config) => invoke<string[]>('ai_list_models', { config }),
}

export const tauriKeyPort: KeyPort = {
  storeAiKey: (provider, key) => invoke<void>('store_ai_key', { provider, key }),
  loadAiKey: (provider) => invoke<string | null>('load_ai_key', { provider }),
}
