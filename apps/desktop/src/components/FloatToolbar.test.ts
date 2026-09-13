import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'

import FloatToolbar from './FloatToolbar.vue'
import { t } from '../i18n'

let mounted: VueApp[] = []

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

function mount(selectedId: string | null, emits: Record<string, unknown>): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(FloatToolbar, { selectedId, ...emits } as never)
  app.mount(host)
  mounted.push(app)
}

function buttons(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>('.float-toolbar .btn')]
}

describe('FloatToolbar', () => {
  it('stays hidden while no floating box is selected', () => {
    mount(null, {})
    expect(document.body.querySelector('.float-toolbar')).toBeNull()
  })

  it('appears for the selected box with one button per action', () => {
    mount('box-1', {})
    expect(buttons()).toHaveLength(3)
    expect(buttons().map((b) => b.textContent?.trim())).toEqual([
      t('floatToolbar.bringForward'),
      t('floatToolbar.sendBackward'),
      t('common.delete'),
    ])
  })

  it('reports each action as an event instead of calling a store itself', () => {
    // §10.2: the toolbar displays and forwards events. The caller (EditorPane)
    // owns the float store, so every press has to arrive there as an event —
    // this pins the contract that replaced the component's own store calls.
    const bringForward = vi.fn()
    const sendBackward = vi.fn()
    const remove = vi.fn()
    mount('box-1', { onBringForward: bringForward, onSendBackward: sendBackward, onRemove: remove })

    buttons()[0]!.click()
    expect(bringForward).toHaveBeenCalledTimes(1)
    expect(sendBackward).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()

    buttons()[1]!.click()
    expect(sendBackward).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()

    // The delete button keeps the danger styling: it is the destructive one.
    const removeBtn = buttons()[2]!
    expect(removeBtn.classList.contains('btn-danger')).toBe(true)
    removeBtn.click()
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('keeps the tooltips of every action', () => {
    mount('box-1', {})
    expect(buttons().map((b) => b.getAttribute('title'))).toEqual([
      t('floatToolbar.bringForward'),
      t('floatToolbar.sendBackward'),
      t('common.delete'),
    ])
  })
})
