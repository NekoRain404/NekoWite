<script setup lang="ts">
import { computed, markRaw } from 'vue'
import { FilePlus2, FolderPlus, PencilLine, Trash2 } from 'lucide-vue-next'
import ContextMenu from '../../../ui/ContextMenu.vue'
import type { ContextMenuItem } from '../../../ui/ContextMenu.vue'
import { t } from '../../../i18n'

/**
 * The tree's context menu: which items are offered, and nothing else.
 *
 * The caller owns where the menu is and what its target is; this component is
 * handed the two facts it needs to build the list — the anchor position and
 * whether the target may be modified. The target ROW is deliberately not a
 * prop: the menu never acts on it, it only reports the item that was picked.
 */
const props = defineProps<{
  x: number
  y: number
  /** False for the vault root, which can be a create target but is never
   *  renamed or deleted. */
  canModify: boolean
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'close'): void
}>()

const MENU_ICONS = {
  filePlus: markRaw(FilePlus2),
  folderPlus: markRaw(FolderPlus),
  pencil: markRaw(PencilLine),
  trash: markRaw(Trash2),
}

const menuItems = computed<ContextMenuItem[]>(() => {
  const items: ContextMenuItem[] = [
    { id: 'new-file', label: t('filetree.newFile'), icon: MENU_ICONS.filePlus },
    { id: 'new-dir', label: t('filetree.newFolder'), icon: MENU_ICONS.folderPlus },
  ]
  if (props.canModify) {
    items.push(
      { id: 'rename', label: t('filetree.rename'), icon: MENU_ICONS.pencil, separator: true },
      { id: 'delete', label: t('filetree.delete'), icon: MENU_ICONS.trash, danger: true },
    )
  }
  return items
})
</script>

<template>
  <ContextMenu
    :x="x"
    :y="y"
    :items="menuItems"
    @select="emit('select', $event)"
    @close="emit('close')"
  />
</template>
