import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import HistoryPanel from './HistoryPanel.vue'
import { useTabsStore } from '../stores/tabs'
import { onNotify } from '../services/errors'
import { t } from '../i18n'

const readMock = vi.hoisted(() => vi.fn())
const statMock = vi.hoisted(() => vi.fn())
const listHistoryMock = vi.hoisted(() => vi.fn())
const readHistoryMock = vi.hoisted(() => vi.fn())
const restoreHistoryMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: vi.fn(),
    list: vi.fn(),
    watch: vi.fn(),
    deleteFile: vi.fn(),
    stat: statMock,
    listHistory: listHistoryMock,
    readHistory: readHistoryMock,
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
    readHistoryMock.mockReset()
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

  it('shows the "no history" hint only when there are no versions', async () => {
    // The hint's v-else was chained to the DiffView, not to the list, so every
    // populated history list had "No history yet" printed under it.
    listHistoryMock.mockResolvedValue([])
    await openDoc()
    const host = mountPanel()
    await flush()

    expect(host.querySelectorAll('.history-item')).toHaveLength(0)
    expect(host.querySelector('.rail-empty')?.textContent).toContain('暂无历史')
  })

  it('does not show the "no history" hint next to a populated list', async () => {
    listHistoryMock.mockResolvedValue([
      { id: 'ver-2', size: 2048, mtime: 200 },
      { id: 'ver-1', size: 512, mtime: 100 },
    ])
    await openDoc()
    const host = mountPanel()
    await flush()

    expect(host.querySelectorAll('.history-item')).toHaveLength(2)
    const hints = Array.from(host.querySelectorAll('.rail-empty')).map((el) => el.textContent?.trim())
    expect(hints.filter((t) => t?.includes('暂无历史'))).toEqual([])
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
    const restoreBtn = firstRow.querySelector<HTMLButtonElement>('.btn-restore')
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

  it('opens a diff view against the current content', async () => {
    listHistoryMock.mockResolvedValue([
      { id: 'ver-2', size: 100, mtime: 200 },
      { id: 'ver-1', size: 100, mtime: 100 },
    ])
    readHistoryMock.mockResolvedValue('# old title\n\nbody')
    readMock.mockResolvedValue('# new title\n\nbody')
    await openDoc()
    const host = mountPanel()
    await flush()

    const firstRow = host.querySelectorAll('.history-item')[0]
    const compareBtn = firstRow.querySelector<HTMLButtonElement>('.btn-compare')
    expect(compareBtn).toBeTruthy()
    compareBtn?.click()

    await vi.waitFor(() =>
      expect(readHistoryMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'ver-2'),
    )
    await vi.waitFor(() => expect(host.querySelector('.diff-view')).toBeTruthy())

    const lines = Array.from(host.querySelectorAll('.diff-line'))
    expect(lines.some((l) => l.classList.contains('diff-line-del'))).toBe(true)
    expect(lines.some((l) => l.classList.contains('diff-line-add'))).toBe(true)
  })

  it('restores from within the diff view', async () => {
    listHistoryMock.mockResolvedValue([
      { id: 'ver-1', size: 100, mtime: 100 },
    ])
    readHistoryMock.mockResolvedValue('# old\n\nbody')
    readMock.mockResolvedValue('# new\n\nbody')
    restoreHistoryMock.mockResolvedValue('# old\n\nbody')
    await openDoc()
    const host = mountPanel()
    await flush()

    host.querySelector<HTMLButtonElement>('.btn-compare')?.click()
    await vi.waitFor(() => expect(host.querySelector('.diff-view')).toBeTruthy())

    host.querySelector<HTMLButtonElement>('.btn-diff-restore')?.click()
    await vi.waitFor(() =>
      expect(restoreHistoryMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'ver-1'),
    )
  })

  it('closes the diff view via the close button', async () => {
    listHistoryMock.mockResolvedValue([
      { id: 'ver-1', size: 100, mtime: 100 },
    ])
    readHistoryMock.mockResolvedValue('# old')
    readMock.mockResolvedValue('# new')
    await openDoc()
    const host = mountPanel()
    await flush()

    host.querySelector<HTMLButtonElement>('.btn-compare')?.click()
    await vi.waitFor(() => expect(host.querySelector('.diff-view')).toBeTruthy())

    host.querySelector<HTMLButtonElement>('.diff-close')?.click()
    await flush()
    expect(host.querySelector('.diff-view')).toBeNull()
  })

  it('shows a toast when reading the history content fails', async () => {
    listHistoryMock.mockResolvedValue([
      { id: 'ver-1', size: 100, mtime: 100 },
    ])
    readHistoryMock.mockRejectedValue(new Error('boom'))
    await openDoc()
    const host = mountPanel()
    await flush()

    const notified: string[] = []
    const off = onNotify((msg) => notified.push(msg))
    host.querySelector<HTMLButtonElement>('.btn-compare')?.click()
    await flush()
    off()

    expect(host.querySelector('.diff-view')).toBeNull()
    expect(notified).toContain('无法读取历史版本内容')
  })

  it('does not claim there is no history when reading it failed', async () => {
    // 'No history yet' under an error toast tells the user their versions
    // are gone; the truth is that they could not be read.
    listHistoryMock.mockRejectedValue(
      new Error('could not read the history of a.md: permission denied (os error 5)'),
    )
    await openDoc()
    const host = mountPanel()
    await flush()

    expect(host.querySelectorAll('.history-item')).toHaveLength(0)
    const hint = host.querySelector('.rail-empty')?.textContent ?? ''
    expect(hint).toContain(t('history.unreadable'))
    expect(hint).not.toContain(t('history.empty'))
  })
})

describe('a comparison belongs to one note', () => {
  it('drops the diff when the user switches notes', async () => {
    // The diff shows one note's current text against ANOTHER document's old
    // version, and the restore button underneath it acts on the note that is
    // open - so leaving it up mixed two documents together and let a restore be
    // aimed at the wrong note.
    await openDoc('/vault/a.md')
    listHistoryMock.mockResolvedValue([
      { id: 'a1.md', size: 10, mtime: Date.now() },
    ])
    readHistoryMock.mockResolvedValue('OLD TEXT OF A')
    const host = mountPanel()
    await flush()

    const compareBtn = [...host.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('对比'),
    )
    compareBtn?.click()
    await flush()
    expect(host.textContent).toContain('OLD TEXT OF A')

    const tabs = useTabsStore()
    await tabs.openTab('/vault/b.md')
    await flush()

    expect(host.textContent).not.toContain('OLD TEXT OF A')
  })
})
