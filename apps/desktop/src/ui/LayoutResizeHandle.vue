<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    label: string
    value: number
    min: number
    max: number
    defaultValue: number
    step?: number
    disabled?: boolean
    /**
     * The unit of `value`, which decides how a pointer drag maps onto it.
     *
     * `'px'` (the default) means `value` is a pixel size, so a pointer delta is
     * added directly — the sidebar and rail widths. `'fraction'` means `value`
     * is a 0..1 ratio of the track, so a pointer delta has to be divided by the
     * track's pixel width first; without that a single pixel of movement is a
     * whole ratio unit and the drag snaps straight to an extreme.
     */
    deltaUnit?: 'px' | 'fraction'
    /**
     * Which edge of the layout the resized pane is anchored to, which decides
     * how a pointer delta maps onto `value`.
     *
     * `'start'` (the default) is a pane whose handle grows RIGHTWARD as the
     * pane gets wider — the sidebar and the note-list column — so the pointer
     * delta is the value delta. `'end'` is a pane anchored to the right edge —
     * the info rail — whose handle grows LEFTWARD instead, so the same drag has
     * to be negated. Without this the rail followed the pointer backwards (drag
     * left, rail narrows and its edge moves right) and the arrow keys were
     * mirrored the same way. Getting it wrong is invisible on the two leading
     * handles, so a new handle has to state its side.
     */
    side?: 'start' | 'end'
  }>(),
  { step: 16, disabled: false, deltaUnit: 'px', side: 'start' },
)

const emit = defineEmits<{
  (e: 'change', value: number): void
  (e: 'resize-start'): void
  (e: 'resize-end'): void
}>()

const dragging = ref(false)
const rootEl = ref<HTMLElement | null>(null)

interface DragState {
  onMove: (event: PointerEvent) => void
  onUp: () => void
  flush: () => void
}

let drag: DragState | null = null

const previewX = ref<number | null>(null)

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/**
 * Pixels spanned by the full value range.
 *
 * Read from the handle's own parent at drag time rather than passed in: the
 * parent *is* the track, so the two cannot disagree, and a window resize
 * between drags needs no bookkeeping.
 */
function trackSize(): number {
  const parent = rootEl.value?.parentElement
  return parent ? parent.clientWidth : 0
}

function applyPointerDelta(clientX: number, startX: number, startValue: number): void {
  let delta = clientX - startX
  // Only the VALUE is mirrored for a trailing handle: the guide line stays on
  // the raw pointer, because it marks where the edge will land, not the value it
  // lands on.
  if (props.side === 'end') delta = -delta
  if (props.deltaUnit === 'fraction') {
    const size = trackSize()
    // Nothing measurable to divide by (hidden pane, detached element): leaving
    // the value alone beats snapping it to a bound.
    if (size <= 0) return
    delta /= size
  }
  emit('change', clamp(startValue + delta, props.min, props.max))
}

function stopDrag(): void {
  const current = drag
  if (!current) return
  drag = null
  dragging.value = false
  previewX.value = null
  document.body.classList.remove('is-layout-resizing')
  window.removeEventListener('pointermove', current.onMove)
  window.removeEventListener('pointerup', current.onUp)
  window.removeEventListener('pointercancel', current.onUp)
  emit('resize-end')
}

function onPointerDown(event: PointerEvent): void {
  if (props.disabled || event.button > 0) return
  event.preventDefault()
  const startX = event.clientX
  const startValue = props.value
  // VS Code style: while dragging we only show a guide line (previewX) and
  // never touch the layout width — the target sizes are committed on release.
  // pointermove fires far faster than the display can paint, so we rAF-throttle
  // the guide position; this keeps CodeMirror / Milkdown from relaying out on
  // every frame (the previous "change per frame" path is what felt stuck).
  let pendingClientX: number | null = null
  let lastClientX: number | null = null
  let raf = 0
  const onMove = (pointerEvent: PointerEvent): void => {
    lastClientX = pointerEvent.clientX
    pendingClientX = pointerEvent.clientX
    if (raf !== 0) return
    raf = requestAnimationFrame(() => {
      raf = 0
      if (pendingClientX === null) return
      previewX.value = pendingClientX
      pendingClientX = null
    })
  }
  // On release, commit the single final width change (the layout relayouts
  // once), then stop. `lastClientX` survives the rAF callback clearing
  // `pendingClientX`, so a release right after an already-flushed frame still
  // lands at the pointer's final position.
  const flush = (): void => {
    if (raf !== 0) {
      cancelAnimationFrame(raf)
      raf = 0
      previewX.value = lastClientX
    }
    pendingClientX = null
    if (lastClientX === null) return
    applyPointerDelta(lastClientX, startX, startValue)
  }
  const onUp = (): void => {
    flush()
    stopDrag()
  }
  drag = { onMove, onUp, flush }
  dragging.value = true
  document.body.classList.add('is-layout-resizing')
  try {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  } catch {
    // jsdom / older hosts lack pointer capture; window listeners still work.
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
  emit('resize-start')
}

function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    // Mirrored for a trailing handle as well: there ArrowLeft is the direction
    // that makes the pane wider, so the keys stay tied to the pane's growth
    // rather than to the screen direction.
    const step = event.key === 'ArrowRight' ? props.step : -props.step
    const delta = props.side === 'end' ? -step : step
    emit('change', clamp(props.value + delta, props.min, props.max))
    return
  }
  if (event.key === 'Home') {
    event.preventDefault()
    // Home is the pane's start, which for a trailing handle is its right edge —
    // the largest value, not the smallest.
    emit('change', props.side === 'end' ? props.max : props.min)
    return
  }
  if (event.key === 'End') {
    event.preventDefault()
    emit('change', props.side === 'end' ? props.min : props.max)
  }
}

function onDoubleClick(): void {
  if (props.disabled) return
  emit('change', clamp(props.defaultValue, props.min, props.max))
}

onBeforeUnmount(() => {
  stopDrag()
})
// The template has two roots (the handle and a teleported drag guide), so Vue
// cannot auto-inherit attributes. Without this the caller's class is dropped
// with a warning and the layout rule that targets it silently does nothing.
defineOptions({ inheritAttrs: false })
</script>

<template>
  <div
    ref="rootEl"
    v-bind="$attrs"
    class="layout-resize-handle"
    :class="{ 'is-active': dragging }"
    role="separator"
    :aria-label="label"
    aria-orientation="vertical"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="Math.round(value)"
    :aria-disabled="disabled || undefined"
    :tabindex="disabled ? -1 : 0"
    @pointerdown="onPointerDown"
    @dblclick="onDoubleClick"
    @keydown="onKeydown"
  />
  <Teleport to="body">
    <div
      v-if="previewX !== null"
      class="resize-guide-line"
      :style="{ left: `${previewX}px` }"
    />
  </Teleport>
</template>

<style scoped>
.layout-resize-handle {
  position: relative;
  flex: none;
  width: 8px;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: col-resize;
  touch-action: none;
}
.layout-resize-handle::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 2px;
  border-radius: 1px;
  background: transparent;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.layout-resize-handle:hover::after,
.layout-resize-handle:focus-visible::after,
.layout-resize-handle.is-active::after {
  background: color-mix(in srgb, var(--app-accent) 58%, transparent);
}
.layout-resize-handle:focus-visible {
  outline: none;
}
</style>

<style>
body.is-layout-resizing,
body.is-layout-resizing * {
  cursor: col-resize !important;
  user-select: none !important;
}
/* VS Code-style drag guide: a full-height accent line following the pointer.
   Rendered via Teleport to <body>, so it must live outside the scoped style. */
.resize-guide-line {
  position: fixed;
  top: 0;
  bottom: 0;
  width: 2px;
  transform: translateX(-1px);
  background: color-mix(in srgb, var(--app-accent) 62%, transparent);
  pointer-events: none;
  z-index: 9999;
}
</style>
