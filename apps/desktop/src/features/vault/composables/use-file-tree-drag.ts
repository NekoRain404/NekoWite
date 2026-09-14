/**
 * The tree's drag-and-drop "move" gesture: which row is being dragged, which
 * one accepts it, and what a drop means.
 *
 * The decision itself is not made here — it is the pure
 * `services/treeDrop.resolveDropTarget`, which answers in path arithmetic and
 * is unit-tested without a gateway. What this composable owns is the state that
 * decision is made against and the move it produces: the drag in flight, the
 * highlighted target, and the refresh of both ends of a completed move.
 *
 * The move goes through the shared `services/noteMoveFlow.moveOrRepair` and is
 * not reimplemented: that flow flushes pending edits, arms the
 * `noteSelfWrite`/`beginMove` claims the external-change service reads, and
 * repairs the tabs if the move fails after its rename landed.
 */

import { computed, ref } from 'vue'
import type { ComputedRef } from 'vue'
import { resolveDropTarget } from '../../../services/tree-drop'
import type { DropRow } from '../../../services/tree-drop'
import { moveOrRepair } from '../../../services/note-move-flow'
import { notifyError } from '../../../services/errors'
import { t } from '../../../i18n'
import type { FileTreeFlatRow, FileTreeNode } from './use-file-tree'

export interface UseFileTreeDragOptions {
  vault: () => string
  /** The visible rows: what may be dragged and what may accept a drop. */
  flat: ComputedRef<FileTreeFlatRow[]>
  /** The vault root's path — dropping onto the root row re-parents to the top. */
  rootPath: () => string | undefined
  refreshAncestors: (path: string) => Promise<void>
}

export function useFileTreeDrag(options: UseFileTreeDragOptions) {
  const dragState = ref<{ path: string; isDir: boolean } | null>(null)
  const dropTargetPath = ref<string | null>(null)

  /** Flattened rows as the pure drop-resolver expects them. */
  const rowsForDrop = computed<DropRow[]>(() =>
    options.flat.value.map((r) => ({ path: r.node.path, isDir: r.node.is_dir })),
  )

  function onDragStart(node: FileTreeNode, e: DragEvent): void {
    dragState.value = { path: node.path, isDir: node.is_dir }
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/nekowite-path', node.path)
      e.dataTransfer.setData('text/plain', node.path)
    }
  }

  /** Keep the drop target highlighted only where the pure resolver approves;
   * still prevent the (empty, no-op) default drag so the drop event lands here. */
  function onDragOver(node: FileTreeNode, e: DragEvent): void {
    if (!dragState.value) return
    if (!node.is_dir) {
      dropTargetPath.value = null
      return
    }
    e.preventDefault()
    const result = resolveDropTarget(
      rowsForDrop.value,
      dragState.value.path,
      node.path,
      options.rootPath(),
    )
    if (result.ok && e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move'
      dropTargetPath.value = node.path
    } else {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
      dropTargetPath.value = null
    }
  }

  function onDragLeave(): void {
    dropTargetPath.value = null
  }

  function onDragEnd(): void {
    dragState.value = null
    dropTargetPath.value = null
  }

  function onDrop(node: FileTreeNode, e: DragEvent): void {
    e.preventDefault()
    const drag = dragState.value
    if (!drag) {
      dropTargetPath.value = null
      return
    }
    const result = resolveDropTarget(rowsForDrop.value, drag.path, node.path, options.rootPath())
    dropTargetPath.value = null
    if (!result.ok || !result.to) {
      notifyError(result.reason === 'conflict' ? t('tree.conflict') : t('tree.dropInvalid'))
      dragState.value = null
      return
    }
    void performMove(result.from, result.to, drag.isDir)
  }

  async function performMove(from: string, to: string, isDir: boolean): Promise<void> {
    try {
      await moveOrRepair(options.vault(), from, to, isDir)
    } catch {
      notifyError(t('tree.moveFailed'))
    } finally {
      // Refresh even after a failure: a move that landed the note but not its
      // references must not leave stale rows on screen.
      await options.refreshAncestors(from)
      await options.refreshAncestors(to)
      dragState.value = null
      dropTargetPath.value = null
    }
  }

  return {
    dropTargetPath,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDragEnd,
    onDrop,
  }
}
