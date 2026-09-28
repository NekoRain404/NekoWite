import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import AppSidebar from './AppSidebar.vue'
import { setLocale, t } from '../../../i18n'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

let app: VueApp | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  setLocale('zh')
  setActivePinia(createPinia())
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('sidebar icon drawer', () => {
  it('keeps navigation icons and commands available when collapsed, and restores labels', async () => {
    const state = reactive({ compact: false })
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp({
      render: () => h(AppSidebar, {
        vault: '/notes/vault',
        compact: state.compact,
        onToggleCompact: () => { state.compact = !state.compact },
      }),
    })
    app.use(createPinia())
    app.mount(host)

    const drawerButton = () => host!.querySelector<HTMLButtonElement>('[data-test="sidebar-drawer-toggle"]')!
    expect(drawerButton().title).toBe(t('nav.collapseDrawer'))
    expect(host.querySelector('.nav-group .nav-label')).not.toBeNull()

    drawerButton().click()
    await nextTick()

    expect(state.compact).toBe(true)
    expect(host.querySelector('.sidebar')?.classList.contains('compact')).toBe(true)
    expect(drawerButton().title).toBe(t('nav.expandDrawer'))
    expect(host.querySelector('.nav-group .nav-icon')).not.toBeNull()
    expect(host.querySelector('.nav-group .nav-label')).toBeNull()
    expect(host.querySelector('.nav-group .nav-item')?.getAttribute('title')).toBeTruthy()

    drawerButton().click()
    await nextTick()

    expect(state.compact).toBe(false)
    expect(host.querySelector('.nav-group .nav-label')).not.toBeNull()
  })
})
