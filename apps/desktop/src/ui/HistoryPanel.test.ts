import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import HistoryPanel from './HistoryPanel.vue'
import { useTabsStore } from '../stores/tabs'

const readMock = vi.hoisted(() => vi.fn())
const statMock = vi.hoisted(() => vi.fn())
const listHistoryMock = vi.hoisted(() => vi.fn())
const restoreHistoryMock = vi.hoisted(() => vi.fn())

vi.mock('../services/fs', () => ({
  fsService: {
    read: readMock,
    write: vi.fn(),
    list: vi.fn(),
    watch: vi.fn(),
    deleteFile: vi.fn(),
    stat: statMock,
    listHistory: listHistoryMock,
    readHistory: vi.fn(),
    restoreHistory: restoreHistoryMock,
    openFolderDialog: vi.fn(),
    saveFileDialog: vi.fn(),
    onFsChange: vi.fn(),
    listTrash: vi.fn(),
    restoreFromTrash: vi.fn(),
  },
}))

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const historyCallCount = (): number => listHistoryMock.mock.calls.length

let pinia: Pinia
let mounted: VueApp[] = []

function mountPanel(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(HistoryPanel)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  return host
}

async function openDoc(path = '/vault/a.md', vault = '/vault'): Promise<void> {
  const s = useTabsStore()
  s.setVault(vault)
  await s.openTab(path)
}

describe('HistoryPanel', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    readMock.mockReset()
    statMock.mockReset()
    listHistoryMock.mockReset()
    restoreHistoryMock.mockReset()
    readMock.mockResolvedValue('# hello')
    statMock.mockResolvedValue({ size: 8, mtime: Number.MAX_SAFE_INTEGER })
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  it('renders history rows newest-first with timestamps and sizes', async () => {
    listHistoryMock.mockResolvedValue([
      { id: 'ver-2', size: 2048, mtime: 200 },
      { id: 'ver-1', size: 512, mtime: 100 },
    ])
    await openDoc()
    const host = mountPanel()
    await flush()

    const items = host.querySelectorAll('.history-item')
    expect(items).toHaveLength(2)
    const times = Array.from(host.querySelectorAll('.history-time')).map((el) => el.textContent)
    expect(times).toEqual([new Date(200).toLocaleString(), new Date(100).toLocaleString()])
    const sizes = Array.from(host.querySelectorAll('.history-size')).map((el) => el.textContent)
    expect(sizes).toEqual(['2.0 KB', '512 B'])
    const ids = Array.from(host.querySelectorAll('.history-id')).map((el) => el.textContent)
    expect(ids).toEqual(['ver-2', 'ver-1'])
    expect(listHistoryMock).toHaveBeenCalledWith('/vault', '/vault/a.md')
  })

  it('shows the empty-history state when there are no versions', async () => {
    listHistoryMock.mockResolvedValue([])
    await openDoc()
    const host = mountPanel()
    await flush()

    expect(host.textContent).toContain('暂无历史版本')
    expect(host.querySelectorAll('.history-item')).toHaveLength(0)
  })

  it('shows the no-document state when no tab is active', async () => {
    const host = mountPanel()
    await flush()

    expect(host.textContent).toContain('打开文档以查看历史版本')
    expect(listHistoryMock).not.toHaveBeenCalled()
  })

  it('restores an entry, calls the gateway, then refreshes the list', async () => {
    listHistoryMock.mockResolvedValue([
      { id: 'ver-2', size: 100, mtime: 200 },
      { id: 'ver-1', size: 100, mtime: 100 },
    ])
    restoreHistoryMock.mockResolvedValue('restored content')
    await openDoc()
    const host = mountPanel()
    await flush()

    const before = historyCallCount()
    const firstRow = host.querySelectorAll('.history-item')[0]
    const restoreBtn = firstRow.querySelector<HTMLButtonElement>('button')
    expect(restoreBtn).toBeTruthy()
    restoreBtn?.click()

    await vi.waitFor(() =>
      expect(restoreHistoryMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'ver-2'),
    )
    await vi.waitFor(() => expect(historyCallCount()).toBeGreaterThan(before))
  })

  it('calls listHistory again when the refresh button is clicked', async () => {
    listHistoryMock.mockResolvedValue([
      { id: 'ver-1', size: 100, mtime: 100 },
    ])
    await openDoc()
    const host = mountPanel()
    await flush()

    const before = historyCallCount()
    const refreshBtn = host.querySelector<HTMLButtonElement>('.btn-refresh')
    expect(refreshBtn).toBeTruthy()
    refreshBtn?.click()

    await vi.waitFor(() => expect(historyCallCount()).toBeGreaterThan(before))
  })
})