import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'

import ViewSwitch from './ViewSwitch.vue'
import { useViewStore } from '../stores/view'

let pinia: Pinia
let mounted: VueApp[] = []
let host: HTMLElement | null = null

afterEach(() => {
  for (const app of mounted) app.unmount()
  mounted = []
  host?.remove()
  host = null
})

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(ViewSwitch)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
}

describe('ViewSwitch', () => {
  it('exposes tablist/tab semantics with the active mode marked selected', () => {
    pinia = createPinia()
    setActivePinia(pinia)
    useViewStore().setMode('source')
    mount()
    expect(host!.querySelector('.view-switch')?.getAttribute('role')).toBe('tablist')
    const tabs = [...host!.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs).toHaveLength(3)
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')
    expect(tabs[2]?.getAttribute('aria-selected')).toBe('false')
  })

  it('updates aria-selected when the mode changes', async () => {
    pinia = createPinia()
    setActivePinia(pinia)
    const view = useViewStore()
    mount()
    view.setMode('split')
    await nextTick()
    const tabs = [...host!.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs[2]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('false')
  })
})
