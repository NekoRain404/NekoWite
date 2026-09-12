import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import App from './App.vue'
import { useAppearanceStore } from './stores/appearance'
import { fsService } from './platform/gateways/fs'

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

  it('binds data-color-scheme from the appearance store', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const appearance = useAppearanceStore()
    appearance.setColorScheme('forest')

    const shell = mountApp(pinia)
    await nextTick()

    expect(shell.getAttribute('data-color-scheme')).toBe('forest')
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

  it('switches data-accent to the automatic accent when following the system accent', async () => {
    mediaMatches.set('(prefers-color-scheme: dark)', false)
    const pinia = createPinia()
    setActivePinia(pinia)
    const appearance = useAppearanceStore()
    // A user-chosen accent is ignored once "follow system accent" is on.
    appearance.setAccent('teal')
    appearance.setFollowSystemAccent(true)

    const shell = mountApp(pinia)
    await nextTick()
    // Light theme -> automatic coral accent.
    expect(shell.getAttribute('data-accent')).toBe('coral')

    // OS flips to dark -> accent follows to violet.
    mediaMatches.set('(prefers-color-scheme: dark)', true)
    mediaListeners.get('(prefers-color-scheme: dark)')?.forEach((cb) => cb())
    await nextTick()
    expect(shell.getAttribute('data-accent')).toBe('violet')

    // Turning the follow-key back off restores the user accent (still dark).
    appearance.setFollowSystemAccent(false)
    await nextTick()
    expect(shell.getAttribute('data-accent')).toBe('teal')
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

const VAULT_LS_KEY = 'nekowite.vault'

/** Mount the real App with a persisted vault so the sidebar (and its picker /
 * trash group) is rendered, and wait until the startup applyVault committed. */
async function mountAppWithVault(): Promise<HTMLElement> {
  localStorage.setItem(VAULT_LS_KEY, '/seed/bravo')
  const pinia = createPinia()
  setActivePinia(pinia)
  const shell = mountApp(pinia)
  await vi.waitFor(() => expect(document.querySelector('.vault-item')).not.toBeNull())
  return shell
}

describe('App open-folder dialog wiring (A1)', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
    document.body.innerHTML = ''
    mounted = []
    localStorage.removeItem(VAULT_LS_KEY)
  })

  afterEach(() => {
    // No spy may leak into the other suites of this file.
    vi.restoreAllMocks()
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
    localStorage.removeItem(VAULT_LS_KEY)
  })

  it('applies the folder the sidebar dialog picks and commits it as the vault', async () => {
    // The E2E always mocks `open_folder_dialog` -> null, so the dialog path
    // (picked -> emits open-folder -> runtime applies it) is never exercised.
    const pickSpy = vi.spyOn(fsService, 'openFolderDialog').mockResolvedValue('/picked/alfa')
    const shell = await mountAppWithVault()
    expect(document.querySelector('.vault-item .nav-label')?.textContent).toBe('bravo')

    // Startup restore must not have consulted the native dialog.
    expect(pickSpy).not.toHaveBeenCalled()

    ;(document.querySelector('.vault-item') as HTMLButtonElement).click()

    // The picked path flows sidebar -> shell -> App -> runtime.applyVault and is
    // committed (localStorage persisted, sidebar re-renders the new name).
    await vi.waitFor(() =>
      expect(localStorage.getItem(VAULT_LS_KEY)).toBe('/picked/alfa'),
    )
    expect(pickSpy).toHaveBeenCalledTimes(1)
    expect(shell.querySelector('.vault-item .nav-label')?.textContent).toBe('alfa')
  })

  it('leaves the current vault untouched when the dialog is cancelled', async () => {
    const pickSpy = vi.spyOn(fsService, 'openFolderDialog').mockResolvedValue(null)
    await mountAppWithVault()

    ;(document.querySelector('.vault-item') as HTMLButtonElement).click()
    await nextTick()

    expect(pickSpy).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(VAULT_LS_KEY)).toBe('/seed/bravo')
    expect(document.querySelector('.vault-item .nav-label')?.textContent).toBe('bravo')
  })
})

describe('App trash restore wiring', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
    document.body.innerHTML = ''
    mounted = []
    localStorage.removeItem(VAULT_LS_KEY)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
    localStorage.removeItem(VAULT_LS_KEY)
  })

  it('restores a trash entry through the gateway and refreshes the trash list', async () => {
    const entry = {
      name: 'docs-enc-key',
      // The label is decoded on the Rust side, so the mock carries it: the raw
      // key is NOT what the user deleted and must never be shown as the name.
      display_name: 'a.md',
      trash_path: 'docs-enc-key',
      original_path: 'docs/a.md',
      is_dir: false,
    }
    const listTrashSpy = vi.spyOn(fsService, 'listTrash').mockResolvedValue([entry])
    const restoreSpy = vi.spyOn(fsService, 'restoreFromTrash').mockResolvedValue('docs/a.md')
    await mountAppWithVault()

    // Opening the trash group refreshes it from the gateway.
    const trashHeader = [...document.querySelectorAll('.group-header')].find(
      (h) => h.textContent?.includes('回收站'),
    )
    expect(trashHeader).toBeDefined()
    ;(trashHeader as HTMLButtonElement).click()
    await vi.waitFor(() => expect(document.querySelector('.trash-restore')).not.toBeNull())
    expect(listTrashSpy).toHaveBeenCalledWith('/seed/bravo')
    expect(document.querySelector('.trash-name')?.textContent).toBe(entry.display_name)

    // The restore button routes through restoreFromTrash with the trash key and
    // then re-polls the list (so the restored entry disappears on a real backend).
    ;(document.querySelector('.trash-restore') as HTMLButtonElement).click()
    await vi.waitFor(() =>
      expect(restoreSpy).toHaveBeenCalledWith('/seed/bravo', entry.trash_path),
    )
    await vi.waitFor(() =>
      expect(listTrashSpy.mock.calls.length).toBeGreaterThanOrEqual(2),
    )
  })
})
