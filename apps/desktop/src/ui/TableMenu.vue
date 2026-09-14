<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
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
import { useTableToolbar } from '../features/editor'
import { t } from '../i18n'

const props = defineProps<{ editor: NekoEditor | null }>()

const inTable = ref(false)
const toolbarEl = ref<HTMLElement | null>(null)

/**
 * The toolbar floats beside the table the caret is in (§2), and holds a
 * document-position bookmark of it (§3). Its panel is the editor's own scroll
 * container, which the composable finds from the editor's DOM: the toolbar is
 * rendered INSIDE that panel, so it must not have to exist first in order to
 * learn where it goes.
 */
const toolbar = useTableToolbar({
  getEditor: () => props.editor,
  inTable,
})

/** Position is the only thing that changes while the pane scrolls (§4). */
const toolbarStyle = computed(() => ({
  top: `${toolbar.top.value}px`,
  left: `${toolbar.left.value}px`,
}))

/** The operation the engine refused, so a button that cannot act says so
 *  instead of doing nothing (§3: the commands return a refusal). */
const refused = ref<string | null>(null)

function invoke(op: (typeof ops)[number]): void {
  // §3: the table this toolbar was raised for must still be the table at that
  // document position. A re-parse, an undo or an edit from elsewhere can move
  // it, and an action landing on the wrong table is the failure this prevents.
  if (!toolbar.stillValid()) return
  refused.value = null
  if (!op.run()) refused.value = op.id
}

// Focus management for the table toolbar (ARIA toolbar pattern): the toolbar is
// a non-modal `role="toolbar"` that never steals focus when the cursor enters a
// table. A keyboard user reaches it with Tab, then navigates with ArrowLeft/
// ArrowRight, activates with Enter/Space (native buttons), and Escapes back to
// the editor. While focus is inside the toolbar, Tab / Shift+Tab cycle within
// it (trapped); focus returns to the editor on Escape.
let prevFocus: HTMLElement | null = null

let unlisten: (() => void) | null = null
unlisten = onTableCursorChange((on) => {
  inTable.value = on
})

// When the toolbar hides (cursor leaves the table), forget the captured previous
// focus so the next keyboard entry re-captures the then-current element.
watch(inTable, (on) => {
  if (!on) {
    prevFocus = null
    refused.value = null
  }
})

// The toolbar is placed from its own measured size, so the first paint has to
// be measured before it can sit anywhere. `visible` comes from the composable,
// which decides it from the table's and the caret's own rects.
watch(
  () => toolbar.visible.value,
  async (on) => {
    if (!on) return
    await nextTick()
    toolbar.measure(toolbarEl.value)
  },
)

// Measure the toolbar's own box once it exists: the placement is anchored to
// its size, and its size is only known after a first paint.
watch(toolbarEl, (el) => {
  toolbar.measure(el)
})

const run = (fn: (view: ReturnType<NekoEditor['getView']>) => boolean): boolean => {
  if (!props.editor) return false
  return fn(props.editor.getView())
}

/**
 * Every operation reports whether it acted: the editor-core commands return
 * `false` when they refuse (the header row, the last remaining row or column),
 * and the toolbar surfaces that refusal instead of swallowing it (§3).
 *
 * `() => boolean`, not `() => void`: the narrow annotation erased the return
 * value, so `if (!op.run())` tested `!undefined` — always true — and EVERY
 * button rendered struck-through and `aria-disabled` after any click, including
 * the ones that had just worked.
 */
const ops: Array<{ id: string; label: string; run: () => boolean }> = [
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

function buttonsEls(): HTMLButtonElement[] {
  const el = toolbarEl.value
  if (!el) return []
  return [...el.querySelectorAll<HTMLButtonElement>('button')]
}

function focusButton(idx: number): void {
  const buttons = buttonsEls()
  if (buttons.length === 0) return
  const target = buttons[(idx + buttons.length) % buttons.length]
  target.focus()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    const prev = prevFocus
    prevFocus = null
    if (prev && prev.isConnected) prev.focus()
    return
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault()
    const buttons = buttonsEls()
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (idx < 0) return
    focusButton(idx + (e.key === 'ArrowRight' ? 1 : -1))
    return
  }
  if (e.key === 'Tab') {
    // Trap focus inside the toolbar while it is the focused region so a keyboard
    // user can cycle the actions without escaping to the editor.
    const buttons = buttonsEls()
    if (buttons.length === 0) return
    e.preventDefault()
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.shiftKey ? (idx <= 0 ? buttons.length - 1 : idx - 1) : idx < 0 ? 0 : (idx + 1) % buttons.length
    focusButton(next)
  }
}

function onFocusin(e: FocusEvent): void {
  // Capture the element that had focus before the toolbar only once (the first
  // focus entry), so Escape can restore it.
  if (!prevFocus) prevFocus = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null
}

function onFocusout(): void {
  // Reset the captured previous focus once focus leaves the toolbar entirely, so
  // a later keyboard entry re-captures the actual (possibly different) editor.
  if (toolbarEl.value?.contains(document.activeElement as Node)) return
  prevFocus = null
}

onBeforeUnmount(() => {
  unlisten?.()
  unlisten = null
})
</script>

<template>
  <div
    v-if="toolbar.visible.value && editor"
    ref="toolbarEl"
    class="neko-table-menu"
    :style="toolbarStyle"
    role="toolbar"
    :aria-label="t('tableMenu.aria')"
    @pointerdown.stop
    @click.stop
    @keydown="onKeydown"
    @focusin="onFocusin"
    @focusout="onFocusout"
  >
    <!-- `mousedown.prevent` and not a focus trap: a press on a button must not
         move the caret out of the cell it is about to act on (the same rule
         CodeMirror's search panel uses). Keyboard focus still reaches the
         buttons, so the ARIA toolbar below is unchanged for keyboard users. -->
    <button
      v-for="op in ops"
      :key="op.id"
      type="button"
      class="neko-table-menu-btn"
      :class="{ 'is-refused': refused === op.id }"
      :aria-disabled="refused === op.id || undefined"
      :title="refused === op.id ? `${op.label} — ${t('tableMenu.refused')}` : op.label"
      :aria-label="refused === op.id ? `${op.label} — ${t('tableMenu.refused')}` : op.label"
      @mousedown.prevent
      @click="invoke(op)"
    >
      {{ op.label }}
    </button>
  </div>
</template>

<style scoped>
.neko-table-menu {
  /* Fixed, because the placement is in viewport coordinates and the pane it is
     clamped to scrolls underneath it. Never `absolute` with a transform: this
     is a follow, not an entrance, and no easing may sit on it (§4). */
  position: fixed;
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
  /* The shared hover rung. This toolbar is the app's densest row of controls and
     it was the one row where a hover snapped: every other button in the app
     eases at this rung. */
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.neko-table-menu-btn.is-refused {
  color: var(--app-muted);
  text-decoration: line-through;
  opacity: 0.55;
}
.neko-table-menu-btn:hover,
.neko-table-menu-btn:focus-visible {
  background: color-mix(in srgb, var(--app-accent) 16%, transparent);
  color: var(--app-accent);
  outline: none;
}
</style>
