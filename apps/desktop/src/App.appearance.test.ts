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

describe('App root layout variable binding', () => {
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

  it('binds sidebar/rail widths and body typography as CSS variables', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const appearance = useAppearanceStore()
    appearance.setSidebarWidth(300)
    appearance.setRailWidth(360)
    appearance.setBodyFontSize(17)
    appearance.setLineHeight(2)

    const shell = mountApp(pinia)
    await nextTick()

    expect(shell.style.getPropertyValue('--app-sidebar-width')).toBe('300px')
    expect(shell.style.getPropertyValue('--app-rail-width')).toBe('360px')
    expect(shell.style.getPropertyValue('--app-body-size')).toBe('17px')
    expect(shell.style.getPropertyValue('--app-line-height')).toBe('2')

    appearance.setSidebarWidth(999)
    appearance.setBodyFontSize(1)
    await nextTick()

    expect(shell.style.getPropertyValue('--app-sidebar-width')).toBe('520px')
    expect(shell.style.getPropertyValue('--app-body-size')).toBe('12px')
  })

  it('binds interface/editor/mono font families as CSS variables and the locale', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const appearance = useAppearanceStore()
    appearance.setUiFont('serif')
    appearance.setEditorFont('reading')
    appearance.setMonoFont('cascadia')

    const shell = mountApp(pinia)
    await nextTick()

    expect(shell.style.getPropertyValue('--app-font')).toContain('Georgia')
    expect(shell.style.getPropertyValue('--app-editor-font')).toContain('Literata')
    expect(shell.style.getPropertyValue('--app-mono-font')).toContain('Cascadia')
    expect(shell.getAttribute('data-locale')).toBe('zh')
  })
})