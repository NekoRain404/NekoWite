/**
 * The vault feature's public API.
 *
 * Nothing outside this feature imports one of its files by path (§13.11): a
 * caller goes through this entry point, so the internal layout
 * (components / composables / services) can change without touching a call
 * site, and two features cannot reach into each other's internals.
 *
 * Only what a caller genuinely uses is exported. `FileTreeRow` and
 * `FileTreeContextMenu` are deliberately absent: they are parts of `FileTree`,
 * not an API, and a second consumer of a row would have to argue for itself.
 */

export { default as FileTree } from './components/FileTree.vue'

export { useFileTree } from './composables/useFileTree'
export type { FileTreeFlatRow, FileTreeNode, UseFileTreeOptions } from './composables/useFileTree'

export { useFileTreeRename } from './composables/useFileTreeRename'
export type { EditTarget, TreeEdit, UseFileTreeRenameOptions } from './composables/useFileTreeRename'

export { useFileTreeDrag } from './composables/useFileTreeDrag'
export type { UseFileTreeDragOptions } from './composables/useFileTreeDrag'

export { createVaultFileActions, validateEntryName } from './services/vault-file-actions'
export type {
  VaultActionFailure,
  VaultActionResult,
  VaultDeleteResult,
  VaultDeleteTabPort,
  VaultFileActionPorts,
  VaultFileActions,
  VaultFileIo,
  VaultNameError,
} from './services/vault-file-actions'
