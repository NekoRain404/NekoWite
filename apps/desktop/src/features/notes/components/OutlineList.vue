<script setup lang="ts">
/**
 * The outline of the open note: one row per heading, indented by its level.
 *
 * The headings are parsed elsewhere (`useNoteList`), so this component never
 * looks at markdown: it renders what it is given and reports which heading the
 * user picked. Its rows are siblings of the panel's body, not wrapped in an
 * element, so the body's own layout and its `:first-child` rules still apply.
 */
import { t } from '../../../i18n'
import type { OutlineItem } from '../../../services/outline'

const props = defineProps<{
  items: OutlineItem[]
  /** Whether a note is open at all — without one there is nothing to outline. */
  noteOpen: boolean
}>()

const emit = defineEmits<{
  (e: 'jump', line: number, index: number): void
}>()
</script>

<template>
  <template v-if="props.noteOpen">
    <button
      v-for="item in props.items"
      :key="item.index"
      class="outline-item"
      :style="{ paddingLeft: `${8 + Math.max(0, item.level - 1) * 12}px` }"
      :title="t('notelist.jumpLine', { n: item.line + 1 })"
      @click="emit('jump', item.line, item.index)"
    >
      <span class="outline-mark" />
      <span class="outline-text">{{ item.text || t('notelist.outlineHeading') }}</span>
    </button>
    <p
      v-if="props.items.length === 0"
      class="nl-empty-hint"
    >
      {{ t('notelist.outlineEmpty') }}
    </p>
  </template>
  <p
    v-else
    class="nl-empty-hint"
  >
    {{ t('notelist.openNoteOutline') }}
  </p>
</template>

<style scoped>
/* `.nl-empty-hint` is restated in NoteListContent and LinkList: a scoped block
   belongs to the component that renders the element, and the rule is too small
   to belong in the shared stylesheet. */
.nl-empty-hint {
  margin: 0;
  padding: 10px 6px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--app-muted);
  text-align: center;
}

.outline-item {
  display: grid;
  grid-template-columns: 3px minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  min-height: 30px;
  padding: 0 8px 0 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.outline-item:hover {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.outline-item:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.outline-mark {
  width: 3px;
  height: 12px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent) 55%, transparent);
}
.outline-text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: color-mix(in srgb, var(--app-text) 80%, var(--app-muted));
}
.outline-item:hover .outline-text {
  color: var(--app-text);
}
</style>
