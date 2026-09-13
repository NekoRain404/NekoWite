import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import FileTree from './FileTree.vue'
import { useTabsStore } from '../stores/tabs'

const readMock = vi.hoisted(() => vi.fn())
const listMock = vi.hoisted(() => vi.fn())
const onFsChangeMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    list: listMock,
    write: vi.fn(),
    watch: vi.fn(),
    stat: vi.fn(),
    readHistory: vi.fn(),
    listHistory: vi.fn().mockResolvedValue([]),
    restoreHistory: vi.fn(),
    openFolderDialog: vi.fn(),
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

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  readMock.mockReset()
  listMock.mockReset()
  onFsChangeMock.mockReset()
  readMock.mockResolvedValue('# note')
  onFsChangeMock.mockResolvedValue(() => undefined)
  // openTab refuses to open anything without a vault, and the tree's own
  // "open the note" path goes through it.
  useTabsStore().setVault('/vault')
  listMock.mockResolvedValue([
    { name: 'a.md', path: '/vault/a.md', is_dir: false, is_mdx: true },
    { name: 'sub', path: '/vault/sub', is_dir: true, is_mdx: false },
  ])
  document.body.innerHTML = ''
  mounted = []
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

function nameButton(label: string): HTMLElement {
  const names = Array.from(document.body.querySelectorAll<HTMLElement>('.tree-name'))
  const found = names.find((el) => el.textContent?.trim() === label)
  expect(found).toBeTruthy()
  return found!
}

describe('FileTree keyboard access', () => {
  it('opens a note with Enter on its (focusable) name', async () => {
    mountTree()
    await flush()
    // The name used to be a plain span with a click handler and no tabindex, so
    // the only Tab stop inside the tree was the hover-only delete button: a
    // keyboard user could delete a note but could not open one.
    const name = nameButton('a.md')
    expect(name.tagName.toLowerCase()).toBe('button')
    name.focus()
    expect(document.activeElement).toBe(name)

    // A real <button> turns Enter into a click; happy-dom does not synthesise
    // that, so the keydown is dispatched and the activation is verified.
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await nextTick()
    name.click()
    await nextTick()
    await flush()

    expect(useTabsStore().activeTab?.path).toBe('/vault/a.md')
  })

  it('names the disclosure caret and reports the expanded state', async () => {
    mountTree()
    await flush()
    const row = [...document.body.querySelectorAll<HTMLElement>('.tree-row')]
      .find((r) => r.querySelector('.tree-name')?.textContent?.trim() === 'sub')!
    expect(row).toBeTruthy()
    const caret = row.querySelector<HTMLButtonElement>('.caret')!
    expect(caret.getAttribute('aria-label')).toBeTruthy()
    expect(caret.getAttribute('aria-expanded')).toBe('false')

    caret.click()
    await nextTick()
    await flush()

    expect(caret.getAttribute('aria-expanded')).toBe('true')
    // The label flips with the state instead of repeating "expand" for both.
    expect(caret.getAttribute('aria-label')).toContain('折叠')
  })

  it('keeps the row delete button visible while its own focus is inside the row', () => {
    // `.tree-del` was opacity:0 until :hover, so the only control a keyboard
    // user could reach in a row was also invisible. The rule cannot be observed
    // through happy-dom, so the component's own stylesheet is checked.
    const sfc = readFileSync(join(process.cwd(), 'src', 'ui', 'FileTree.vue'), 'utf8')
    expect(sfc).toContain('.tree-del:focus-within')
    expect(sfc).toContain('.tree-del:focus-visible')
  })
})
