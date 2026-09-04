<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumnAtCursor,
  deleteRowAtCursor,
  onTableCursorChange,
  setCellAlignment,
  toggleHeaderRow,
} from '@nekowite/editor-core'
import type { NekoEditor } from '@nekowite/editor-core'
import { t } from '../i18n'

const props = defineProps<{ editor: NekoEditor | null }>()

const inTable = ref(false)
let unlisten: (() => void) | null = null

unlisten = onTableCursorChange((on) => {
  inTable.value = on
})

const run = (fn: (view: ReturnType<NekoEditor['getView']>) => boolean): void => {
  if (!props.editor) return
  fn(props.editor.getView())
}

const ops: Array<{ id: string; label: string; run: () => void }> = [
  { id: 'row-after', label: t('tableMenu.addRowAfter'), run: () => run(addRowAfter) },
  { id: 'row-before', label: t('tableMenu.addRowBefore'), run: () => run(addRowBefore) },
  { id: 'row-del', label: t('tableMenu.deleteRow'), run: () => run(deleteRowAtCursor) },
  { id: 'col-after', label: t('tableMenu.addColAfter'), run: () => run(addColumnAfter) },
  { id: 'col-before', label: t('tableMenu.addColBefore'), run: () => run(addColumnBefore) },
  { id: 'col-del', label: t('tableMenu.deleteCol'), run: () => run(deleteColumnAtCursor) },
  { id: 'header', label: t('tableMenu.toggleHeader'), run: () => run(toggleHeaderRow) },
  { id: 'align-left', label: t('tableMenu.alignLeft'), run: () => run((v) => setCellAlignment(v, 'left')) },
  { id: 'align-center', label: t('tableMenu.alignCenter'), run: () => run((v) => setCellAlignment(v, 'center')) },
  { id: 'align-right', label: t('tableMenu.alignRight'), run: () => run((v) => setCellAlignment(v, 'right')) },
]

onBeforeUnmount(() => {
  unlisten?.()
  unlisten = null
})
</script>

<template>
  <div
    v-if="inTable && editor"
    class="neko-table-menu"
    role="toolbar"
    :aria-label="t('tableMenu.aria')"
    @pointerdown.stop
    @click.stop
  >
    <button
      v-for="op in ops"
      :key="op.id"
      type="button"
      class="neko-table-menu-btn"
      :title="op.label"
      @click="op.run"
    >
      {{ op.label }}
    </button>
  </div>
</template>

<style scoped>
.neko-table-menu {
  position: absolute;
  top: 6px;
  left: 50%;
  z-index: 40;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  max-width: calc(100% - 24px);
  padding: 4px 6px;
  background: var(--app-elevated);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-md);
  box-shadow: 0 6px 20px color-mix(in srgb, var(--app-text) 14%, transparent);
  font-family: var(--app-font);
  font-size: 11px;
  transform: translateX(-50%);
}
.neko-table-menu-btn {
  padding: 4px 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.neko-table-menu-btn:hover {
  background: color-mix(in srgb, var(--app-accent) 16%, transparent);
  color: var(--app-accent);
}
</style>
