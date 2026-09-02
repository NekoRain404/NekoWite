import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import App from './App.vue'
import { useAppearanceStore } from './stores/appearance'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const mediaListeners = new Map<string, Set<() => void>>()
const mediaMatches = new Map<string, boolean>()

const matchMediaStub = vi.fn((query: string) => ({
  get matches(): boolean {
    return mediaMatches.get(query) ?? false
  },
  media: query,
  onchange: null,
  addEventListener(_type: string, cb: () => void): void {
    let set = mediaListeners.get(query)
    if (!set) {
      set = new Set()
      mediaListeners.set(query, set)
    }
    set.add(cb)
  },
  removeEventListener(_type: string, cb: () => void): void {
    mediaListeners.get(query)?.delete(cb)
  },
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
}))

let mounted: VueApp[] = []

function mountApp(pinia: Pinia): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(App)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  const shell = host.querySelector('.shell')
  if (!shell) throw new Error('App did not render a .shell root')
  return shell as HTMLElement
}

describe('App root theme/accent binding', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
    document.body.innerHTML = ''
    mounted = []
    mediaListeners.clear()
    mediaMatches.clear()
    globalThis.matchMedia = matchMediaStub as never
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  it('binds data-theme and data-accent from the appearance store', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const appearance = useAppearanceStore()
    appearance.setTheme('dark')
    appearance.setAccent('violet')

    const shell = mountApp(pinia)
    await nextTick()

    expect(shell.getAttribute('data-theme')).toBe('dark')
    expect(shell.getAttribute('data-accent')).toBe('violet')
  })

  it('refollows the OS theme when system and the media query changes', async () => {
    mediaMatches.set('(prefers-color-scheme: dark)', false)
    const pinia = createPinia()
    setActivePinia(pinia)
    const appearance = useAppearanceStore()
    appearance.setTheme('system')

    const shell = mountApp(pinia)
    await nextTick()
    expect(shell.getAttribute('data-theme')).toBe('light')

    mediaMatches.set('(prefers-color-scheme: dark)', true)
    mediaListeners.get('(prefers-color-scheme: dark)')?.forEach((cb) => cb())
    await nextTick()

    expect(shell.getAttribute('data-theme')).toBe('dark')
  })
})