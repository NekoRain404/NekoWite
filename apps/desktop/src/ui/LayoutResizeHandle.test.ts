import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import LayoutResizeHandle from './LayoutResizeHandle.vue'

// Controllable rAF stub so drag tests are deterministic (no real frame timing).
let rafQueue: Array<(time: number) => void> = []

function stubRaf(): void {
  rafQueue = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
}

function flushRaf(): void {
  const q = rafQueue
  rafQueue = []
  for (const cb of q) cb(0)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

interface Harness {
  app: VueApp
  host: HTMLElement
  el: HTMLElement
  changes: number[]
  resizeEnds: number
}

function mountHandle(props: Record<string, unknown>): Harness {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const changes: number[] = []
  let resizeEnds = 0
  const app = createApp(LayoutResizeHandle, {
    label: '测试分隔条',
    ...props,
    onChange: (value: number) => changes.push(value),
    onResizeEnd: () => {
      resizeEnds++
    },
  })
  app.mount(host)
  const el = host.querySelector('.layout-resize-handle')
  if (!el) throw new Error('handle did not render')
  return { app, host, el: el as HTMLElement, changes, resizeEnds }
}

function keydown(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

function dblclick(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
}

describe('LayoutResizeHandle', () => {
  it('renders as a focusable separator with aria bounds', () => {
    const h = mountHandle({ value: 232, min: 180, max: 400, defaultValue: 232 })
    expect(h.el.getAttribute('role')).toBe('separator')
    expect(h.el.getAttribute('aria-orientation')).toBe('vertical')
    expect(h.el.getAttribute('aria-valuemin')).toBe('180')
    expect(h.el.getAttribute('aria-valuemax')).toBe('400')
    expect(h.el.getAttribute('aria-valuenow')).toBe('232')
    expect(h.el.getAttribute('tabindex')).toBe('0')
    h.app.unmount()
  })

  it('emits clamped values for arrow keys and extremes', () => {
    const h = mountHandle({ value: 232, min: 180, max: 400, defaultValue: 232 })
    keydown(h.el, 'ArrowRight')
    expect(h.changes.at(-1)).toBe(248)
    keydown(h.el, 'ArrowLeft')
    expect(h.changes.at(-1)).toBe(216)
    keydown(h.el, 'Home')
    expect(h.changes.at(-1)).toBe(180)
    keydown(h.el, 'End')
    expect(h.changes.at(-1)).toBe(400)
    h.app.unmount()
  })

  it('resets to the default on double click', () => {
    const h = mountHandle({ value: 380, min: 180, max: 400, defaultValue: 232 })
    dblclick(h.el)
    expect(h.changes).toEqual([232])
    h.app.unmount()
  })

  it('supports fractional steps for ratio handles', () => {
    const h = mountHandle({ value: 0.5, min: 0.25, max: 0.75, defaultValue: 0.5, step: 0.02 })
    keydown(h.el, 'ArrowRight')
    expect(h.changes.at(-1)).toBeCloseTo(0.52, 5)
    h.app.unmount()
  })

  it('does not react while disabled', () => {
    const h = mountHandle({ value: 232, min: 180, max: 400, defaultValue: 232, disabled: true })
    expect(h.el.getAttribute('tabindex')).toBe('-1')
    keydown(h.el, 'ArrowRight')
    dblclick(h.el)
    expect(h.changes).toEqual([])
    h.app.unmount()
  })

  it('stops dragging when unmounted mid-drag', async () => {
    const h = mountHandle({ value: 232, min: 180, max: 400, defaultValue: 232 })
    h.el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 10, bubbles: true }))
    expect(document.body.classList.contains('is-layout-resizing')).toBe(true)
    h.app.unmount()
    await nextTick()
    expect(document.body.classList.contains('is-layout-resizing')).toBe(false)
  })

  it('shows a guide line during drag and commits a single change on release', async () => {
    stubRaf()
    const h = mountHandle({ value: 200, min: 180, max: 400, defaultValue: 200 })
    h.el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 110, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 120, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 130, bubbles: true }))
    // VS Code style: while dragging no width is committed — only the guide line.
    expect(h.changes).toEqual([])
    flushRaf()
    expect(h.changes).toEqual([])
    await nextTick()
    expect(document.body.querySelector('.resize-guide-line')).not.toBeNull()
    // Release commits the single final width change using the last clientX.
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    expect(h.changes).toEqual([230])
    await nextTick()
    expect(document.body.querySelector('.resize-guide-line')).toBeNull()
    h.app.unmount()
  })

  it('flushes the pending move on pointer up (no frame elapsed)', () => {
    stubRaf()
    const h = mountHandle({ value: 200, min: 180, max: 400, defaultValue: 200 })
    h.el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 110, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    expect(h.changes).toEqual([210])
    h.app.unmount()
  })

  it('clamps the committed dragged value into the handle bounds', () => {
    stubRaf()
    const h = mountHandle({ value: 200, min: 180, max: 400, defaultValue: 200 })
    h.el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 500, bubbles: true }))
    flushRaf()
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    expect(h.changes).toEqual([400])
    h.app.unmount()
  })
})
