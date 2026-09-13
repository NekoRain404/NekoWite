<script setup lang="ts">
import { computed, ref } from 'vue'
import { FilePlus2, FolderPlus } from 'lucide-vue-next'
import { t } from '../../../i18n'
import FileTreeRow from './FileTreeRow.vue'
import type { FileTreeRowView } from './FileTreeRow.vue'
import FileTreeContextMenu from './FileTreeContextMenu.vue'
import { useFileTree } from '../composables/useFileTree'
import type { FileTreeFlatRow, FileTreeNode } from '../composables/useFileTree'
import { useFileTreeRename } from '../composables/useFileTreeRename'
import { useFileTreeDrag } from '../composables/useFileTreeDrag'

/**
 * The Folders panel: a vault tree the user can expand, open from, create in,
 * rename, drag and delete.
 *
 * This component only orchestrates (§13.3). The tree state and its queries live
 * in `useFileTree`, the naming editor in `useFileTreeRename`, the drag gesture
 * in `useFileTreeDrag` and the disk work in `services/vault-file-actions`; what
 * is left here is composition, prop passing and event forwarding — including
 * the stores, which the composables read so that this file touches none.
 */
const props = defineProps<{ vault: string }>()
// The `conflict` emit is gone: the keep-or-reload question is raised by the
// app-level external-change service, so this component no longer needs a
// channel up to the shell for it.

/** The vault as a getter: a switch replaces the prop under a mounted tree. */
const vault = (): string => props.vault

const tree = useFileTree({ vault })
const {
  root,
  flat,
  activePath,
  currentDirPath,
  currentDirLabel,
  confirmPath,
  requestDelete,
  cancelDelete,
  confirmDelete,
} = tree

const edit = useFileTreeRename({
  vault,
  rows: tree.flat,
  findDirNode: tree.findDirNode,
  ensureDirNode: tree.ensureDirNode,
  refreshAncestors: tree.refreshAncestors,
  openNote: tree.openNote,
  actions: tree.actions,
})
const {
  pendingEdit,
  editName,
  editError,
  inlineEdit,
  start,
  startCreate,
  cancel: cancelEdit,
  onEditKeydown,
} = edit

const drag = useFileTreeDrag({
  vault,
  flat: tree.flat,
  rootPath: () => tree.root.value?.path,
  refreshAncestors: tree.refreshAncestors,
})
const { dropTargetPath } = drag

const menu = ref<{ x: number; y: number; node: FileTreeNode | null } | null>(null)

function openMenu(node: FileTreeNode | null, e: MouseEvent): void {
  menu.value = { x: e.clientX, y: e.clientY, node }
}

/** The vault root has no rename and no delete item; every other row does. */
const menuCanModify = computed(() => {
  const node = menu.value?.node
  return !!node && !!root.value && node.path !== root.value.path
})

async function onMenuSelect(id: string): Promise<void> {
  const target = menu.value?.node ?? null
  const parentPath = target ? tree.parentDirOf(target) : currentDirPath.value
  if (id === 'new-file') await start({ kind: 'file', parentPath })
  else if (id === 'new-dir') await start({ kind: 'dir', parentPath })
  else if (id === 'rename' && target) await start({ kind: 'rename', node: target })
  else if (id === 'delete' && target) requestDelete(target.path)
}

/** What one visible row must show. The row itself decides nothing. */
function entryRow(row: FileTreeFlatRow): FileTreeRowView {
  const node = row.node
  const renaming = pendingEdit.value?.kind === 'rename' && pendingEdit.value.nodePath === node.path
  return {
    kind: 'entry',
    node,
    depth: row.depth,
    active: node.path === activePath.value,
    dropTarget: dropTargetPath.value === node.path,
    draggable: node !== root.value && !renaming,
    isRoot: node === root.value,
    renaming,
    confirming: confirmPath.value === node.path,
    editError: editError.value,
  }
}
</script>

<template>
  <div class="file-tree">
    <div class="tree-toolbar">
      <button
        class="tree-tool"
        :title="t('filetree.newFile')"
        @click="startCreate('file', currentDirPath)"
      >
        <FilePlus2
          :size="14"
          :stroke-width="1.8"
        />
      </button>
      <button
        class="tree-tool"
        :title="t('filetree.newFolder')"
        @click="startCreate('dir', currentDirPath)"
      >
        <FolderPlus
          :size="14"
          :stroke-width="1.8"
        />
      </button>
      <span
        class="tree-tool-dir"
        :title="currentDirPath"
      >{{ currentDirLabel }}</span>
    </div>
    <div
      v-if="root"
      class="tree-body"
      @contextmenu.prevent="openMenu(null, $event)"
    >
      <template
        v-for="row in flat"
        :key="row.node.path"
      >
        <FileTreeRow
          v-model:edit-name="editName"
          :row="entryRow(row)"
          @toggle="tree.toggle"
          @open="tree.openFile"
          @context="openMenu"
          @delete-request="requestDelete($event.path)"
          @delete-confirm="confirmDelete($event.path)"
          @delete-cancel="cancelDelete"
          @dragstart="drag.onDragStart(row.node, $event)"
          @dragover="drag.onDragOver(row.node, $event)"
          @dragleave="drag.onDragLeave"
          @drop="drag.onDrop(row.node, $event)"
          @dragend="drag.onDragEnd"
          @edit-keydown="onEditKeydown"
          @edit-blur="cancelEdit"
        />
        <FileTreeRow
          v-if="inlineEdit && row.node.path === inlineEdit.afterPath"
          v-model:edit-name="editName"
          :row="{ kind: 'create', depth: inlineEdit.depth, variant: inlineEdit.kind, editError }"
          @edit-keydown="onEditKeydown"
          @edit-blur="cancelEdit"
        />
      </template>
    </div>
    <FileTreeContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :can-modify="menuCanModify"
      @select="onMenuSelect"
      @close="menu = null"
    />
  </div>
</template>

<style scoped>
.file-tree {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.tree-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px 6px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 55%, transparent);
}
.tree-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: none;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.tree-tool:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.tree-tool:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.tree-tool-dir {
  flex: 1;
  min-width: 0;
  margin-left: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  letter-spacing: 0.02em;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
  text-align: right;
}
.tree-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
</style>
