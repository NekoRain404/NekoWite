<script lang="ts">
/**
 * The menu's copy, handed in rather than reached for — the arrangement every control in this tree
 * uses: the caller supplies the words, and a missing sentence is a compile error.
 */
export interface AgentPanelMenuLabels {
  /** Names the menu to a screen reader, and is the trigger's accessible name as well. */
  label: string
}
</script>

<script setup lang="ts">
/**
 * The panel's options menu: the rows, the keys that walk them, and nothing else.
 *
 * It is the port of Zed's `render_panel_options_menu`
 * (`zed-main/crates/agent_ui/src/agent_panel.rs:5580`), which is how that panel reaches the
 * actions that live outside it — `ManageProfiles` (`:5790`) and `OpenSettings` (`:5796`) among
 * them. The shape is the same here: the menu is where the *rows* live, and acting on one is an
 * event, because nothing in this tree owns the settings dialog or the rail's switch.
 *
 * ## Why it is a component of its own rather than `ui/ContextMenu.vue`
 *
 * That menu is the app's context menu and it is anchored to a **point**: it is handed `x`/`y` and
 * dismisses on the first pointer press that is not inside it. Both are wrong for a control in a
 * tool strip. The anchor is the trigger, which moves — the bar wraps, a title grows — and a menu
 * placed at a stale point hangs in the gap beside its own control. And the trigger is not
 * "outside": its press owns the toggle, so point-anchored dismissal would close the menu on the
 * way to reopening it, and the control could never be used to shut what it opened.
 * `composables/use-detached-popup.ts` is this application's answer to exactly those two problems
 * — it takes the trigger *element*, re-places against it when either box changes size, and treats
 * a press on the trigger as the toggle rather than as a dismissal — and it is what the session
 * history and the config picker in this same panel already use.
 *
 * ## The two halves of the keyboard
 *
 * The trigger's half is the bar's (`AgentSessionBar`): `Enter`, `Space` and `ArrowDown` open, and
 * `Escape` closes while focus is still on the control. This file owns the other half — the keys
 * that apply once the focus is *inside* the menu, which is where it lands when the menu opens,
 * because a menu that needed a second press before its arrow keys worked would not be a menu.
 * Rows are `<button role="menuitem">`, so `Enter` and `Space` are the browser's own click; what is
 * left is the roving focus, and it is written the way `ui/ContextMenu.vue` writes it so a reader
 * who has learnt one of this app's menus has learnt both.
 *
 * `Escape` is handled here as well as on the trigger because the two never see the same key: the
 * claim `useDetachedPopup` takes silences the handlers behind the popup, and the trigger's own
 * handler cannot run while a row has focus.
 */
import { nextTick, ref } from 'vue'

/** One row: what to say, and the id the panel acts on. */
export interface AgentPanelMenuRow {
  id: string
  label: string
}

defineProps<{
  /** The rows to draw, in the order the panel decided. Empty is not drawn — see `AgentPanel`. */
  rows: readonly AgentPanelMenuRow[]
  labels: AgentPanelMenuLabels
  /** Where the panel's popup recipe put it, in viewport coordinates. */
  left: number
  top: number
  minWidth: number
  /** Which way it had to open, so the arrival comes from the control it belongs to rather than
   *  from the gap on the other side of it. */
  drop: 'down' | 'up'
}>()

const emit = defineEmits<{
  /** A row was chosen. The menu closes in the same breath — see `pick`. */
  select: [id: string]
  /** The menu is closing: Escape, a press outside, or the caller taking it away. */
  close: []
}>()

const rootEl = ref<HTMLElement | null>(null)

/** The element the panel measures to place the menu — it is the only layer that can reach it. */
function element(): HTMLElement | null {
  return rootEl.value
}

/** The rows that can take focus, in the order they are drawn. */
function items(): HTMLButtonElement[] {
  const el = rootEl.value
  if (el === null) return []
  return [...el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
}

/**
 * Put the keyboard on the first row.
 *
 * The panel calls this once the box exists rather than this file doing it on mount: the popup is
 * rendered under the caller's `v-if`, so on the component's own mount the element is not in the
 * document yet, and a focus that runs a frame too early lands on nothing.
 */
function focusFirst(): void {
  void nextTick(() => {
    items()[0]?.focus()
  })
}

/** Choose a row: the event leaves first, so the caller's own bookkeeping is not racing a
 *  `v-if` that has already taken the row away. */
function pick(row: AgentPanelMenuRow): void {
  emit('select', row.id)
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    // The handlers that have not run yet; the modal claim `useDetachedPopup` took is what
    // silences the ones that already have.
    event.stopPropagation()
    emit('close')
    return
  }
  if (event.key === 'Tab') {
    // Left to the browser: the popup is not in its path, so the next stop is whatever follows the
    // trigger — what "close and move on" means.
    emit('close')
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const list = items()
    if (list.length === 0) return
    const current = list.indexOf(document.activeElement as HTMLButtonElement)
    const offset = event.key === 'ArrowDown' ? 1 : -1
    const next = current < 0 ? 0 : (current + offset + list.length) % list.length
    list[next]?.focus()
    return
  }
  if (event.key === 'Home') {
    event.preventDefault()
    items()[0]?.focus()
    return
  }
  if (event.key === 'End') {
    event.preventDefault()
    const list = items()
    list[list.length - 1]?.focus()
  }
}

defineExpose({ element, focusFirst })
</script>

<template>
  <div
    ref="rootEl"
    class="agent-menu"
    :class="{ 'is-above': drop === 'up' }"
    data-agent-menu-popup
    role="menu"
    :aria-label="labels.label"
    :style="{ left: `${left}px`, top: `${top}px`, minWidth: `${minWidth}px` }"
    @keydown="onKeydown"
  >
    <button
      v-for="row in rows"
      :key="row.id"
      class="agent-menu-row"
      type="button"
      role="menuitem"
      tabindex="-1"
      :data-agent-menu-row="row.id"
      @click="pick(row)"
    >
      {{ row.label }}
    </button>
  </div>
</template>

<style scoped>
.agent-menu {
  position: fixed;
  /* Above the modal layer (10000) and below the toast layer (11000), as every popup in this app
     is — the same rung the config picker's list takes. */
  z-index: 10001;
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-width: 320px;
  padding: 5px;
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-lg);
  background: color-mix(in srgb, var(--app-elevated) 96%, var(--app-panel));
  box-shadow: var(--app-shadow-menu);
  /* The edge the control is on is the edge the menu grows out of, and which edge that is comes
     from `drop` — the placement the panel measured. Set on the base rule rather than on the
     transition classes, which Vue removes a frame into the transition, where the origin would
     snap to the centre mid-flight. */
  transform-origin: top right;
}
.agent-menu.is-above {
  transform-origin: bottom right;
}
.agent-menu-row {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 6px 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.agent-menu-row:hover {
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
}
.agent-menu-row:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -1px;
}
</style>
