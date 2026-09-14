<script setup lang="ts">
/**
 * The listbox: the two labelled groups of options, the empty line that stands
 * in for them when nothing matches, and the icons that identify each row.
 *
 * It owns two things the panel around it must not duplicate. The first is the
 * option ids: they are minted from `paletteItemId()`, the same scheme the
 * search field names in `aria-controls` and `aria-activedescendant`, so the two
 * halves of the combobox cannot drift apart (§13.9). The second is the list
 * element: the highlighted row is kept in view here, because that is DOM work
 * on an element that lives here — the panel only says which row the arrows
 * landed on (§13.3).
 *
 * The highlight and the query live one level up, in the panel's composables;
 * this component reports what the user did to a row and renders the number it
 * is given back (§10.2: no store access, no decisions).
 */
import { ref, type Component } from 'vue'
import { FileText } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { catalogOf } from '../../../ui/command-catalog'
import type { PaletteEntry } from '../services/command-palette-logic'
import { PALETTE_LIST_ID, paletteItemId, type PaletteGroupRows } from '../types'

defineProps<{
  rows: PaletteGroupRows[]
  /** The row the arrow keys are on, in the flat order the list is drawn in. */
  activeIndex: number
  /** Whether the empty line stands in for the groups (nothing to offer). */
  showEmpty: boolean
}>()

defineEmits<{
  activate: [entry: PaletteEntry]
  /** The pointer moved onto a row: it becomes the one Enter would run. */
  highlight: [index: number]
}>()

const listEl = ref<HTMLElement | null>(null)

/** Files are all notes, so they share one icon; a command brings its own from
 *  the catalog (unknown ids fall back to a puzzle piece). */
function iconFor(entry: PaletteEntry): Component {
  return entry.kind === 'file' ? FileText : catalogOf(entry.id).icon
}

function scrollActiveIntoView(index: number): void {
  const el = listEl.value?.querySelector<HTMLElement>(`[data-index="${index}"]`)
  el?.scrollIntoView({ block: 'nearest' })
}

defineExpose({ scrollActiveIntoView })
</script>

<template>
  <div
    :id="PALETTE_LIST_ID"
    ref="listEl"
    class="palette-list"
    role="listbox"
    :aria-label="t('palette.aria')"
  >
    <template
      v-for="group in rows"
      :key="group.key"
    >
      <!-- role=presentation: a listbox may only own options, and a
           group heading in between is otherwise announced as one. -->
      <div
        class="palette-group-label"
        role="presentation"
      >
        {{ group.label }}
      </div>
      <button
        v-for="row in group.entries"
        :id="paletteItemId(row.index)"
        :key="row.entry.id"
        class="palette-item"
        :class="{ 'is-active': row.index === activeIndex }"
        type="button"
        role="option"
        :aria-selected="row.index === activeIndex"
        :data-index="row.index"
        tabindex="-1"
        @mousedown.prevent
        @mouseenter="$emit('highlight', row.index)"
        @click="$emit('activate', row.entry)"
      >
        <span class="palette-item-icon">
          <component
            :is="iconFor(row.entry)"
            :size="14"
            :stroke-width="1.8"
          />
        </span>
        <span class="palette-item-label">{{ row.entry.label }}</span>
        <span
          v-if="row.entry.hint"
          class="palette-item-hint"
        >{{ row.entry.hint }}</span>
      </button>
    </template>
    <div
      v-if="showEmpty"
      class="palette-empty"
      role="presentation"
    >
      {{ t('palette.empty') }}
    </div>
  </div>
</template>

<style scoped>
.palette-list {
  max-height: min(420px, 56vh);
  overflow-y: auto;
  padding: 6px;
}
.palette-group-label {
  padding: 8px 8px 4px;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.06em;
  color: var(--app-muted);
}
.palette-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  letter-spacing: -0.01em;
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.palette-item.is-active {
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
}
.palette-item-icon {
  display: grid;
  place-items: center;
  width: 16px;
  flex: none;
  color: var(--app-muted);
}
.palette-item.is-active .palette-item-icon {
  color: var(--app-accent);
}
.palette-item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.palette-item-hint {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--app-muted);
}
.palette-empty {
  padding: 24px 0;
  font-size: 12px;
  color: var(--app-muted);
  text-align: center;
}
</style>
