import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import ConflictDialog from './ConflictDialog.vue'
import { useTabsStore } from '../stores/tabs'

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

  it('traps focus: the first focusable control is focused on open', async () => {
    mountDialog('tab-1', () => {})
    await flush()
    expect(document.activeElement).toBe(reloadBtn())
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
