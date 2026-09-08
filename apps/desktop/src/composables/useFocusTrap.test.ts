/* eslint-disable vue/one-component-per-file -- a test file legitimately defines
 * a small host component via defineComponent to exercise the focus trap. */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Ref } from 'vue'

import { useFocusTrap } from './useFocusTrap'

let mounted: VueApp[] = []

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

/** Minimal host that renders a dialog container with two focusable buttons.
 *  `activeRef` is supplied by the test so the trap can be toggled externally. */
const Host = defineComponent({
  props: { activeRef: { type: Object, required: true } },
  setup(props) {
    const container = ref<HTMLElement | null>(null)
    useFocusTrap(container, props.activeRef as Ref<boolean>)
    return () =>
      h('div', { ref: container, class: 'dialog' }, [
        h('button', { class: 'first' }, 'First'),
        h('button', { class: 'second' }, 'Second'),
      ])
  },
})

function mount(active: Ref<boolean>): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(Host, { activeRef: active })
  app.mount(host)
  mounted.push(app)
}

const settle = async (): Promise<void> => {
  await nextTick()
  await new Promise((r) => setTimeout(r, 0))
}

describe('useFocusTrap', () => {
  it('focuses the first focusable element on activation', async () => {
    mount(ref(true))
    await settle()
    expect(document.querySelector<HTMLElement>('.first')).toBe(document.activeElement)
  })

  it('wraps forward to the first element when tabbing from the last element', async () => {
    mount(ref(true))
    await settle()
    document.querySelector<HTMLElement>('.second')!.focus()
    const dialog = document.querySelector<HTMLDivElement>('.dialog')!
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.querySelector<HTMLElement>('.first')).toBe(document.activeElement)
  })

  it('wraps backward to the last element when shift-tabbing from the first element', async () => {
    mount(ref(true))
    await settle()
    document.querySelector<HTMLElement>('.first')!.focus()
    const dialog = document.querySelector<HTMLDivElement>('.dialog')!
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    expect(document.querySelector<HTMLElement>('.second')).toBe(document.activeElement)
  })

  it('keeps focus inside the container when tabbing from a non-focusable start', async () => {
    mount(ref(true))
    await settle()
    const dialog = document.querySelector<HTMLDivElement>('.dialog')!
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBeTruthy()
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('restores focus to the previously focused element on deactivation', async () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()

    const active = ref(true)
    mount(active)
    await settle()
    active.value = false
    await settle()
    expect(document.activeElement).toBe(outside)
  })

  it('does nothing when active stays false', async () => {
    mount(ref(false))
    await settle()
    expect(document.activeElement).not.toBe(document.querySelector<HTMLElement>('.first'))
  })
})
