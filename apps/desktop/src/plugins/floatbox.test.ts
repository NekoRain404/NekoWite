import { beforeEach, describe, expect, it } from 'vitest'
import { createApp, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import {
  FloatBox,
  canAdjust,
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

  it('canAdjust requires both a view and a selection', () => {
    const store = useFloatStore()
    const view = {} as never
    expect(canAdjust(view)).toBe(false)
    store.select('5', 5)
    expect(canAdjust(view)).toBe(true)
    store.select(null)
    expect(canAdjust(view)).toBe(false)
  })

  it('canAdjust returns false when the view is missing', () => {
    const store = useFloatStore()
    store.select('5', 5)
    expect(canAdjust(null)).toBe(false)
  })
})

describe('floatbox geometry', () => {
  it('normalizes missing props', () => {
    expect(normalizeProps({})).toEqual({ x: 0, y: 0, w: 240, h: 160, angle: 0, z: 1 })
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
  })

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
})