import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import ConflictDialog from './ConflictDialog.vue'
import { useTabsStore } from '../stores/tabs'
import { setLocale, t } from '../i18n'

const readMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())
const statMock = vi.hoisted(() => vi.fn())
const listHistoryMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: writeMock,
    list: vi.fn(),
    watch: vi.fn(),
    deleteFile: vi.fn(),
    stat: statMock,
    listHistory: listHistoryMock,
    readHistory: vi.fn(),
    restoreHistory: vi.fn(),
    listTrash: vi.fn(),
    restoreFromTrash: vi.fn(),
  },
}))

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let pinia: Pinia
let mounted: VueApp[] = []

function mountDialog(tabId: string, onClose: () => void): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(ConflictDialog, {
    tabId,
    path: '/vault/a.md',
    onClose,
  } as never)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  return host
}

function reloadBtn(): HTMLButtonElement {
  return document.body.querySelector<HTMLButtonElement>('.conflict-dialog .btn-primary')!
}
function keepLocalBtn(): HTMLButtonElement {
  return document.body.querySelector<HTMLButtonElement>('.conflict-dialog .btn-secondary')!
}
function dialogEl(): HTMLElement {
  return document.body.querySelector<HTMLElement>('.conflict-dialog')!
}

describe('ConflictDialog', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    readMock.mockReset()
    writeMock.mockReset()
    statMock.mockReset()
    listHistoryMock.mockReset()
    document.body.innerHTML = ''
    mounted = []
    readMock.mockResolvedValue('# disk version')
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  it('is a labelled, modal dialog', () => {
    mountDialog('tab-1', () => {})
    const dialog = document.body.querySelector<HTMLElement>('.conflict-dialog')!
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('conflict-title')
    expect(document.body.querySelector('#conflict-title')).toBeTruthy()
  })

  it('opens with focus on the dialog itself, not on a destructive button', async () => {
    // This used to focus the first focusable control, which is "Use disk
    // (discard local)": the prompt appeared with focus already sitting on the
    // action that throws the user's unsaved edits away, so a stray Enter (or a
    // keypress meant for the editor the dialog interrupted) discarded them.
    // Focus now lands on the dialog container, so every choice -- including the
    // safe ones -- is an explicit, deliberate move. The container is focused
    // rather than "Later" on purpose: focusing a button makes Enter trigger
    // that button, and the safe default should be *no* answer at all.
    mountDialog('tab-1', () => {})
    await flush()
    expect(document.activeElement).toBe(dialogEl())
    expect(document.activeElement).not.toBe(reloadBtn())
    expect(document.activeElement).not.toBe(keepLocalBtn())
  })

  it('reads as one sentence with no empty {path} hole', () => {
    // The message used to interpolate `{path}` with an empty string while the
    // real path was rendered in its own span, so English read
    // "Disk content of  changed" — a hole and a double space. The sentence is
    // now split into prefix + path + suffix, and neither half may depend on
    // interpolation or carry stray whitespace.
    for (const locale of ['en', 'zh'] as const) {
      setLocale(locale)
      try {
        const prefix = t('conflict.bodyPrefix')
        const suffix = t('conflict.bodySuffix')
        expect(prefix).not.toContain('{')
        expect(suffix).not.toContain('{')
        expect(prefix).not.toMatch(/\s$/)
        expect(suffix).not.toMatch(/^\s/)
      } finally {
        setLocale('zh')
      }
    }
  })

  it('renders the path between the two halves as one readable sentence', () => {
    const path = '/vault/a.md'
    setLocale('en')
    try {
      mountDialog('tab-1', () => {})
      const text = document.body.querySelector('.conflict-body')!.textContent!.replace(/\s+/g, ' ').trim()
      expect(text).toBe(`${t('conflict.bodyPrefix')} ${path} ${t('conflict.bodySuffix')}`)
      expect(text).not.toMatch(/\s{2}/)
    } finally {
      setLocale('zh')
    }
  })

  it('reloadDisk resolves by reloading the tab from disk and closes', async () => {
    const close = vi.fn()
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    tab.content = 'unsaved local'
    s.markDirty(tab.id)
    readMock.mockClear()
    mountDialog(tab.id, close)

    reloadBtn().click()
    await flush()

    expect(readMock).toHaveBeenCalledTimes(1)
    expect(readMock).toHaveBeenCalledWith('/vault', '/vault/a.md')
    // reloadFromDisk adopts the disk content and clears dirty.
    expect(tab.content).toBe('# disk version')
    expect(tab.savedContent).toBe('# disk version')
    expect(tab.dirty).toBe(false)
    expect(close).toHaveBeenCalled()
  })

  it('keepLocal keeps the local content and closes without reloading', async () => {
    const close = vi.fn()
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    tab.content = 'unsaved local'
    s.markDirty(tab.id)
    readMock.mockClear()
    mountDialog(tab.id, close)

    keepLocalBtn().click()
    await flush()

    expect(readMock).not.toHaveBeenCalled()
    expect(tab.dirty).toBe(true)
    expect(tab.content).toBe('unsaved local')
    expect(close).toHaveBeenCalled()
  })

  it('closes on Escape without reloading', () => {
    mountDialog('tab-1', () => {})
    const close = vi.fn()
    document.body.innerHTML = ''
    mounted.forEach((app) => app.unmount())
    mounted = []
    mountDialog('tab-1', close)
    const overlay = document.body.querySelector('.dialog-overlay') as HTMLElement
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(close).toHaveBeenCalled()
  })
})
