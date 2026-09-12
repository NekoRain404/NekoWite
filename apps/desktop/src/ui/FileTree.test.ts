import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import FileTree from './FileTree.vue'
import { useAppearanceStore } from '../stores/appearance'
import { useTabsStore } from '../stores/tabs'

const readMock = vi.hoisted(() => vi.fn())
const listMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())
const openFolderMock = vi.hoisted(() => vi.fn())
const renameMock = vi.hoisted(() => vi.fn())
const deleteFileMock = vi.hoisted(() => vi.fn())
const onFsChangeMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    list: listMock,
    write: writeMock,
    watch: vi.fn(),
    stat: vi.fn(),
    readHistory: vi.fn(),
    listHistory: vi.fn().mockResolvedValue([]),
    restoreHistory: vi.fn(),
    openFolderDialog: openFolderMock,
    saveFileDialog: vi.fn(),
    saveAttachment: vi.fn(),
    createDir: vi.fn(),
    renameEntry: renameMock,
    listTrash: vi.fn(),
    restoreFromTrash: vi.fn(),
    deleteFile: deleteFileMock,
    onFsChange: onFsChangeMock,
  },
}))

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let pinia: Pinia
let mounted: VueApp[] = []

function mountTree(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(FileTree, { vault: '/vault' })
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  return host
}

/** Build a keydown whose `isComposing` flag is observable: happy-dom's
 *  KeyboardEvent constructor drops the `isComposing` init option, so an IME
 *  event is simulated by stamping the property. */
function imeKey(init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(ev, 'isComposing', { value: true, configurable: true })
  return ev
}

async function openRenameInput(host: HTMLElement): Promise<HTMLInputElement> {
  // The LAST row is the file; index 0 is the vault root, which offers no rename.
  const rows = host.querySelectorAll<HTMLElement>('.tree-row')
  const row = rows[rows.length - 1]
  expect(row.textContent?.trim()).toBe('a.md')
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  await nextTick()
  await nextTick()
  const renameItem = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.ctx-menu-item'))
    .find((b) => b.textContent?.trim() === '重命名')
  expect(renameItem).toBeTruthy()
  renameItem!.click()
  await flush()
  const input = host.querySelector<HTMLInputElement>('.tree-inline-input')
  expect(input).not.toBeNull()
  return input!
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('FileTree inline rename (IME)', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    readMock.mockReset()
    listMock.mockReset()
    writeMock.mockReset()
    openFolderMock.mockReset()
    renameMock.mockReset()
    renameMock.mockResolvedValue(undefined)
    onFsChangeMock.mockReset()
    readMock.mockResolvedValue('# note')
    writeMock.mockResolvedValue(undefined)
    openFolderMock.mockResolvedValue(null)
    onFsChangeMock.mockResolvedValue(() => undefined)
    listMock.mockResolvedValue([
      { name: 'a.md', path: '/vault/a.md', is_dir: false, is_mdx: true },
    ])
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  it('does not commit the typed name when Enter arrives mid-composition', async () => {
    // Enter accepts the IME candidate. The inline rename used to treat it as
    // "commit", renaming the note to the half-finished pinyin string. The
    // cancelable event is what proves the handler returned early: the guard
    // must not even consume the key.
    const host = mountTree()
    await flush()
    const input = await openRenameInput(host)

    typeInto(input, 'fengjing')
    const ev = imeKey({ key: 'Enter' })
    input.dispatchEvent(ev)
    await flush()

    // The edit row is still open and nothing was written.
    expect(host.querySelector('.tree-inline-input')).not.toBeNull()
    expect(writeMock).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('does not discard the typed name when Escape only dismisses the IME list', async () => {
    const host = mountTree()
    await flush()
    const input = await openRenameInput(host)

    typeInto(input, 'fengjing')
    const ev = imeKey({ key: 'Escape', keyCode: 229 })
    input.dispatchEvent(ev)
    await flush()

    expect(host.querySelector('.tree-inline-input')).not.toBeNull()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('still commits on a plain Enter', async () => {
    const host = mountTree()
    await flush()
    const input = await openRenameInput(host)

    typeInto(input, 'renamed.md')
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    await flush()

    expect(ev.defaultPrevented).toBe(true)
    // The rename goes through moveNote (read-modify-write of the note plus a
    // tab-path update), so the note text is read before the file moves.
    expect(readMock).toHaveBeenCalledWith('/vault', '/vault/a.md')
    expect(host.querySelector('.tree-inline-input')).toBeNull()
  })
})

describe('FileTree rename keeps the open tab attached', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    readMock.mockReset()
    listMock.mockReset()
    writeMock.mockReset()
    renameMock.mockReset()
    onFsChangeMock.mockReset()
    readMock.mockResolvedValue('# note')
    writeMock.mockResolvedValue(undefined)
    renameMock.mockResolvedValue(undefined)
    onFsChangeMock.mockResolvedValue(() => undefined)
    listMock.mockResolvedValue([
      { name: 'a.md', path: '/vault/a.md', is_dir: false, is_mdx: true },
    ])
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  async function renameTo(host: HTMLElement, name: string): Promise<void> {
    const input = await openRenameInput(host)
    typeInto(input, name)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flush()
    await flush()
  }

  it('claims the old path for the move before touching the disk', async () => {
    // The claim has to be in place BEFORE the first fs call: the watcher can
    // report the rename while the tab still points at the old name, and the
    // app-level sync would otherwise read it, find nothing and detach the tab as
    // if the file had been moved behind the user's back.
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/a.md')
    let claimDuringDiskWork: boolean | null = null
    renameMock.mockImplementation(async () => {
      claimDuringDiskWork = useTabsStore().isPendingMove('/vault/a.md')
    })
    const host = mountTree()
    await flush()

    await renameTo(host, 'renamed.md')

    expect(claimDuringDiskWork).toBe(true)
    // ...and released once the move is over, so a later real deletion is still
    // noticed.
    expect(tabs.isPendingMove('/vault/a.md')).toBe(false)
    expect(tabs.activeTab?.path).toBe('/vault/renamed.md')
  })

  it('re-attaches the tab when a move failed after its rename landed', async () => {
    // `moveNote` rewrites the body at the new path after renaming, and its own
    // rollback is best effort. If the rewrite fails and the rollback does not
    // land, the note really is at the new name: the tab must follow it instead
    // of being left on a path that no longer exists (which would detach the note
    // and turn the next Ctrl+S into a save-as).
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/a.md')
    readMock.mockImplementation(async (_vault: string, path: string) => {
      if (path === '/vault/a.md') throw new Error('gone') // renamed away already
      return '# note'
    })
    writeMock.mockRejectedValue(new Error('disk full'))
    renameMock.mockImplementation(async (_v: string, from: string) => {
      // The rollback rename (new -> old) is the one that fails here.
      if (from === '/vault/renamed.md') throw new Error('locked')
    })
    const host = mountTree()
    await flush()

    await renameTo(host, 'renamed.md')

    expect(tabs.activeTab?.path).toBe('/vault/renamed.md')
    expect(tabs.isPendingMove('/vault/a.md')).toBe(false)
  })
})

describe('FileTree delete confirmation', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    readMock.mockReset()
    listMock.mockReset()
    writeMock.mockReset()
    renameMock.mockReset()
    deleteFileMock.mockReset()
    onFsChangeMock.mockReset()
    readMock.mockResolvedValue('# note')
    writeMock.mockResolvedValue(undefined)
    renameMock.mockResolvedValue(undefined)
    deleteFileMock.mockResolvedValue(undefined)
    onFsChangeMock.mockResolvedValue(() => undefined)
    listMock.mockResolvedValue([
      { name: 'a.md', path: '/vault/a.md', is_dir: false, is_mdx: true },
    ])
    // The setting is persisted, so a case must never inherit the previous
    // case's choice.
    useAppearanceStore().setConfirmBeforeDelete(true)
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    useAppearanceStore().setConfirmBeforeDelete(true)
    document.body.innerHTML = ''
  })

  function trashButton(): HTMLButtonElement {
    const btn = document.querySelector<HTMLButtonElement>('.tree-del')
    expect(btn).not.toBeNull()
    return btn!
  }

  it('keeps the two-step confirm while the setting is on (default)', async () => {
    const host = mountTree()
    await flush()

    trashButton().click()
    await nextTick()

    // The first click only arms the row: nothing has been deleted yet, and the
    // confirm/cancel pair is offered.
    expect(host.querySelector('.tree-del-confirm')).not.toBeNull()
    expect(deleteFileMock).not.toHaveBeenCalled()

    const confirm = [...host.querySelectorAll<HTMLButtonElement>('.tree-del-confirm button')][0]
    confirm.click()
    await flush()

    expect(deleteFileMock).toHaveBeenCalledTimes(1)
    expect(deleteFileMock).toHaveBeenCalledWith('/vault', '/vault/a.md')
  })

  it('deletes on the trash click once the setting is off', async () => {
    useAppearanceStore().setConfirmBeforeDelete(false)
    const host = mountTree()
    await flush()

    trashButton().click()
    await nextTick()

    // No confirmation row at all: the icon click was the decision.
    expect(host.querySelector('.tree-del-confirm')).toBeNull()
    await flush()
    expect(deleteFileMock).toHaveBeenCalledTimes(1)
    expect(deleteFileMock).toHaveBeenCalledWith('/vault', '/vault/a.md')
  })

  it('does not run the same delete twice from a double activation', async () => {
    useAppearanceStore().setConfirmBeforeDelete(false)
    mountTree()
    await flush()

    const btn = trashButton()
    btn.click()
    btn.click()
    await flush()

    expect(deleteFileMock).toHaveBeenCalledTimes(1)
  })
})
