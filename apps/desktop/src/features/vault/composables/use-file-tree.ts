/**
 * The file tree's own state: the node tree, its flattened rows, and the queries
 * the rest of the panel asks of it.
 *
 * Everything the tree knows about the vault lives here so the components stay
 * orchestration (§13.3): a row renders and forwards events, this composable
 * decides what a click means, and `services/vault-file-actions` does the disk
 * work. It also owns the tree's lifetime — the initial listing, the fs-change
 * subscription, and the reset on a vault switch.
 *
 * The store reads (tabs, appearance) live here rather than in the component:
 * §10.2 keeps a feature component off the stores, and both reads are the tree's
 * own business — which tab is active, and whether deleting still asks twice.
 *
 * `vault` arrives as a getter rather than a value because the panel switches
 * vaults under a mounted tree.
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fsService } from '../../../platform/gateways/fs'
import type { FileEntry, FsChangeEvent } from '../../../platform/gateways/fs'
import { useAppearanceStore } from '../../../stores/appearance'
import { useTabsStore } from '../../../stores/tabs'
import { notifyError } from '../../../services/errors'
import { dirName } from '../../../services/paths'
import { moveOrRepair } from '../../../services/note-move-flow'
import { noteAssetDirectoryExists } from '../../../services/note-delete'
import { t } from '../../../i18n'
import { createVaultFileActions } from '../services/vault-file-actions'
import type { VaultFileActions } from '../services/vault-file-actions'

export interface FileTreeNode {
  name: string
  path: string
  is_dir: boolean
  is_mdx: boolean
  expanded: boolean
  loading: boolean
  children: FileTreeNode[]
}

/** One visible row: a node plus the indent depth it renders at. */
export interface FileTreeFlatRow {
  node: FileTreeNode
  depth: number
}

export interface UseFileTreeOptions {
  vault: () => string
}

export function useFileTree(options: UseFileTreeOptions) {
  const tabs = useTabsStore()
  const appearance = useAppearanceStore()

  const root = ref<FileTreeNode | null>(null)
  /** The live fs-change subscription, or null when none is installed. Not a ref:
   *  only this composable reads it, and it must be reachable from the
   *  continuation that owns it (a registration can land after an await). */
  let unlisten: (() => void) | null = null
  let unmounted = false
  const confirmPath = ref<string | null>(null)
  const activePath = computed(() => tabs.activeTab?.path ?? null)
  const selectedDirPath = ref<string | null>(null)

  /** Paths whose delete is already in flight. One deliberate activation deletes
   *  once: a double-click on the trash icon (or a stray second click on the
   *  confirm button) must not start a second delete of a path that is already
   *  on its way out. */
  const deleting = new Set<string>()

  const actions: VaultFileActions = createVaultFileActions({
    io: {
      // The gateway answers with the written path (`write`) and with a status
      // string (`createDir`); the flows only care that the call did not throw.
      write: async (vault, path, content) => {
        await fsService.write(vault, path, content)
      },
      createDir: async (vault, path) => {
        await fsService.createDir(vault, path)
      },
      deleteFile: (vault, path) => fsService.deleteFile(vault, path),
      // `stat` is the existence probe the note pair-delete uses to decide
      // whether a `<name>_assets` folder has to go to the trash with its note.
      exists: (vault, path) => noteAssetDirectoryExists(fsService, vault, path),
    },
    // The shared flow, not a copy of it: it flushes pending edits, arms the
    // self-write/move claims the external-change service reads, and repairs the
    // tabs when a move fails after its rename landed.
    move: moveOrRepair,
    tabs: {
      tabIdAt: (path) => tabs.tabs.find((tab) => tab.path === path)?.id ?? null,
      deleteTabFile: (tabId) => tabs.deleteTabFile(tabId),
      // Snapshot before removing: the loop mutates the very list it walks.
      forgetTabsUnder: (path) => {
        for (const tab of [...tabs.tabs]) {
          if (tab.path && (tab.path === path || tab.path.startsWith(path + '/'))) tabs.removeTab(tab.id)
        }
      },
    },
    isDir: (path) => isDirPath(path),
  })

  function cancelDelete(): void {
    confirmPath.value = null
  }

  /**
   * Ask for `path` to be deleted.
   *
   * Deleting is the one destructive action in the tree, so by default the trash
   * icon only arms the row and the following confirm button performs the delete.
   * With "confirm before deleting" switched off that button is the whole
   * gesture: a single deliberate click on the icon, with no second question.
   */
  function requestDelete(path: string): void {
    if (!appearance.confirmBeforeDelete) {
      void confirmDelete(path)
      return
    }
    confirmPath.value = path
  }

  /**
   * Run the delete `requestDelete` asked for. The flow itself lives in
   * `services/vault-file-actions`; what stays here is the tree's side of it —
   * the single-flight guard, the armed row, and the refresh of the rows the
   * target came from.
   */
  async function confirmDelete(path: string): Promise<void> {
    if (deleting.has(path)) return
    deleting.add(path)
    try {
      const result = await actions.delete(options.vault(), path)
      if (!result.ok) {
        notifyError(t('filetree.deleteFailed'))
        return
      }
      if (result.assetsFailed) notifyError(t('filetree.deleteAssetsFailed'))
    } finally {
      deleting.delete(path)
      confirmPath.value = null
      await refreshAncestors(path)
    }
  }

  function makeNode(e: FileEntry): FileTreeNode {
    return {
      name: e.name,
      path: e.path,
      is_dir: e.is_dir,
      is_mdx: e.is_mdx,
      expanded: false,
      loading: false,
      children: [],
    }
  }

  async function listChildren(node: FileTreeNode): Promise<void> {
    if (node.loading) return
    node.loading = true
    try {
      const entries = await fsService.list(options.vault(), node.path)
      node.children = entries.filter((e) => !(e.is_dir && e.name === 'node_modules')).map(makeNode)
    } catch {
      notifyError(t('filetree.listFailed', { path: node.path }))
    } finally {
      node.loading = false
    }
  }

  function walk(node: FileTreeNode, depth: number, out: FileTreeFlatRow[]): void {
    out.push({ node, depth })
    if (node.is_dir && node.expanded) {
      for (const child of node.children) walk(child, depth + 1, out)
    }
  }

  const flat = computed(() => {
    const out: FileTreeFlatRow[] = []
    if (root.value) walk(root.value, 0, out)
    return out
  })

  const currentDirPath = computed(() => {
    const sel = selectedDirPath.value
    if (root.value && sel === root.value.path) return root.value.path
    if (sel && flat.value.some((r) => r.node.path === sel && r.node.is_dir)) return sel
    return root.value?.path ?? options.vault()
  })

  const currentDirLabel = computed(() => {
    const row = flat.value.find((r) => r.node.path === currentDirPath.value)
    return row?.node.name ?? options.vault()
  })

  async function toggle(node: FileTreeNode): Promise<void> {
    if (!node.is_dir) return
    selectedDirPath.value = node.path
    if (!node.expanded) await listChildren(node)
    node.expanded = !node.expanded
  }

  async function openFile(node: FileTreeNode): Promise<void> {
    // Only markdown/MDX documents open in a tab; other files (references
    // library, images, ...) are listed for discovery but not editor targets.
    if (node.is_dir || !node.is_mdx) return
    selectedDirPath.value = dirOf(node.path)
    await tabs.openTab(node.path)
  }

  /** Open a note in a tab (the create flow opens the file it just wrote). */
  async function openNote(path: string): Promise<void> {
    await tabs.openTab(path)
  }

  function dirOf(path: string): string {
    // Tree rows carry absolute paths in the platform's native spelling
    // (`\\?\C:\...\note.md` on Windows). A `/`-only split returned the whole
    // path, so the parent lookup never matched a directory node and RENAME
    // silently did nothing at all.
    return dirName(path)
  }

  async function refreshAncestors(path: string): Promise<void> {
    const dir = dirOf(path)
    const targets = new Set<FileTreeNode>()
    if (root.value) targets.add(root.value)
    for (const { node } of flat.value) {
      if (!node.is_dir || !node.expanded) continue
      if (dir === node.path || dir.startsWith(node.path + '/')) targets.add(node)
    }
    for (const target of targets) await listChildren(target)
  }

  /** The directory an entry belongs to — a folder is its own directory. This
   *  is where a create started from that row's menu lands, so the derivation
   *  stays here rather than in the component (§13.3). */
  function parentDirOf(node: FileTreeNode): string {
    return node.is_dir ? node.path : dirOf(node.path)
  }

  function findDirNode(path: string): FileTreeNode | null {
    if (root.value && root.value.path === path) return root.value
    for (const row of flat.value) {
      if (row.node.is_dir && row.node.path === path) return row.node
    }
    return null
  }

  async function ensureDirNode(path: string): Promise<FileTreeNode | null> {
    const node = findDirNode(path)
    if (!node) return null
    if (!node.expanded) {
      await listChildren(node)
      node.expanded = true
    }
    return node
  }

  /** True when the tree row at `path` is a folder. The trash icon is offered on
   *  every row, and a folder must NOT go through the note pair-delete: a folder
   *  delete already carries its whole subtree (so a nested `_assets` folder
   *  needs no special handling), and treating its name as a note's would aim a
   *  second delete at an unrelated `<foldername>_assets` sibling. */
  function isDirPath(path: string): boolean {
    if (root.value?.path === path) return true
    return flat.value.some((row) => row.node.path === path && row.node.is_dir)
  }

  async function handleFsChange(e: FsChangeEvent): Promise<void> {
    // Reloading the OPEN document is handled at the app level (see
    // `services/externalDocSync`), because the tree only exists while the
    // Folders panel is shown — the Notes panel (the default view) had no
    // watcher at all, so external edits went unnoticed. What is left here is the
    // tree's own concern: refreshing the rows that changed.
    await refreshAncestors(e.path)
  }

  function resetRoot(): void {
    root.value = {
      name: options.vault(),
      path: options.vault(),
      is_dir: true,
      is_mdx: false,
      expanded: true,
      loading: false,
      children: [],
    }
  }

  /**
   * Subscribe to fs changes for `vault`, or release the registration again if
   * the tree has moved on before it landed.
   *
   * `onFsChange` resolves after an await, and both a vault switch and an unmount
   * can overtake it: each `listen()` installs its own backend subscription, so a
   * registration that lands after either is a second, genuinely independent
   * listener that only this continuation can reach (nothing else holds its
   * unsubscriber). Left alone it kept calling `refreshAncestors` against the
   * vault that is no longer open, for the rest of the session — and leaving the
   * Folders view happens on every rail switch, so it is not a one-time cost.
   * The same disposal shape as `useNoteGraph`'s `disposed` and
   * `appBootstrap`'s `isStale()` re-check after `onFsChange`.
   */
  async function subscribeToFsChanges(vault: string): Promise<void> {
    const off = await fsService.onFsChange(handleFsChange)
    if (unmounted || options.vault() !== vault) {
      off()
      return
    }
    // Whatever an earlier continuation may have installed: at most one
    // subscription belongs to the open vault (`/a` → `/b` → `/a` can leave an
    // older `/a` registration in place when the listings settle out of order).
    unlisten?.()
    unlisten = off
  }

  onMounted(async () => {
    resetRoot()
    await listChildren(root.value!)
    // The backend watcher itself is armed by the runtime when a vault is opened
    // (appBootstrap), NOT here: the tree only exists while the Folders panel is
    // shown, so arming it here left the default Notes panel unwatched. What is
    // left for this side is reacting to the events, to refresh its rows.
    await subscribeToFsChanges(options.vault())
  })

  onBeforeUnmount(() => {
    unmounted = true
    unlisten?.()
    unlisten = null
  })

  watch(
    () => options.vault(),
    async (vault) => {
      // Drop the previous fs-change subscription before re-subscribing on a
      // vault switch so handlers don't stack across vaults.
      unlisten?.()
      unlisten = null
      confirmPath.value = null
      selectedDirPath.value = null
      resetRoot()
      await listChildren(root.value!)
      await subscribeToFsChanges(vault)
    },
  )

  return {
    root,
    flat,
    activePath,
    selectedDirPath,
    currentDirPath,
    currentDirLabel,
    confirmPath,
    actions,
    toggle,
    openFile,
    openNote,
    refreshAncestors,
    findDirNode,
    ensureDirNode,
    parentDirOf,
    requestDelete,
    cancelDelete,
    confirmDelete,
  }
}
