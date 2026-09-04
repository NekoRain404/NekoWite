<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
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
const toolbarEl = ref<HTMLElement | null>(null)

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
  if (!on) prevFocus = null
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
    v-if="inTable && editor"
    ref="toolbarEl"
    class="neko-table-menu"
    role="toolbar"
    :aria-label="t('tableMenu.aria')"
    @pointerdown.stop
    @click.stop
    @keydown="onKeydown"
    @focusin="onFocusin"
    @focusout="onFocusout"
  >
    <button
      v-for="op in ops"
      :key="op.id"
      type="button"
      class="neko-table-menu-btn"
      :title="op.label"
      :aria-label="op.label"
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
.neko-table-menu-btn:hover,
.neko-table-menu-btn:focus-visible {
  background: color-mix(in srgb, var(--app-accent) 16%, transparent);
  color: var(--app-accent);
  outline: none;
}
</style>
