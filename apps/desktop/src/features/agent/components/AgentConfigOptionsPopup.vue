<script setup lang="ts">
/**
 * The list one config option opens: the filter box, the engine's rows, and the keys that walk
 * them.
 *
 * Apart from the trigger that opens it because the two answer different questions. The trigger
 * is about the *control* — what it is set to, whether it can be moved, where the list should be
 * placed. This is about the *list*: the rows in the engine's order, the one the arrows are on,
 * the DOM work of following them, and the keyboard while the filter has focus. It owns no state
 * of its own (§10.2): `rows`, `activeIndex` and the query arrive as props, and every key it
 * understands leaves as an event for the picker to act on, because the index and the query are
 * one list's facts and splitting them across two components would be two places to keep them
 * right.
 *
 * The filter exists only when the picker says so (`AGENT_CONFIG_FILTER_THRESHOLD`, the engine's
 * own choice count deciding): Zed's `Picker::list` against `Picker::nonsearchable_list`
 * (`zed-main/crates/agent_ui/src/config_options.rs:339`).
 */
import { nextTick, ref, watch } from 'vue'
import type { AgentConfigChoice } from '../../../platform/gateways/agent-contracts'

const props = defineProps<{
  /** The rows to draw, already narrowed by the picker, in the engine's order. */
  rows: readonly AgentConfigChoice[]
  /** The row `Enter` would take, as an index into {@link rows}. */
  activeIndex: number
  /** The value the engine says is current, so its row reads as chosen. */
  current: string
  /** What is in the filter box. */
  query: string
  /** Whether the box is drawn at all. */
  filterable: boolean
  /** The list element's id, which the trigger's `aria-controls` names. */
  listId: string
  /** What to call the list and the box. */
  labels: { list: string; filter: string; noMatch: string }
  /** Where the picker put it, in viewport coordinates. */
  left: number
  top: number
  minWidth: number
  /** Which way it had to open, so the arrival comes from the control it belongs to rather than
   *  from the gap on the other side of it. */
  drop: 'down' | 'up'
}>()

const emit = defineEmits<{
  'update:query': [value: string]
  /** A row was clicked. */
  activate: [index: number]
  /** The pointer moved onto a row: it becomes the one `Enter` would take. */
  highlight: [index: number]
  /** A key that steps the highlight by one row, wrapping. */
  move: [offset: number]
  /** Home or End, as the first or the last row. */
  jump: [to: 0 | -1]
  /** Escape: the list is closing. */
  close: []
  /** A key the picker's trigger would have handled had the focus been there (Enter). */
  commit: []
}>()

const rootEl = ref<HTMLElement | null>(null)
const filterEl = ref<HTMLInputElement | null>(null)

/** The element the picker measures to place the list — it is the only layer that can reach it. */
function element(): HTMLElement | null {
  return rootEl.value
}

/** Focus the box the moment there is one: a list that must be typed into should not need a
 *  second press before it can be. */
function focusFilter(): void {
  filterEl.value?.focus()
}

function onFilterKeydown(event: KeyboardEvent): void {
  // The filter box is inside the popup, so the trigger's own handler never sees these keys.
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    emit('move', event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key === 'Home' || event.key === 'End') {
    // Home inside a box with text in it belongs to the caret, not to the list.
    if (event.key === 'Home' && filterEl.value?.selectionStart !== 0) return
    event.preventDefault()
    emit('jump', event.key === 'Home' ? 0 : -1)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    emit('commit')
  }
}

// A list taller than the popup's cap has to follow the arrows: the keyboard only ever moved the
// index, and the scroll is DOM work on an element this component owns.
watch(
  () => props.activeIndex,
  () => {
    void nextTick(() => {
      rootEl.value
        ?.querySelector<HTMLElement>(`[data-index="${props.activeIndex}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    })
  },
)

defineExpose({ element, focusFilter })
</script>

<template>
  <div
    :id="listId"
    ref="rootEl"
    class="agent-config-popup"
    :class="{ 'is-above': drop === 'up' }"
    :style="{ left: `${left}px`, top: `${top}px`, minWidth: `${minWidth}px` }"
    role="listbox"
    :aria-label="labels.list"
  >
    <input
      v-if="filterable"
      ref="filterEl"
      class="agent-config-filter"
      type="text"
      spellcheck="false"
      :value="query"
      :placeholder="labels.filter"
      :aria-label="labels.filter"
      :aria-activedescendant="`${listId}-option-${activeIndex}`"
      @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      @keydown="onFilterKeydown"
    >
    <p
      v-if="rows.length === 0"
      class="agent-config-none"
      role="status"
    >
      {{ labels.noMatch }}
    </p>
    <button
      v-for="(choice, index) in rows"
      :id="`${listId}-option-${index}`"
      :key="choice.value"
      class="agent-config-option"
      :class="{ 'is-active': index === activeIndex, 'is-selected': choice.value === current }"
      type="button"
      role="option"
      :aria-selected="choice.value === current"
      tabindex="-1"
      :data-index="index"
      :data-value="choice.value"
      @mousedown.prevent
      @mouseenter="emit('highlight', index)"
      @click="emit('activate', index)"
    >
      <span class="agent-config-option-name">{{ choice.name }}</span>
      <span
        v-if="choice.description !== undefined"
        class="agent-config-option-note"
      >{{ choice.description }}</span>
    </button>
  </div>
</template>

<style scoped>
.agent-config-popup {
  position: fixed;
  /* Above the modal layer (10000) and below the toast layer (11000), as every popup in this app
     is — a dropdown may open from inside the settings dialog's neighbours. */
  z-index: 10001;
  display: flex;
  flex-direction: column;
  max-width: 320px;
  max-height: 300px;
  overflow-y: auto;
  padding: 5px;
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-lg);
  background: color-mix(in srgb, var(--app-elevated) 96%, var(--app-panel));
  box-shadow: var(--app-shadow-menu);
  /* The edge the control is on is the edge the list grows out of, and which edge that is comes
     from `drop` — the placement the picker measured. Set on the base rule rather than on the
     transition classes, which Vue removes a frame into the transition, where the origin would
     snap to the centre mid-flight. */
  transform-origin: top center;
}
.agent-config-popup.is-above {
  transform-origin: bottom center;
}
/* Ninety models is a list nobody scrolls: the filter is the way in, and it is sticky so the
   list scrolls under it rather than carrying it away. */
.agent-config-filter {
  position: sticky;
  top: 0;
  margin-bottom: 4px;
  padding: 5px 8px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-panel);
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
}
.agent-config-filter:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -1px;
}
.agent-config-none {
  margin: 0;
  padding: 6px 8px;
  color: var(--app-muted);
  font-size: 12px;
}
.agent-config-option {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  padding: 5px 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.agent-config-option.is-active {
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
}
.agent-config-option.is-selected .agent-config-option-name {
  color: var(--app-accent);
}
.agent-config-option-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-config-option-note {
  overflow: hidden;
  color: var(--app-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
