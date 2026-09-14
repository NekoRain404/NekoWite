<script setup lang="ts">
/**
 * The palette's mount point: the modal it raises, and the two global keys that
 * raise and dismiss it.
 *
 * What it offers and which row the arrows are on come from the feature's
 * composables and the rows are drawn by `PaletteList` (§13.3), so what is left
 * here is the on-screen lifecycle: the fade in and out with its cancellable
 * paint, the modal-stack claim that arbitrates Escape between two open dialogs,
 * the focus trap and the Ctrl+K listener. The component lives for the app's
 * whole life and renders nothing while closed, which is why those listeners are
 * its own rather than a parent's.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Search } from 'lucide-vue-next'
import { useFocusTrap } from '../composables/useFocusTrap'
import { isComposingKey } from '../services/keyGuard'
import { modalStack } from '../services/modalStack'
import {
  PALETTE_LIST_ID,
  PaletteList,
  usePaletteEntries,
  usePaletteNavigation,
  type PaletteEntry,
} from '../features/palette'
import { t } from '../i18n'

/**
 * How long a closing palette stays mounted, so its fade-out can run.
 *
 * Read from the token rather than restated: this was a hand-copied `160` while
 * the fade it has to cover runs on `--app-motion`, and the token moved to 180ms
 * without the copy following, so the last 20ms of the fade was cut off. Read
 * once — the value cannot change while the app is running — and fall back to a
 * number only where there is no stylesheet to read (a test environment, or the
 * first frame before tokens.css has landed).
 */
const MOTION_FALLBACK_MS = 180

let motionHold: number | null = null

function holdMs(): number {
  if (motionHold !== null) return motionHold
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--app-motion').trim()
  const value = raw.endsWith('ms')
    ? Number.parseFloat(raw)
    : raw.endsWith('s')
      ? Number.parseFloat(raw) * 1000
      : Number.NaN
  motionHold = Number.isFinite(value) && value > 0 ? value : MOTION_FALLBACK_MS
  return motionHold
}

const open = ref(false)
const visible = ref(false)
/** True from the moment a close begins until the fade-out finishes. */
const closing = ref(false)
const query = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
/** The listbox owns its element and scrolls the active row into view itself. */
const listRef = ref<InstanceType<typeof PaletteList> | null>(null)
// The palette declares aria-modal, so Tab has to stay inside it; the search
// input is focused explicitly by `show()`, so the trap only has to cycle.
const paletteEl = ref<HTMLElement | null>(null)
useFocusTrap(paletteEl, open, { initialFocus: false })

let hideTimer: ReturnType<typeof setTimeout> | null = null
// The deferred paint that turns the fade-in on. It has to be cancellable: a
// close that lands inside those two frames would otherwise let the stale paint
// re-set `visible` after `hide()` cleared it, leaving the palette flagged as
// on-screen while closed.
let paintRaf = 0
let prevFocus: HTMLElement | null = null

const { hasDocument, rows, flatRows, refreshForOpen } = usePaletteEntries({
  query,
  isOpen: () => open.value,
})

const { activeIndex, activeId, setActive, onInputKeydown } = usePaletteNavigation({
  flatRows: () => flatRows.value,
  activate: execute,
  query,
})

// Claimed while the palette is open: the most recently raised modal is the one
// Escape reaches. Claimed on open rather than in `onMounted` because the
// component is always mounted (it renders nothing while closed).
let modalToken: symbol | null = null

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function show(): void {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  if (!modalToken) modalToken = modalStack.claimModal('command-palette')
  open.value = true
  closing.value = false
  query.value = ''
  activeIndex.value = 0
  refreshForOpen()
  prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const paint = (): void => {
    paintRaf = 0
    visible.value = true
  }
  cancelPaint()
  if (prefersReducedMotion()) paint()
  else {
    // Two frames: the overlay must be laid out at opacity 0 for the CSS
    // transition to have a starting value to animate from.
    paintRaf = requestAnimationFrame(() => {
      paintRaf = requestAnimationFrame(paint)
    })
  }
  void nextTick(() => inputRef.value?.focus())
}

function cancelPaint(): void {
  if (paintRaf === 0) return
  cancelAnimationFrame(paintRaf)
  paintRaf = 0
}

function hide(): void {
  if (!open.value) return
  modalStack.releaseModal(modalToken)
  modalToken = null
  cancelPaint()
  visible.value = false
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
  // Nothing to cover without a fade: a reduced-motion user has no 180ms to wait
  // out, and holding the overlay anyway would hand them the one delay in the app
  // they cannot see and cannot avoid. The overlay stops taking pointer events
  // either way — see the closing rule in this component's second style block.
  if (prefersReducedMotion()) {
    open.value = false
    closing.value = false
  } else {
    closing.value = true
    hideTimer = setTimeout(() => {
      open.value = false
      closing.value = false
      hideTimer = null
    }, holdMs())
  }
  const el = prevFocus
  prevFocus = null
  if (el && el.isConnected) el.focus()
}

function execute(entry: PaletteEntry): void {
  hide()
  entry.run()
}

/** The highlight moved, so the listbox is asked to keep the row it landed on
 *  in view. The DOM is the listbox's to touch; the index is ours. */
function scrollActiveIntoView(): void {
  listRef.value?.scrollActiveIntoView(activeIndex.value)
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if (isComposingKey(e)) return
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    // The palette is a modal. Raising it over another open modal (the settings
    // panel is also z-index 10000) put two dialogs on screen with no defined
    // order, and one Escape then closed both.
    e.preventDefault()
    e.stopPropagation()
    // Gated on the logical state, not on `visible`: the fade-in is deferred by
    // two frames, so just after opening `visible` is still false and keying off
    // it would make the first Ctrl+K press open rather than close.
    //
    // A palette that is mid fade-out counts as closed here so the press
    // revives it — otherwise a quick Escape-then-Ctrl+K would be swallowed by
    // `hide()` and the palette would look like it refused to reopen.
    if (open.value && !closing.value) hide()
    else show()
    return
  }
  // `open` again: Escape must work the instant the palette appears, which is
  // before the deferred fade-in has painted.
  if (open.value && e.key === 'Escape') {
    // Several dialogs listen for Escape on window/document, and stopPropagation
    // does not stop the listeners already queued on the same target: without
    // this arbitration one Escape closed the palette AND the settings panel.
    if (!modalStack.isTopModal(modalToken)) return
    e.preventDefault()
    e.stopPropagation()
    hide()
  }
}

// The query and a shrinking result list reset and clamp the highlight inside
// `usePaletteNavigation`; only the scroll follows from here.
watch(activeIndex, () => {
  void nextTick(scrollActiveIntoView)
})

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown, true)
})

onBeforeUnmount(() => {
  modalStack.releaseModal(modalToken)
  modalToken = null
  window.removeEventListener('keydown', onGlobalKeydown, true)
  if (hideTimer) clearTimeout(hideTimer)
  cancelPaint()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="palette-overlay"
      :class="{ 'is-open': visible }"
      role="presentation"
      @pointerdown.self="hide"
    >
      <div
        ref="paletteEl"
        class="palette"
        role="dialog"
        aria-modal="true"
        :aria-label="t('palette.aria')"
      >
        <div class="palette-search">
          <Search
            class="palette-search-icon"
            :size="15"
            :stroke-width="1.8"
          />
          <input
            ref="inputRef"
            v-model="query"
            class="palette-input"
            type="text"
            :placeholder="t('palette.placeholder')"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            :aria-controls="PALETTE_LIST_ID"
            :aria-activedescendant="activeId"
            autocomplete="off"
            spellcheck="false"
            @keydown="onInputKeydown"
          >
        </div>
        <p
          v-if="!hasDocument"
          class="palette-note"
        >
          {{ t('palette.noDocument') }}
        </p>
        <PaletteList
          ref="listRef"
          :rows="rows"
          :active-index="activeIndex"
          :show-empty="!flatRows.length && hasDocument"
          @activate="execute"
          @highlight="setActive"
        />
        <div class="palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> {{ t('palette.footerSelect') }}</span>
          <span><kbd>Enter</kbd> {{ t('palette.footerExecute') }}</span>
          <span><kbd>Esc</kbd> {{ t('palette.footerClose') }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped src="../features/palette/styles/commandPalette.css"></style>

<style scoped>
/* The overlay is `position: fixed; inset: 0` and stays in the tree for the
   length of its fade-out. At `opacity: 0` it still hit-tests, so for those 180ms
   the whole screen was dead: a click meant for the note under it reached the
   overlay instead, and `@pointerdown.self` re-entered the close. The palette is
   usable only while it is actually shown, so it may only take the pointer then —
   which also covers the two frames between opening and the deferred paint.
   (The fade itself stays in the stylesheet beside the feature; this is the one
   thing about it the component owns, because it is the component that knows
   whether the palette is showing.) */
.palette-overlay:not(.is-open) {
  pointer-events: none;
}
</style>
