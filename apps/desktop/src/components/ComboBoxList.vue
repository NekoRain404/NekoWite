<script setup lang="ts">
/**
 * The listbox the field draws under itself: the rows, their ids, and the
 * scrolling that keeps the highlighted one in view.
 *
 * It owns the two things the field around it must not duplicate. The ids come
 * from `combo-option-id.ts`, the same scheme the field names in
 * `aria-activedescendant` — one minted string, so the two halves of the
 * combobox cannot drift apart. And the list element is here, so the DOM work of
 * following the arrows is here as well (§13.3): the field only says which row
 * they landed on.
 *
 * What is *not* here is placement. The popup is teleported to the body and
 * positioned against the input, and only the field can measure its own anchor,
 * so the box it calculated arrives as props and the field asks back for the
 * size to place against.
 *
 * The highlight, the query and the value live one level up: this component
 * reports what the user did to a row and renders the numbers it is given
 * (§10.2 — no store access, no decisions).
 */
import { ref } from 'vue'
import { comboOptionId } from './combo-option-id'

defineProps<{
  /** The list element's id: the field points `aria-controls` at it. */
  listId: string
  /** The rows to draw, already narrowed by the field. */
  rows: readonly string[]
  /** The row `Enter` would take, as an index into `rows`. */
  activeIndex: number
  /** The value in the field, so the row it already holds reads as selected. */
  modelValue: string
  /** Accessible name for the list, since a listbox of bare strings has none. */
  listLabel?: string
  /** Where the field put the popup, in viewport coordinates. */
  left: number
  top: number
  minWidth: number
}>()

const emit = defineEmits<{
  /** A row was clicked: it becomes the value. */
  activate: [index: number]
  /** The pointer moved onto a row: it becomes the one `Enter` would take. */
  highlight: [index: number]
}>()

const listEl = ref<HTMLElement | null>(null)

/** The box the popup occupies, for the field to place itself against — or null
 *  while there is no popup to measure. */
function measure(): { width: number; height: number } | null {
  const el = listEl.value
  return el ? { width: el.offsetWidth, height: el.offsetHeight } : null
}

/** A list taller than the popup's cap has to follow the arrows, as the command
 *  palette's does. The keyboard only ever moved the index; the scroll is DOM
 *  work on an element that lives here. */
function scrollActiveIntoView(index: number): void {
  listEl.value
    ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
    ?.scrollIntoView({ block: 'nearest' })
}

/** Whether a pointer landed inside the popup — the field's outside-click test,
 *  which only the list can answer without knowing where it was put. */
function contains(node: Node): boolean {
  return listEl.value?.contains(node) ?? false
}

defineExpose({ measure, scrollActiveIntoView, contains })
</script>

<template>
  <div
    :id="listId"
    ref="listEl"
    class="combo-popup"
    :style="{ left: `${left}px`, top: `${top}px`, minWidth: `${minWidth}px` }"
    role="listbox"
    :aria-label="listLabel"
  >
    <button
      v-for="(option, index) in rows"
      :id="comboOptionId(listId, index)"
      :key="option"
      class="combo-option"
      :class="{ 'is-active': index === activeIndex, 'is-selected': option === modelValue }"
      type="button"
      role="option"
      :aria-selected="option === modelValue"
      tabindex="-1"
      :data-index="index"
      :data-value="option"
      @mousedown.prevent
      @mouseenter="emit('highlight', index)"
      @click="emit('activate', index)"
    >
      <span class="combo-option-label">{{ option }}</span>
    </button>
  </div>
</template>

<style scoped>
.combo-popup {
  position: fixed;
  /* Above the modal layer (10000) — a dropdown opens from inside the settings
     dialog — and below the toast layer (11000). */
  z-index: 10001;
  max-width: 280px;
  max-height: 280px;
  overflow-y: auto;
  padding: 5px;
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-lg);
  background: color-mix(in srgb, var(--app-elevated) 96%, var(--app-panel));
  box-shadow: var(--app-shadow-menu);
}
/* The list is a region arriving in place, so it takes the region rung, and it
   leaves on the next rung down, accelerating, because by then it has been read.
   A leaving popup is on screen for a frame and must not take the dismissing
   click. */
.combo-popup-enter-active {
  transition: opacity var(--app-motion) var(--app-ease),
              transform var(--app-motion) var(--app-ease);
}
.combo-popup-leave-active {
  transition: opacity var(--app-motion-fast) var(--app-ease-exit),
              transform var(--app-motion-fast) var(--app-ease-exit);
  pointer-events: none;
}
.combo-popup-enter-from,
.combo-popup-leave-to {
  opacity: 0;
  transform: translateY(4px) scale(0.98);
}

.combo-option {
  display: flex;
  align-items: center;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.combo-option.is-active {
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
}
.combo-option.is-selected { color: var(--app-accent); }
.combo-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
