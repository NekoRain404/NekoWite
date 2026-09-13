<script lang="ts">
import type { FileTreeNode } from '../composables/useFileTree'

/**
 * The two shapes a tree row takes: a real entry, and the inline editor that
 * creates one.
 *
 * They are one component rather than two because they share the row chrome —
 * height, indent, hover, the inline name input and its error state. A second
 * component would have to restate that CSS, and the two copies would drift.
 *
 * `editName` is the only two-way value: it is a `defineModel`, so the input
 * inside this component stays a plain `v-model` and keeps Vue's IME guarding
 * (the directive holds back the DOM write while a composition is open, which a
 * hand-rolled `:value` + `@input` pair does not).
 */
export type FileTreeRowView =
  | {
      kind: 'entry'
      node: FileTreeNode
      depth: number
      /** The row is the document in the active tab. */
      active: boolean
      /** The row is the highlighted drop target. */
      dropTarget: boolean
      /** The row may start a drag (the vault root may not, nor the row being
       *  renamed — dragging it would fight the open input). */
      draggable: boolean
      /** The vault root: never renamed, never deleted. */
      isRoot: boolean
      /** A rename input replaces the name button. */
      renaming: boolean
      /** The delete confirmation pair replaces the trash icon. */
      confirming: boolean
      editError: string
    }
  | {
      kind: 'create'
      depth: number
      variant: 'file' | 'dir'
      editError: string
    }
</script>

<script setup lang="ts">
import { computed, type ComponentPublicInstance } from 'vue'
import { ChevronRight, FileText, Folder, FolderOpen, Trash2 } from 'lucide-vue-next'
import { t } from '../../../i18n'

const props = defineProps<{ row: FileTreeRowView }>()

const editName = defineModel<string>('editName', { required: true })

const emit = defineEmits<{
  (e: 'toggle', node: FileTreeNode): void
  (e: 'open', node: FileTreeNode): void
  (e: 'context', node: FileTreeNode, event: MouseEvent): void
  (e: 'delete-request', node: FileTreeNode): void
  (e: 'delete-confirm', node: FileTreeNode): void
  (e: 'delete-cancel'): void
  (e: 'dragstart', event: DragEvent): void
  (e: 'dragover', event: DragEvent): void
  (e: 'dragleave'): void
  (e: 'dragend'): void
  (e: 'drop', event: DragEvent): void
  (e: 'edit-keydown', event: KeyboardEvent): void
  (e: 'edit-blur'): void
}>()

/** A create row has no variant of its own; the default only keeps the template
 *  off a union member that does not exist on both shapes. */
const createKind = computed<'file' | 'dir'>(() =>
  props.row.kind === 'create' ? props.row.variant : 'file',
)

/**
 * Focus the inline input as it appears, and select the whole name when a
 * rename starts (a replace, not an append).
 *
 * The callback is a stable function on purpose: a function ref is re-invoked
 * with `null` and the element on every update when its identity changes, which
 * would steal focus back on every re-render.
 */
function setInput(el: Element | ComponentPublicInstance | null): void {
  const input = el instanceof HTMLInputElement ? el : null
  if (!input) return
  input.focus()
  if (props.row.kind === 'entry' && props.row.renaming) input.select()
}

function onCaret(): void {
  if (props.row.kind !== 'entry') return
  if (props.row.node.is_dir) emit('toggle', props.row.node)
}

function onNameClick(): void {
  if (props.row.kind !== 'entry') return
  // Only markdown/MDX documents open in a tab; other files are listed for
  // discovery but are not editor targets.
  if (props.row.node.is_dir) emit('toggle', props.row.node)
  else emit('open', props.row.node)
}
</script>

<template>
  <div
    v-if="row.kind === 'entry'"
    class="tree-row"
    :class="{ active: row.active, 'is-drop-target': row.dropTarget }"
    :draggable="row.draggable"
    :style="{ paddingLeft: `${6 + row.depth * 14}px` }"
    @contextmenu.stop.prevent="emit('context', row.node, $event)"
    @dragstart="emit('dragstart', $event)"
    @dragover="emit('dragover', $event)"
    @dragleave="emit('dragleave')"
    @drop="emit('drop', $event)"
    @dragend="emit('dragend')"
  >
    <button
      class="caret"
      :class="{ hidden: !row.node.is_dir }"
      :tabindex="row.node.is_dir ? 0 : -1"
      :aria-label="row.node.is_dir
        ? (row.node.expanded ? t('filetree.collapseFolder', { name: row.node.name }) : t('filetree.expandFolder', { name: row.node.name }))
        : undefined"
      :aria-expanded="row.node.is_dir ? row.node.expanded : undefined"
      @click.stop="onCaret()"
    >
      <ChevronRight
        v-if="row.node.is_dir"
        :size="12"
        :stroke-width="1.8"
        class="caret-icon"
        :class="{ open: row.node.expanded }"
      />
    </button>
    <span class="tree-icon">
      <FolderOpen
        v-if="row.node.is_dir && row.node.expanded"
        :size="14"
        :stroke-width="1.8"
        class="icon-folder"
      />
      <Folder
        v-else-if="row.node.is_dir"
        :size="14"
        :stroke-width="1.8"
        class="icon-folder"
      />
      <FileText
        v-else
        :size="13"
        :stroke-width="1.8"
        class="icon-file"
      />
    </span>
    <input
      v-if="row.renaming"
      :ref="setInput"
      v-model="editName"
      class="tree-inline-input"
      :class="{ invalid: !!row.editError }"
      type="text"
      @click.stop
      @keydown.stop="emit('edit-keydown', $event)"
      @blur="emit('edit-blur')"
    >
    <button
      v-else
      type="button"
      class="tree-name"
      :class="{ dir: row.node.is_dir }"
      :title="row.node.path"
      @click="onNameClick()"
    >
      {{ row.node.name }}
    </button>
    <button
      v-if="!row.isRoot && !row.confirming"
      class="tree-del"
      :title="t('filetree.trash')"
      @click.stop="emit('delete-request', row.node)"
    >
      <Trash2
        :size="12"
        :stroke-width="1.8"
      />
    </button>
    <span
      v-else-if="!row.isRoot"
      class="tree-del-confirm"
      @click.stop
    >
      <button
        class="btn btn-secondary btn-sm"
        @click.stop="emit('delete-confirm', row.node)"
      >
        {{ t('filetree.confirm') }}
      </button>
      <button
        class="btn btn-ghost btn-sm"
        @click.stop="emit('delete-cancel')"
      >
        {{ t('filetree.cancel') }}
      </button>
    </span>
  </div>
  <div
    v-else
    class="tree-row tree-edit-row"
    :style="{ paddingLeft: `${6 + row.depth * 14}px` }"
  >
    <button
      class="caret hidden"
      type="button"
      tabindex="-1"
    />
    <span class="tree-icon">
      <FileText
        v-if="createKind === 'file'"
        :size="13"
        :stroke-width="1.8"
        class="icon-file"
      />
      <Folder
        v-else
        :size="14"
        :stroke-width="1.8"
        class="icon-folder"
      />
    </span>
    <input
      :ref="setInput"
      v-model="editName"
      class="tree-inline-input"
      :class="{ invalid: !!row.editError }"
      type="text"
      :placeholder="createKind === 'file' ? t('filetree.filePlaceholder') : t('filetree.folderPlaceholder')"
      @click.stop
      @keydown.stop="emit('edit-keydown', $event)"
      @blur="emit('edit-blur')"
    >
    <span
      v-if="row.editError"
      class="tree-edit-error"
    >{{ row.editError }}</span>
  </div>
</template>

<style scoped>
.tree-row {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 30px;
  padding-right: 6px;
  font-size: 12px;
  white-space: nowrap;
  color: color-mix(in srgb, var(--app-text) 72%, var(--app-muted));
  border-radius: var(--app-radius-sm);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.tree-row:hover {
  background: color-mix(in srgb, var(--app-elevated) 62%, transparent);
  color: var(--app-text);
}
.tree-row.active {
  background: color-mix(in srgb, var(--app-accent-soft) 76%, var(--app-panel));
  color: var(--app-text);
  font-weight: 550;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-accent) 9%, transparent);
}
.tree-row[draggable="true"] {
  cursor: grab;
}
.tree-row[draggable="true"]:active {
  cursor: grabbing;
}
.tree-row.is-drop-target {
  background: color-mix(in srgb, var(--app-accent-soft) 84%, var(--app-panel));
  box-shadow: inset 0 0 0 1px var(--app-accent);
  color: var(--app-text);
}
.caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex: none;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
}
.caret.hidden { visibility: hidden; }
.caret-icon {
  transition: transform var(--app-motion-fast) var(--app-ease);
}
.caret-icon.open { transform: rotate(90deg); }
.tree-icon {
  display: inline-flex;
  align-items: center;
  flex: none;
  color: var(--app-muted);
}
.tree-row.active .tree-icon { color: var(--app-accent); }
.tree-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: -0.01em;
  /* A real button (so Tab and Enter reach it) that still reads as a label. */
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.tree-name:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -2px;
  border-radius: var(--app-radius-sm);
}
.tree-name.dir { font-weight: 550; color: color-mix(in srgb, var(--app-text) 84%, var(--app-muted)); }
.tree-inline-input {
  flex: 1;
  min-width: 0;
  height: 22px;
  padding: 0 6px;
  font-family: var(--app-font);
  font-size: 12px;
  color: var(--app-text);
  background: var(--app-canvas);
  border: 1px solid var(--app-accent);
  border-radius: var(--app-radius-sm);
  outline: none;
}
.tree-inline-input::placeholder { color: var(--app-muted); }
.tree-inline-input.invalid { border-color: var(--app-danger); }
.tree-edit-row { cursor: default; }
.tree-edit-error {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-left: 6px;
  font-size: 10px;
  color: var(--app-danger);
  white-space: nowrap;
}
.tree-del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease),
              background var(--app-motion-fast) var(--app-ease);
}
.tree-row:hover .tree-del { opacity: 1; }
/* Keyboard users never hover: without this the only control in a row is also
   an invisible one, so a Tab stop cannot be seen before it is pressed. */
.tree-del:focus-within,
.tree-row:focus-within .tree-del,
.tree-del:focus-visible { opacity: 1; }
.tree-del:hover {
  color: var(--app-danger);
  background: color-mix(in srgb, var(--app-danger) 10%, transparent);
}
.tree-del-confirm {
  margin-left: auto;
  display: flex;
  gap: 4px;
  align-items: center;
}
</style>
