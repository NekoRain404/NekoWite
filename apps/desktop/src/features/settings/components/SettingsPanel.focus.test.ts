import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import SettingsPanel from './SettingsPanel.vue'
import { setLocale } from '../../../i18n'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

let mounted: VueApp[] = []

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  localStorage.clear()
  setLocale('zh')
  setActivePinia(createPinia())
  globalThis.matchMedia = vi.fn(() => ({
    matches: false,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as never
  document.body.innerHTML = ''
  mounted = []
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

function mountPanel(): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(SettingsPanel, { onClose: vi.fn(), onSaved: vi.fn() } as never)
  app.mount(host)
  mounted.push(app)
}

/** Let the focus trap's deferred first focus land. */
async function settle(): Promise<void> {
  await nextTick()
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

describe('SettingsPanel modal focus', () => {
  it('keeps repeated Tab presses inside the panel', async () => {
    mountPanel()
    await settle()

    const panel = document.body.querySelector<HTMLElement>('.settings-dialog')!
    expect(panel.contains(document.activeElement)).toBe(true)

    for (let i = 0; i < 40; i++) {
      const before = document.activeElement as HTMLElement | null
      const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      before?.dispatchEvent(ev)
      await settle()
      expect(panel.contains(document.activeElement)).toBe(true)
    }
  })

  it('shows the AI section labels in the active locale, not hard-coded English', async () => {
    // Provider / Model / Base URL / API Key were hard-coded English while their
    // translations already existed (and were unused), so the Chinese UI had
    // four stray English labels in the AI section.
    mountPanel()
    await settle()

    const nav = [...document.querySelectorAll<HTMLElement>('.nav-row')]
    nav.find((n) => n.textContent?.includes('AI'))!.click()
    await settle()

    // Found by the provider dropdown it renders, which is the control that
    // identifies the section regardless of what else lives in it.
    const aiSection = document.getElementById('settings-ai-provider')!
      .closest<HTMLElement>('.settings-section')!
    const labels = [...aiSection.querySelectorAll('label > span:first-child')]
      .map((el) => el.textContent?.trim() ?? '')
    expect(labels).toContain('服务商')
    expect(labels).toContain('模型')
    expect(labels.some((l) => /^Base URL$/.test(l))).toBe(false)
  })

  it('renders its sections as an ARIA tablist with exactly one active section', async () => {
    mountPanel()
    await settle()

    const list = document.body.querySelector<HTMLElement>('.dialog-nav')!
    expect(list.getAttribute('role')).toBe('tablist')
    const rows = [...list.querySelectorAll<HTMLElement>('.nav-row')]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter((r) => r.getAttribute('aria-selected') === 'true')).toHaveLength(1)
    expect(rows.filter((r) => r.classList.contains('active'))).toHaveLength(1)
  })
})
