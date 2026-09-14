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

export { useFileTree } from './composables/use-file-tree'
export type { FileTreeFlatRow, FileTreeNode, UseFileTreeOptions } from './composables/use-file-tree'

export { useFileTreeRename } from './composables/use-file-tree-rename'
export type { EditTarget, TreeEdit, UseFileTreeRenameOptions } from './composables/use-file-tree-rename'

export { useFileTreeDrag } from './composables/use-file-tree-drag'
export type { UseFileTreeDragOptions } from './composables/use-file-tree-drag'

/**
 * The link queries over the indexed notes. The notes panel resolves its links
 * mode with them (§13.11), which is why they are exported here rather than
 * reached for by path: the index that answers them belongs to this feature, and
 * its internals stay this feature's business.
 */
export { inlinksOf, outlinksOf } from './services/library-queries'

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

/* The coordinator's handle. The vault session store holds one for the life of a
 * vault and calls into it; the coordinator is built by this feature's wiring, so
 * the store needs the type and not the factory. */
export type { VaultIndexCoordinator } from './services/vault-index'
