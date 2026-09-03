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
  }>(),
  { step: 16, disabled: false },
)

const emit = defineEmits<{
  (e: 'change', value: number): void
  (e: 'resize-start'): void
  (e: 'resize-end'): void
}>()

const dragging = ref(false)

interface DragState {
  onMove: (event: PointerEvent) => void
  onUp: () => void
}

let drag: DragState | null = null

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

function applyPointerDelta(clientX: number, startX: number, startValue: number): void {
  emit('change', clamp(startValue + (clientX - startX), props.min, props.max))
}

function stopDrag(): void {
  const current = drag
  if (!current) return
  drag = null
  dragging.value = false
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
  const onMove = (pointerEvent: PointerEvent): void => {
    applyPointerDelta(pointerEvent.clientX, startX, startValue)
  }
  const onUp = (): void => {
    stopDrag()
  }
  drag = { onMove, onUp }
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
    const delta = event.key === 'ArrowLeft' ? -props.step : props.step
    emit('change', clamp(props.value + delta, props.min, props.max))
    return
  }
  if (event.key === 'Home') {
    event.preventDefault()
    emit('change', props.min)
    return
  }
  if (event.key === 'End') {
    event.preventDefault()
    emit('change', props.max)
  }
}

function onDoubleClick(): void {
  if (props.disabled) return
  emit('change', clamp(props.defaultValue, props.min, props.max))
}

onBeforeUnmount(() => {
  stopDrag()
})
</script>

<template>
  <div
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
</style>
