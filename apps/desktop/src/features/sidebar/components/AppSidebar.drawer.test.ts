import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
    expect(host.querySelector('.nav-group .nav-label')).not.toBeNull()
    expect(host.querySelector('.nav-group .nav-label')?.getAttribute('aria-hidden')).toBe('true')
    expect(host.querySelector('.nav-group .nav-item')?.getAttribute('title')).toBeTruthy()

    drawerButton().click()
    await nextTick()

    expect(state.compact).toBe(false)
    expect(host.querySelector('.nav-group .nav-label')).not.toBeNull()
  })

  it('keeps drawer content mounted while width and vault-row position animate', () => {
    const componentDir = resolve(process.cwd(), 'src/features/sidebar/components')
    const sidebarStyles = readFileSync(resolve(componentDir, 'AppSidebar.vue'), 'utf8')
    const navigationStyles = readFileSync(resolve(componentDir, 'SidebarNavigation.vue'), 'utf8')

    expect(sidebarStyles).toMatch(/transition:\s*width var\(--app-motion\)/)
    expect(navigationStyles).toMatch(/transition:\s*height var\(--app-motion\)/)
    expect(navigationStyles).toMatch(/transition:\s*opacity var\(--app-motion-fast\)/)
    expect(navigationStyles).toMatch(/\.drawer-toggle\s*\{[^}]*transition:\s*right var\(--app-motion\)/)
    expect(navigationStyles).toMatch(/\.vault-row\.compact \.drawer-toggle\s*\{\s*right:\s*8px/)
  })
})
