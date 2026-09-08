import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import SettingsPanel from './SettingsPanel.vue'
import { useAppearanceStore } from '../stores/appearance'
import { COLOR_SCHEMES } from '../stores/appearance'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const matchMediaMock = vi.fn(() => ({
  matches: false,
  media: '(prefers-color-scheme: dark)',
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
}))

let mounted: VueApp[] = []

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  localStorage.clear()
  setActivePinia(createPinia())
  globalThis.matchMedia = matchMediaMock as never
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

async function openAppearanceTab(): Promise<void> {
  mountPanel()
  const nav = Array.from(document.querySelectorAll<HTMLElement>('.nav-row'))
  const appearance = nav.find((n) => n.textContent?.includes('外观'))
  if (!appearance) throw new Error('appearance nav missing')
  appearance.click()
  await nextTick()
}

describe('SettingsPanel color scheme picker', () => {
  it('renders one labelled, selectable preview card per scheme', async () => {
    await openAppearanceTab()
    const cards = document.querySelectorAll<HTMLButtonElement>('.color-scheme-card')

    expect(cards.length).toBe(COLOR_SCHEMES.length)
    for (const card of cards) {
      expect(card.getAttribute('role')).toBe('radio')
      expect(card.getAttribute('aria-checked')).toBeTruthy()
      expect(card.querySelector('.color-scheme-preview')).toBeTruthy()
      expect(card.querySelectorAll('.color-scheme-swatch').length).toBe(1)
      expect(card.querySelector('.color-scheme-name')?.textContent?.trim().length).toBeGreaterThan(0)
    }
  })

  it('selects the clicked theme and marks it as the active radio', async () => {
    await openAppearanceTab()
    const appearance = useAppearanceStore()
    const ocean = document.querySelector<HTMLButtonElement>('[data-scheme="ocean"]')
    expect(ocean).toBeTruthy()
    ocean?.click()
    await nextTick()

    expect(appearance.colorScheme).toBe('ocean')
    expect(ocean?.getAttribute('aria-checked')).toBe('true')
  })
})
