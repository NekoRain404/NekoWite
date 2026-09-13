/**
 * The tree's inline naming editor: creating an entry, renaming one, and the
 * validation the two share.
 *
 * The state here is the edit in progress — which row is being edited, the text
 * in the input, and the message under it — plus the rules that decide whether
 * that text may be committed. Committing goes through
 * `services/vault-file-actions`; this composable never touches the disk itself.
 *
 * Everything it needs from the tree (the visible rows, the directory lookup,
 * the refresh, the open-a-note call) and the file actions themselves arrive as
 * parameters, so the editor can be driven without a mounted component.
 */

import { computed, ref } from 'vue'
import type { ComputedRef } from 'vue'
import { dirName } from '../../../services/paths'
import { notifyError } from '../../../services/errors'
import { isComposingKey } from '../../../services/keyGuard'
import { t } from '../../../i18n'
import { validateEntryName } from '../services/vault-file-actions'
import type { VaultFileActions, VaultNameError } from '../services/vault-file-actions'
import type { FileTreeFlatRow, FileTreeNode } from './useFileTree'

export interface TreeEdit {
  kind: 'file' | 'dir' | 'rename'
  parentPath: string
  nodePath?: string
  /** For `rename`: whether the entry is a directory. Only a renamed note needs
   *  the reference rewrite; a folder carries its contents with it. */
  nodeIsDir?: boolean
}

/** What `start` is being asked to begin editing. */
export type EditTarget =
  | { kind: 'file' | 'dir'; parentPath: string }
  | { kind: 'rename'; node: FileTreeNode }

/** The service names the rule that refused the name; the wording is the UI's
 *  (§13.9), so the mapping lives on this side. */
const NAME_ERROR_KEYS: Record<VaultNameError, string> = {
  'name-required': 'filetree.nameRequired',
  'name-slash': 'filetree.nameSlash',
  'name-dot': 'filetree.nameDot',
}

export interface UseFileTreeRenameOptions {
  vault: () => string
  /** The visible rows, for placing the inline creation editor. */
  rows: ComputedRef<FileTreeFlatRow[]>
  findDirNode: (path: string) => FileTreeNode | null
  ensureDirNode: (path: string) => Promise<FileTreeNode | null>
  refreshAncestors: (path: string) => Promise<void>
  /** Open a just-created note in a tab. */
  openNote: (path: string) => Promise<void>
  actions: VaultFileActions
}

export function useFileTreeRename(options: UseFileTreeRenameOptions) {
  const pendingEdit = ref<TreeEdit | null>(null)
  const editName = ref('')
  const editError = ref('')
  let confirming = false

  /** Where the inline creation input should render (after the parent's last
   *  visible descendant; the vault root's input sits right below the root row). */
  const inlineEdit = computed(() => {
    const p = pendingEdit.value
    if (!p || p.kind === 'rename') return null
    const rows = options.rows.value
    const idx = rows.findIndex((r) => r.node.path === p.parentPath)
    if (idx < 0) return null
    if (idx === 0) return { afterPath: rows[0].node.path, depth: 1, kind: p.kind }
    const parentDepth = rows[idx].depth
    let end = idx
    while (end + 1 < rows.length && rows[end + 1].depth > parentDepth) end++
    return { afterPath: rows[end].node.path, depth: parentDepth + 1, kind: p.kind }
  })

  async function startCreate(kind: 'file' | 'dir', parentPath: string): Promise<void> {
    const parent = await options.ensureDirNode(parentPath)
    if (!parent) return
    pendingEdit.value = { kind, parentPath: parent.path }
    editName.value = ''
    editError.value = ''
  }

  async function startRename(node: FileTreeNode): Promise<void> {
    const parent = await options.ensureDirNode(dirName(node.path))
    if (!parent) return
    pendingEdit.value = {
      kind: 'rename',
      parentPath: parent.path,
      nodePath: node.path,
      nodeIsDir: node.is_dir,
    }
    editName.value = node.name
    editError.value = ''
  }

  /** Begin editing — the one entry point the context menu needs. */
  async function start(target: EditTarget): Promise<void> {
    if (target.kind === 'rename') {
      await startRename(target.node)
      return
    }
    await startCreate(target.kind, target.parentPath)
  }

  function cancel(): void {
    if (confirming) return
    pendingEdit.value = null
    editError.value = ''
  }

  /** Enter commits and Escape cancels the inline create/rename input — but not
   *  while an IME is composing: there Enter accepts the highlighted candidate and
   *  Escape dismisses the candidate list, and treating those as app actions
   *  renamed the note to the raw pinyin string or discarded the typing entirely. */
  function onEditKeydown(e: KeyboardEvent): void {
    if (isComposingKey(e)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      void confirmEdit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  async function confirmEdit(): Promise<void> {
    const p = pendingEdit.value
    if (!p || confirming) return
    const name = editName.value.trim()
    const invalid = validateEntryName(name)
    if (invalid) {
      editError.value = t(NAME_ERROR_KEYS[invalid])
      return
    }
    // A duplicate is not a name rule but a fact about the loaded rows: the same
    // name at the same level, ignoring the entry being renamed.
    const parent = options.findDirNode(p.parentPath)
    const dup = parent?.children.some((c) => c.name === name && c.path !== p.nodePath) ?? false
    if (dup) {
      editError.value = t('filetree.nameDup')
      return
    }
    confirming = true
    try {
      await applyEdit(p, name)
    } finally {
      confirming = false
    }
  }

  async function applyEdit(p: TreeEdit, name: string): Promise<void> {
    if (p.kind === 'rename') {
      const from = p.nodePath
      if (!from) return
      const result = await options.actions.rename(options.vault(), from, name, p.nodeIsDir === true)
      if (!result.ok) {
        // The edit stays open with the typed name: the user has to be able to
        // retry, and closing it would throw the name away.
        notifyError(t('filetree.renameFailed'))
        return
      }
      await options.refreshAncestors(from)
    } else {
      const result = await options.actions.create(options.vault(), p.parentPath, name, p.kind)
      if (!result.ok) {
        notifyError(t('filetree.createFailed'))
        return
      }
      await options.refreshAncestors(result.path)
      pendingEdit.value = null
      editError.value = ''
      try {
        await options.openNote(result.path)
      } catch {
        // The file was created; only opening it failed. The edit row is already
        // closed at this point, so this reports the same create failure the
        // inline editor has always shown rather than leaving it silent.
        notifyError(t('filetree.createFailed'))
      }
      return
    }
    pendingEdit.value = null
    editError.value = ''
  }

  return {
    pendingEdit,
    editName,
    editError,
    inlineEdit,
    start,
    startCreate,
    cancel,
    confirmEdit,
    onEditKeydown,
  }
}
