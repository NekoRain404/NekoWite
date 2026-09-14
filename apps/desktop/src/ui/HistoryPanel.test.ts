import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  ref,
  vShow,
  withDirectives,
  type App as VueApp,
  type Ref,
} from 'vue'
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

/** A read the test settles by hand, so two of them can settle out of order. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const version = (id: string): { id: string; size: number; mtime: number } => ({
  id,
  size: 100,
  mtime: 100,
})

const renderedIds = (host: HTMLElement): (string | null)[] =>
  Array.from(host.querySelectorAll('.history-id')).map((el) => el.textContent)

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

/** Mounts the panel the way InfoRail does: mounted, hidden with `v-show` while
 *  another rail section has the tab. */
function mountSection(shown: Ref<boolean>): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(
    defineComponent({
      render: () => withDirectives(h(HistoryPanel), [[vShow, shown.value]]),
    }),
  )
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  return host
}

describe('reading the history only when it can have changed', () => {
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
    listHistoryMock.mockResolvedValue([{ id: 'ver-1', size: 100, mtime: 100 }])
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  it('does not read the history while the user is typing', async () => {
    // A version file only appears when a save writes one, so a keystroke is not
    // a reason to issue a listHistory IPC read.
    await openDoc()
    mountPanel()
    await flush()
    const before = historyCallCount()

    const tabs = useTabsStore()
    for (let i = 0; i < 5; i++) {
      tabs.activeTab!.content = `# hello ${i}`
      tabs.markDirty(tabs.activeTab!.id)
      await nextTick()
      await flush()
    }

    expect(historyCallCount()).toBe(before)
  })

  it('reads the history again once a save lands', async () => {
    await openDoc()
    mountPanel()
    await flush()
    const tabs = useTabsStore()
    const tab = tabs.activeTab!

    tab.content = '# typed since the last save'
    tabs.markDirty(tab.id)
    await nextTick()
    const afterTyping = historyCallCount()

    await tabs.saveTab(tab.id)
    await flush()
    await flush()

    expect(historyCallCount()).toBeGreaterThan(afterTyping)
  })

  it('does not read while its rail section is hidden, and reads when it is shown', async () => {
    // Both notes are opened before the panel mounts: `openTab` reads the
    // version list itself (crash recovery), and counting its reads would hide
    // what the panel does. Switching the active tab has no such side effect.
    const tabs = useTabsStore()
    await openDoc('/vault/a.md')
    await tabs.openTab('/vault/b.md')
    const idFor = (path: string): string => tabs.tabs.find((t) => t.path === path)!.id
    tabs.activeId = idFor('/vault/a.md')

    const shown = ref(false)
    listHistoryMock.mockClear()
    mountSection(shown)
    await flush()
    // Mounting hidden is the rail's normal case (it opens on its AI tab): it
    // must not read either.
    expect(historyCallCount()).toBe(0)

    tabs.activeId = idFor('/vault/b.md')
    await flush()
    await flush()
    expect(historyCallCount()).toBe(0)

    shown.value = true
    await flush()
    await flush()
    expect(historyCallCount()).toBe(1)
  })

  it('still re-reads for the note switch while it is on screen', async () => {
    const tabs = useTabsStore()
    await openDoc('/vault/a.md')
    await tabs.openTab('/vault/b.md')
    const idFor = (path: string): string => tabs.tabs.find((t) => t.path === path)!.id
    tabs.activeId = idFor('/vault/a.md')

    mountPanel()
    await flush()
    listHistoryMock.mockClear()

    tabs.activeId = idFor('/vault/b.md')
    await flush()
    await flush()

    expect(historyCallCount()).toBe(1)
  })
})

describe('the version list describes the note that is open', () => {
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

  it('keeps the newer list when an earlier read resolves after it', async () => {
    // Two reads overlap on a note switch (or a save tick, or Refresh) and the
    // later-RESOLVING one used to win: note A's versions rendered under note B,
    // and every Restore in that list then aimed A's version id at B's file.
    const tabs = useTabsStore()
    await openDoc('/vault/a.md')
    await tabs.openTab('/vault/b.md')
    const idFor = (path: string): string => tabs.tabs.find((t) => t.path === path)!.id
    tabs.activeId = idFor('/vault/a.md')

    const aRead = deferred<ReturnType<typeof version>[]>()
    const bRead = deferred<ReturnType<typeof version>[]>()
    listHistoryMock.mockReset()
    listHistoryMock
      .mockImplementationOnce(() => aRead.promise)
      .mockImplementationOnce(() => bRead.promise)

    const host = mountPanel()
    await flush()
    // The switch starts B's read while A's is still in flight.
    tabs.activeId = idFor('/vault/b.md')
    await nextTick()
    await flush()
    expect(listHistoryMock).toHaveBeenCalledTimes(2)

    bRead.resolve([version('b-version-1')])
    await flush()
    expect(renderedIds(host)).toEqual(['b-version-1'])

    aRead.resolve([version('a-version-1')])
    await flush()

    expect(renderedIds(host)).toEqual(['b-version-1'])
  })

  it('does not toast a failure of a read the user has already left behind', async () => {
    const tabs = useTabsStore()
    await openDoc('/vault/a.md')
    await tabs.openTab('/vault/b.md')
    const idFor = (path: string): string => tabs.tabs.find((t) => t.path === path)!.id
    tabs.activeId = idFor('/vault/a.md')

    const aRead = deferred<ReturnType<typeof version>[]>()
    const bRead = deferred<ReturnType<typeof version>[]>()
    listHistoryMock.mockReset()
    listHistoryMock
      .mockImplementationOnce(() => aRead.promise)
      .mockImplementationOnce(() => bRead.promise)

    const notified: string[] = []
    const off = onNotify((msg) => notified.push(msg))
    const host = mountPanel()
    await flush()
    tabs.activeId = idFor('/vault/b.md')
    await nextTick()
    await flush()

    bRead.resolve([version('b-version-1')])
    await flush()
    aRead.reject(new Error('could not read the history of a.md'))
    await flush()
    off()

    expect(notified).toEqual([])
    expect(renderedIds(host)).toEqual(['b-version-1'])
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
