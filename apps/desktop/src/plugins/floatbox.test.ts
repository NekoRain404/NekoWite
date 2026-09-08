import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import {
  FloatBox,
  getCurrentSelectedId,
  subscribeSelection,
  unsubscribeSelection,
} from './floatbox'
import { useFloatStore } from '../stores/float'
import {
  applyDrag,
  applyResize,
  applyRotate,
  normalizeProps,
} from '../services/floatProps'

describe('floatbox selection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    unsubscribeSelection()
  })

  it('subscribeSelection mirrors the store selected id', () => {
    const unsub = subscribeSelection()
    const store = useFloatStore()
    store.select('5', 5)
    expect(getCurrentSelectedId()).toBe('5')
    store.select('7', 7)
    expect(getCurrentSelectedId()).toBe('7')
    store.select(null)
    expect(getCurrentSelectedId()).toBeNull()
    unsub()
  })

  it('unsubscribed callbacks stop updating the module id', () => {
    const unsub = subscribeSelection()
    const store = useFloatStore()
    store.select('5', 5)
    unsub()
    store.select('7', 7)
    expect(getCurrentSelectedId()).toBe('5')
  })

  it('unsubscribeSelection resets the cached selected id', () => {
    const unsub = subscribeSelection()
    const store = useFloatStore()
    store.select('5', 5)
    expect(getCurrentSelectedId()).toBe('5')
    unsubscribeSelection()
    expect(getCurrentSelectedId()).toBeNull()
    unsub()
  })
})

describe('floatbox geometry', () => {
  it('normalizes missing props', () => {
    expect(normalizeProps({})).toEqual({ x: 0, y: 0, w: 240, h: 160, angle: 0, z: 1 })
  })
  it('falls back to defaults for junk numeric props', () => {
    expect(normalizeProps({ x: 'abc', y: '1e', w: 'oops', z: '0x' })).toEqual({
      x: 0,
      y: 0,
      w: 240,
      h: 160,
      angle: 0,
      z: 1,
    })
  })
  it('keeps finite numeric props', () => {
    expect(normalizeProps({ x: '10.5', y: '-3', angle: '90' })).toEqual({
      x: 10.5,
      y: -3,
      w: 240,
      h: 160,
      angle: 90,
      z: 1,
    })
  })
  it('drag adds delta', () => {
    expect(applyDrag({ x: 10, y: 20 }, 5, -3)).toEqual({ x: 15, y: 17 })
  })
  it('se-resize grows w/h', () => {
    expect(applyResize({ x: 0, y: 0, w: 100, h: 50 }, 'se', 10, 20)).toEqual({ x: 0, y: 0, w: 110, h: 70 })
  })
  it('nw-resize shifts x/y and grows', () => {
    expect(applyResize({ x: 50, y: 40, w: 100, h: 50 }, 'nw', -5, -10)).toEqual({ x: 45, y: 30, w: 105, h: 60 })
  })
  it('resize clamps minimum size', () => {
    expect(applyResize({ x: 0, y: 0, w: 30, h: 30 }, 'se', -100, -100)).toEqual({ x: 0, y: 0, w: 20, h: 20 })
  })
  it('rotate adds angle delta', () => {
    expect(applyRotate({ angle: 15 }, 5)).toEqual({ angle: 20 })
  })
})

describe('FloatBox content editing', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
    // Reset any lingering module-level drag session between tests.
    window.dispatchEvent(new PointerEvent('pointerup'))
  })

  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => requestAnimationFrame(() => resolve()))

  const mountDragHarness = () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const node = {
      type: { name: 'mdxComponent' },
      nodeSize: 2,
      attrs: { name: 'FloatBox', props: { x: '10', y: '20' }, children: '' },
    }
    const tr: { setNodeMarkup: ReturnType<typeof vi.fn> } = {
      setNodeMarkup: vi.fn((...args: unknown[]) => args),
    }
    const view = {
      state: { doc: { nodeAt: vi.fn(() => node) }, tr },
      dispatch: vi.fn(),
    }
    const app = createApp(
      h(FloatBox, {
        x: '10',
        y: '20',
        w: '100',
        h: '50',
        angle: '0',
        z: '1',
        children: 'text',
        _view: view as never,
        _getPos: () => 0,
      }),
    )
    app.mount(host)
    const root = host.querySelector<HTMLElement>('.float-box')!
    const content = host.querySelector<HTMLElement>('.fb-content')!
    return { host, node, tr, view, app, root, content }
  }

  it('seeds the contenteditable with children and reflects geometry in style', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(
      h(FloatBox, {
        x: '10',
        y: '20',
        w: '100',
        h: '50',
        angle: '15',
        z: '3',
        children: '浮动内容 hello',
      }),
    )
    app.mount(host)
    const content = host.querySelector<HTMLElement>('.fb-content')
    expect(content).not.toBeNull()
    expect(content!.textContent).toBe('浮动内容 hello')
    const root = host.querySelector<HTMLElement>('.float-box')
    expect(root!.style.left).toBe('10px')
    expect(root!.style.transform).toContain('rotate(15deg)')
    app.unmount()
  })

  it('pointerdown on the box root starts a drag and updates x/y', async () => {
    const { tr, view, app, root } = mountDragHarness()
    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 15, clientY: 25 }))
    await nextFrame()
    expect(view.dispatch).toHaveBeenCalledTimes(1)
    const markupArgs = (tr.setNodeMarkup as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(markupArgs[0]).toBe(0)
    expect(markupArgs[2]).toEqual({
      name: 'FloatBox',
      props: { x: '20', y: '40' },
      children: '',
    })
    window.dispatchEvent(new PointerEvent('pointerup'))
    app.unmount()
  })

  it('coalesces rapid pointermoves into a single dispatch per frame', async () => {
    const { tr, view, app, root } = mountDragHarness()
    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 15, clientY: 25 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 20, clientY: 30 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 25, clientY: 35 }))
    await nextFrame()
    expect(view.dispatch).toHaveBeenCalledTimes(1)
    const markupArgs = (tr.setNodeMarkup as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(markupArgs[0]).toBe(0)
    expect(markupArgs[2]).toEqual({
      name: 'FloatBox',
      props: { x: '30', y: '50' },
      children: '',
    })
    window.dispatchEvent(new PointerEvent('pointerup'))
    app.unmount()
  })

  it('flushes the last pending delta synchronously on pointerup', () => {
    const { tr, view, app, root } = mountDragHarness()
    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 15, clientY: 25 }))
    window.dispatchEvent(new PointerEvent('pointerup'))
    expect(view.dispatch).toHaveBeenCalledTimes(1)
    const markupArgs = (tr.setNodeMarkup as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(markupArgs[0]).toBe(0)
    expect(markupArgs[2]).toEqual({
      name: 'FloatBox',
      props: { x: '20', y: '40' },
      children: '',
    })
    app.unmount()
  })

  it('pointerdown on the content area selects but does not start a drag', () => {
    const { view, app, content } = mountDragHarness()
    content.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 50, clientY: 50 }))
    expect(view.dispatch).not.toHaveBeenCalled()
    window.dispatchEvent(new PointerEvent('pointerup'))
    app.unmount()
  })
})
