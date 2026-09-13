import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import FrontmatterPanel from './FrontmatterPanel.vue'
import { useTabsStore } from '../stores/tabs'

const readMock = vi.hoisted(() => vi.fn())
const statMock = vi.hoisted(() => vi.fn())
const listHistoryMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: vi.fn(),
    stat: statMock,
    list: vi.fn(),
    listHistory: listHistoryMock,
    readHistory: vi.fn(),
    restoreHistory: vi.fn(),
    onFsChange: vi.fn(),
    openFolderDialog: vi.fn(),
    saveFileDialog: vi.fn(),
    saveAttachment: vi.fn(),
    createDir: vi.fn(),
    renameEntry: vi.fn(),
    listTrash: vi.fn(),
    restoreFromTrash: vi.fn(),
    deleteFile: vi.fn(),
  },
}))

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let pinia: Pinia
let mounted: VueApp[] = []

function mountPanel(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(FrontmatterPanel)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  return host
}

async function openDoc(path: string, content: string, vault = '/vault'): Promise<void> {
  const s = useTabsStore()
  s.setVault(vault)
  readMock.mockImplementation(async (_v: string, p: string) => {
    if (p === path) return content
    throw new Error('not found')
  })
  statMock.mockResolvedValue({ size: content.length, mtime: 100 })
  listHistoryMock.mockResolvedValue([])
  await s.openTab(path)
}

function setInputValue(el: HTMLInputElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function textOf(input: HTMLInputElement): string {
  return input.value
}

/** Build a keydown whose `isComposing` flag is observable: happy-dom's
 *  KeyboardEvent constructor drops the `isComposing` init option, so an IME
 *  event is simulated by stamping the property. */
function imeKey(init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(ev, 'isComposing', { value: true, configurable: true })
  return ev
}

describe('FrontmatterPanel', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    readMock.mockReset()
    statMock.mockReset()
    listHistoryMock.mockReset()
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  it('renders title and chips from an existing frontmatter block', async () => {
    await openDoc('/vault/a.md', '---\ntitle: 图论\ntags:\n  - 数学\n  - 随笔\n---\n\n# Body')
    const host = mountPanel()
    await flush()

    const titleInput = host.querySelector<HTMLInputElement>('input.fm-input')
    expect(titleInput).toBeTruthy()
    expect(textOf(titleInput!)).toBe('图论')
    const chips = Array.from(host.querySelectorAll('.fm-chip-text')).map((el) => el.textContent)
    expect(chips).toEqual(['数学', '随笔'])
    expect(host.textContent).toContain('数学')
  })

  it('shows add-properties when there is no frontmatter and creates one from the filename', async () => {
    await openDoc('/vault/welcome.md', '# Welcome\n\nContent')
    const host = mountPanel()
    await flush()

    expect(host.querySelector('.fm-add')).toBeTruthy()
    const addBtn = host.querySelector<HTMLButtonElement>('.fm-add')
    addBtn?.click()
    await flush()

    const s = useTabsStore()
    expect(s.activeTab?.content).toBe('---\ntitle: welcome\n---\n\n# Welcome\n\nContent')
    expect(s.activeTab?.dirty).toBe(true)
    expect(host.querySelector('.fm-add')).toBeNull()
    expect(host.querySelectorAll('.fm-chip')).toHaveLength(0)
  })

  it('removes a tag chip from the active document', async () => {
    await openDoc('/vault/a.md', '---\ntitle: t\ntags:\n  - 数学\n  - 随笔\n---\n\nBody')
    const host = mountPanel()
    await flush()

    const chips = host.querySelectorAll('.fm-chip')
    expect(chips).toHaveLength(2)
    const mathChip = chips[0]
    const xBtn = mathChip.querySelector<HTMLButtonElement>('.fm-chip-x')
    expect(xBtn).toBeTruthy()
    xBtn?.click()

    const s = useTabsStore()
    expect(s.activeTab?.content).toBe('---\ntitle: t\ntags:\n  - 随笔\n---\n\nBody')
    expect(s.activeTab?.dirty).toBe(true)
  })

  it('adds a tag via Enter on the tag input', async () => {
    await openDoc('/vault/a.md', '---\ntitle: t\n---\n\nBody')
    const host = mountPanel()
    await flush()

    const tagInput = host.querySelector<HTMLInputElement>('input.fm-tag-input')
    expect(tagInput).toBeTruthy()
    setInputValue(tagInput!, 'math')
    tagInput!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    const s = useTabsStore()
    expect(s.activeTab?.content).toContain('tags:\n  - math')
  })

  it('applies an edited title on blur', async () => {
    await openDoc('/vault/a.md', '---\ntitle: old\n---\n\nBody')
    const host = mountPanel()
    await flush()

    const titleInput = host.querySelector<HTMLInputElement>('input.fm-input')
    setInputValue(titleInput!, 'new')
    titleInput!.dispatchEvent(new Event('blur'))

    const s = useTabsStore()
    expect(s.activeTab?.content).toContain('title: new')
    expect(s.activeTab?.content).not.toContain('title: old')
  })

  it('keeps an untouched block with unknown nested keys byte-for-byte and stays clean', async () => {
    const doc =
      '---\ntitle: A\naliases:\n  - one\n  - two\ncssclasses: [wide, dark]\nmeta:\n  nested: 1\ndoi: 10.1/x\n---\n\n# Body\n'
    await openDoc('/vault/a.md', doc)
    const host = mountPanel()
    await flush()

    // serialize(form) === front, so Apply must look disabled on an untouched note.
    const apply = host.querySelector<HTMLButtonElement>('.fm-apply')
    expect(apply?.disabled).toBe(true)
    expect(host.textContent).toContain('aliases')

    const titleInput = host.querySelector<HTMLInputElement>('input.fm-input')
    titleInput!.dispatchEvent(new Event('focus'))
    titleInput!.dispatchEvent(new Event('blur'))
    await flush()

    const s = useTabsStore()
    expect(s.activeTab?.content).toBe(doc)
    expect(s.activeTab?.dirty).toBe(false)
  })

  it('keeps unknown keys raw when the title is edited', async () => {
    const doc = '---\ntitle: A\naliases:\n  - one\n  - two\ncssclasses: [wide, dark]\n---\n\n# Body\n'
    await openDoc('/vault/a.md', doc)
    const host = mountPanel()
    await flush()

    const titleInput = host.querySelector<HTMLInputElement>('input.fm-input')
    setInputValue(titleInput!, 'B')
    titleInput!.dispatchEvent(new Event('blur'))
    await flush()

    const s = useTabsStore()
    expect(s.activeTab?.content).toBe('---\ntitle: B\naliases:\n  - one\n  - two\ncssclasses: [wide, dark]\n---\n\n# Body\n')
    expect(s.activeTab?.dirty).toBe(true)
  })

  it('keeps a non-ASCII key untouched and lists it', async () => {
    const doc = '---\ntitle: A\n标题: 我的笔记\n---\n\nBody'
    await openDoc('/vault/a.md', doc)
    const host = mountPanel()
    await flush()

    expect(host.textContent).toContain('标题')

    const titleInput = host.querySelector<HTMLInputElement>('input.fm-input')
    titleInput!.dispatchEvent(new Event('blur'))
    await flush()

    expect(useTabsStore().activeTab?.content).toBe(doc)
  })

  it('shows the no-document hint when no tab is active', async () => {
    const host = mountPanel()
    await flush()
    expect(host.textContent).toContain('打开文档以查看属性')
  })

  it('gives the icon-only add-tag button an accessible name', async () => {
    // The button renders only a <Plus> icon; without a label a screen reader
    // announced it as an unlabelled button, and the title tooltip was missing
    // too.
    await openDoc('/vault/a.md', '---\ntitle: t\ntags:\n  - 数学\n---\n\nBody')
    const host = mountPanel()
    await flush()

    const tagInput = host.querySelector<HTMLInputElement>('.fm-tag-input')!
    setInputValue(tagInput, '新标签')
    await nextTick()

    const addBtn = host.querySelector<HTMLButtonElement>('.fm-tag-add')!
    expect(addBtn.getAttribute('aria-label')).toBeTruthy()
    expect(addBtn.getAttribute('title')).toBeTruthy()
    expect(addBtn.getAttribute('aria-label')).toBe(addBtn.getAttribute('title'))
  })

  it('does not commit the title when Enter arrives mid-composition', async () => {
    // Enter accepts the IME candidate; committing there wrote the half-finished
    // pinyin string into the document and marked it dirty.
    await openDoc('/vault/a.md', '---\ntitle: 图论\n---\n\nBody')
    const host = mountPanel()
    await flush()

    const title = host.querySelector<HTMLInputElement>('input.fm-input')!
    const ev = imeKey({ key: 'Enter' })
    title.dispatchEvent(ev)
    await flush()

    expect(ev.defaultPrevented).toBe(false)
    expect(useTabsStore().activeTab?.dirty).toBe(false)
  })

  it('does not add a tag when Enter arrives mid-composition', async () => {
    await openDoc('/vault/a.md', '---\ntitle: t\ntags:\n  - 数学\n---\n\nBody')
    const host = mountPanel()
    await flush()

    const tagInput = host.querySelector<HTMLInputElement>('.fm-tag-input')!
    setInputValue(tagInput, 'fengjing')
    const ev = imeKey({ key: 'Enter' })
    tagInput.dispatchEvent(ev)
    await flush()

    expect(ev.defaultPrevented).toBe(false)
    expect(tagInput.value).toBe('fengjing')
    expect(useTabsStore().activeTab?.dirty).toBe(false)
  })

  it('does not add a tag when Enter arrives while the IME reports key="Process"', async () => {
    await openDoc('/vault/a.md', '---\ntitle: t\ntags:\n  - 数学\n---\n\nBody')
    const host = mountPanel()
    await flush()

    const tagInput = host.querySelector<HTMLInputElement>('.fm-tag-input')!
    setInputValue(tagInput, 'fengjing')
    tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', bubbles: true, cancelable: true }))
    await flush()

    expect(tagInput.value).toBe('fengjing')
    expect(useTabsStore().activeTab?.dirty).toBe(false)
  })
})
