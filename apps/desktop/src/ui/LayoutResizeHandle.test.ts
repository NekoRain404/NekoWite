import { describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import LayoutResizeHandle from './LayoutResizeHandle.vue'

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
})
