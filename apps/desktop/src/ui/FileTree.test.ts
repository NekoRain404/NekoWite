import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import FileTree from './FileTree.vue'

const readMock = vi.hoisted(() => vi.fn())
const listMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())
const openFolderMock = vi.hoisted(() => vi.fn())
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
    renameEntry: vi.fn(),
    listTrash: vi.fn(),
    restoreFromTrash: vi.fn(),
    deleteFile: vi.fn(),
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
