import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import GraphPanel from './GraphPanel.vue'
import { useTabsStore } from '../stores/tabs'
import { vaultFileIndex } from '../services/vaultFiles'

const readMock = vi.hoisted(() => vi.fn())
const listMock = vi.hoisted(() => vi.fn())

vi.mock('../services/fs', () => ({
  fsService: {
    read: readMock,
    list: listMock,
    write: vi.fn(),
    watch: vi.fn(),
    deleteFile: vi.fn(),
    stat: vi.fn(),
    listHistory: vi.fn(),
    readHistory: vi.fn(),
    restoreHistory: vi.fn(),
    openFolderDialog: vi.fn(),
    saveFileDialog: vi.fn(),
    onFsChange: vi.fn(),
    listTrash: vi.fn(),
    restoreFromTrash: vi.fn(),
  },
}))

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function fileEntry(path: string) {
  return { name: path.split('/').pop() ?? path, path, is_dir: false, is_mdx: true }
}

let pinia: Pinia
let mounted: VueApp[] = []
let host: HTMLElement | null = null

function mountPanel(props?: { vaultReady?: boolean; maxNotes?: number }): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(GraphPanel, props ?? {})
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
}

describe('GraphPanel', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    readMock.mockReset()
    listMock.mockReset()
    vaultFileIndex.invalidate()
  })

  afterEach(() => {
    for (const app of mounted) app.unmount()
    mounted = []
    host?.remove()
    host = null
  })

  it('shows the empty hint when no vault is open', async () => {
    mountPanel()
    await flush()
    expect(host!.textContent).toContain('打开一个笔记库后查看笔记关系图谱')
    expect(listMock).not.toHaveBeenCalled()
  })

  it('loads notes and shows counts after the vault is ready', async () => {
    listMock.mockResolvedValue([fileEntry('a.md'), fileEntry('notes/b.md')])
    readMock.mockImplementation((_vault: string, path: string) => {
      if (path === 'a.md') return Promise.resolve('链接到 [[b]]')
      if (path === 'notes/b.md') return Promise.resolve('回到 [[a]]')
      return Promise.resolve('')
    })
    const tabs = useTabsStore()
    tabs.setVault('/vault-1')
    mountPanel()
    await flush()
    await flush()
    expect(host!.textContent).toContain('2 篇')
    expect(host!.textContent).toContain('2 条链接')
    expect(host!.textContent).not.toContain('仅展示前')
  })

  it('exposes rebuild() and re-reads the vault', async () => {
    listMock.mockResolvedValue([fileEntry('a.md'), fileEntry('b.md')])
    readMock.mockResolvedValue('[[b]]')
    const tabs = useTabsStore()
    tabs.setVault('/vault-2')
    mountPanel()
    await flush()
    await flush()
    const readsAfterMount = readMock.mock.calls.length
    expect(readsAfterMount).toBeGreaterThan(0)
    const instance = (mounted[0] as unknown as { _instance?: { exposed?: Record<string, unknown> } })._instance
    const exposed = (instance?.exposed ?? {}) as { rebuild?: () => Promise<void> }
    expect(exposed.rebuild).toBeTypeOf('function')
    await exposed.rebuild!()
    await flush()
    expect(readMock.mock.calls.length).toBe(readsAfterMount + 2)
  })

  it('truncates beyond the configured cap with a visible total', async () => {
    const many = Array.from({ length: 201 }, (_v, i) => fileEntry(`n${i}.md`))
    listMock.mockResolvedValue(many)
    readMock.mockResolvedValue('无链接')
    const tabs = useTabsStore()
    tabs.setVault('/vault-3')
    mountPanel({ maxNotes: 200 })
    await flush()
    await flush()
    // Non-silent: the notice names the cap AND the true total (not just "first N").
    expect(host!.textContent).toContain('仅展示前 200')
    expect(host!.textContent).toContain('201')
    expect(readMock).toHaveBeenCalledTimes(200)
    expect(host!.textContent).toContain('200 篇')
  })

  it('renders the full vault by default (no silent cap)', async () => {
    const many = Array.from({ length: 210 }, (_v, i) => fileEntry(`n${i}.md`))
    listMock.mockResolvedValue(many)
    readMock.mockResolvedValue('无链接')
    const tabs = useTabsStore()
    tabs.setVault('/vault-full')
    mountPanel()
    await flush()
    await flush()
    // Full vault default: every node is read and rendered, no truncation notice.
    expect(readMock).toHaveBeenCalledTimes(210)
    expect(host!.textContent).not.toContain('仅展示前')
    expect(host!.textContent).toContain('210 篇')
  })

  it('honours vaultReady=false and skips loading', async () => {
    listMock.mockResolvedValue([fileEntry('a.md')])
    readMock.mockResolvedValue('')
    const tabs = useTabsStore()
    tabs.setVault('/vault-4')
    mountPanel({ vaultReady: false })
    await flush()
    await flush()
    expect(readMock).not.toHaveBeenCalled()
    expect(host!.textContent).not.toContain('1 篇')
  })
})
