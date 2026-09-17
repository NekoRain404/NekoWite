<script lang="ts">
import type { Component } from 'vue'

/** One row: a thing to pick, and whether it can be picked at all. */
export interface AgentReferenceRow {
  id: string
  label: string
  icon: Component
  /** Announced and readable, and not a destination: the arrows step over it. */
  disabled?: boolean
}
</script>

<script setup lang="ts">
/**
 * The list of things a `+` can put in a message: the box, its keys, and where focus goes.
 *
 * It draws rows and reports which one was taken — it does not know what a file is, and the folder
 * it is listing is not its business. That split is why there is a component here at all: the
 * composer needs a list that scrolls, opens upward from a control at the bottom of the window, and
 * can be walked with the keyboard, and `ui/ContextMenu.vue` is none of those three.
 *
 *  - **It opens upward and scrolls.** `bottom: calc(100% + 4px)` against the control that owns it,
 *    so the height of the list never decides the direction — a menu over its own trigger, or one
 *    running off the bottom of the window, is what the alternative produces once a folder holds
 *    more entries than a menu box can show. The bound is `SelectMenu`'s (`max-height: 280px`), and
 *    beyond it the list scrolls rather than growing.
 *  - **Its surface is `ui/ContextMenu.vue`'s, by value**: the same padding, radius, border,
 *    elevation, 30px rows and 14px icons, because two menus in one app that were meant to be the
 *    same menu should not disagree about their geometry. (The values are copied rather than shared;
 *    those two files are not this task's to merge.)
 *  - **Focus lands on the first row** when the list appears or changes, so the arrows and Enter work
 *    without the mouse, and a row that has been replaced under the reader (a folder walked into, a
 *    listing arriving) has no focus left on it.
 *
 * Escape and the outside click are the *parent's*: it owns both the control that opens the list and
 * the state that decides whether the list is up, and a second owner of that state is how a menu ends
 * up closed in one place and open in another. What happens to focus when the list goes away is the
 * parent's too, for the same reason — it knows the control to put it back on.
 */
import { nextTick, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  rows: readonly AgentReferenceRow[]
  /** Names the list for a screen reader. */
  label: string
}>()

const emit = defineEmits<{
  /** The row the reader took. */
  select: [id: string]
  /** Escape: the reader asked for the list to go away, and the control is where focus belongs. */
  close: []
  /** Tab: focus is moving on by itself, so the list goes with it and focus is left alone. */
  leave: []
}>()

const box = ref<HTMLElement | null>(null)

/** The rows the arrows may land on — a disabled one is readable, not a destination. */
function destinations(): HTMLButtonElement[] {
  const el = box.value
  if (el === null) return []
  return [...el.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')]
}

/** The first row of whatever list is showing now. Called on mount and on every change of rows:
 *  focus on a row that has been replaced is focus on nothing. A list with no destination — a
 *  folder being read, or one that is empty — takes focus itself, so Escape still has a listener
 *  and the reader is not left outside a menu that is on screen. */
function focusFirst(): void {
  void nextTick(() => {
    const first = destinations()[0]
    if (first !== undefined) first.focus()
    else box.value?.focus()
  })
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  // Tab is left to the browser: the rows are not tabbable, so the next stop is whatever follows
  // the control — but the list has to go with it, because a box left over the composer with no
  // focus inside it cannot be dismissed with the keyboard at all. Not prevented, so the move the
  // reader asked for still happens; `leave` is what tells the parent not to reach for focus.
  if (event.key === 'Tab') {
    emit('leave')
    return
  }
  const list = destinations()
  if (list.length === 0) return
  const at = list.indexOf(document.activeElement as HTMLButtonElement)
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    // Wraps, as the app's other menus do: the last row leads back to the first.
    const next = at < 0 ? 0 : (at + step + list.length) % list.length
    list[next]?.focus()
    return
  }
  if (event.key === 'Home') {
    event.preventDefault()
    list[0]?.focus()
    return
  }
  if (event.key === 'End') {
    event.preventDefault()
    list[list.length - 1]?.focus()
  }
}

onMounted(() => {
  focusFirst()
})

watch(() => props.rows, focusFirst)
</script>

<template>
  <div
    ref="box"
    class="agent-reference-menu"
    role="menu"
    tabindex="-1"
    :aria-label="label"
    @keydown="onKeydown"
  >
    <button
      v-for="row in rows"
      :key="row.id"
      class="agent-reference-row"
      type="button"
      role="menuitem"
      tabindex="-1"
      :disabled="row.disabled"
      @click="emit('select', row.id)"
    >
      <span class="agent-reference-icon">
        <component
          :is="row.icon"
          :size="14"
          :stroke-width="1.8"
        />
      </span>
      <span class="agent-reference-label">{{ row.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.agent-reference-menu {
  position: absolute;
  /* Upward from the control, whatever the list's height: this is a menu opened from the bottom row
     of a panel, and the one thing it must never do is cover the control it came from. */
  bottom: calc(100% + 4px);
  left: 0;
  z-index: 300;
  min-width: 200px;
  max-width: 280px;
  /* A folder is not a menu: past this bound the list scrolls, so a hundred entries cannot push
     the last of them off the screen where nothing can reach them. */
  max-height: 280px;
  overflow-y: auto;
  padding: 5px;
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-lg);
  background: color-mix(in srgb, var(--app-elevated) 96%, var(--app-panel));
  box-shadow: var(--app-shadow-menu);
  /* The growth comes out of the bottom edge, which is the edge shared with the control below. */
  transform-origin: bottom left;
}
.agent-reference-row {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  text-align: left;
  cursor: pointer;
}
.agent-reference-row:hover:not(:disabled),
.agent-reference-row:focus-visible {
  background: color-mix(in srgb, var(--app-elevated) 80%, var(--app-accent-soft));
  outline: none;
}
.agent-reference-row:disabled {
  color: var(--app-muted);
  cursor: default;
}
.agent-reference-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--app-muted);
}
.agent-reference-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The arrival: a region of the window, so the region rung of the motion scale, shortened for a
   reader who asked for less by the global reduced-motion rule. */
.agent-reference-menu.v-enter-active,
.agent-reference-menu.v-leave-active {
  transition: opacity var(--app-motion) var(--app-ease),
              transform var(--app-motion) var(--app-ease);
}
.agent-reference-menu.v-enter-from,
.agent-reference-menu.v-leave-to {
  opacity: 0;
  transform: translateY(calc(var(--app-motion-travel) * 1)) scale(var(--app-motion-scale-pop));
}
</style>
