import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import GraphPanel from './GraphPanel.vue'
import { useTabsStore } from '../stores/tabs'
import { resetVaultFileIndex } from '../services/vaultFiles'

const readMock = vi.hoisted(() => vi.fn())
const listMock = vi.hoisted(() => vi.fn())
const fsOnChangeMock = vi.hoisted(() => vi.fn())
const fsUnlistenMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
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
    onFsChange: fsOnChangeMock,
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
/** Handler registered by the panel's `fsService.onFsChange` subscription, driven
 *  directly by the fs-change tests (the fs gateway mock never emits on its own). */
let capturedFsChange: ((e: { path: string; kind: string }) => void) | null = null

function mountPanel(props?: { vaultReady?: boolean; maxNotes?: number }): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(GraphPanel, props ?? {})
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
}

function emitFsChange(path: string, kind = 'update'): void {
  expect(capturedFsChange).toBeTypeOf('function')
  capturedFsChange!({ path, kind })
}

/** Internals exposed by the script-setup component (the setup bindings), used
 *  to observe computed filter/layout state that has no DOM representation. */
interface PanelState {
  noteCount: number
  edgeCount: number
  filterDir: string
  filterTag: string
  filterLink: string
  showOrphans: boolean
  showBroken: boolean
  orphanCount: number
  brokenCount: number
  brokenSources: Set<string>
  layout: Array<{ id: string; x: number; y: number }>
  visibleGraph: {
    nodes: Array<{ id: string; degree: number }>
    edges: Array<{ from: string; to: string; kind: string }>
  } | null
  rebuildTimer: number | null
}

function state(): PanelState {
  const inst = (mounted[0] as unknown as { _instance?: { setupState?: PanelState } })._instance
  if (!inst?.setupState) throw new Error('component setupState is not available')
  return inst.setupState
}

function selectFilter(ariaLabel: string, value: string): void {
  const el = host!.querySelector(`select[aria-label="${ariaLabel}"]`) as HTMLSelectElement | null
  expect(el).not.toBeNull()
  el!.value = value
  el!.dispatchEvent(new Event('change'))
}

function toggleCheckbox(labelText: string): void {
  const label = Array.from(host!.querySelectorAll('label.graph-toggle')).find(
    (l) => l.textContent?.trim() === labelText,
  )
  expect(label).toBeDefined()
  const input = label!.querySelector('input') as HTMLInputElement
  input.checked = !input.checked
  input.dispatchEvent(new Event('change'))
}

/** Vault with a wiki link, a markdown link, a broken link and an orphan so the
 *  panel's filters/toggles are all exercised:
 *  - docs/a.md  (tag `alpha`) → wiki `[[b]]` and a broken `[[missing]]`
 *  - docs/b.md  (tag `beta`)  → markdown `[a](a.md)`
 *  - root.md                  → no links (orphan, no tags) */
function mountFilterVault(vault = '/vault-filters'): void {
  const contents: Record<string, string> = {
    'docs/a.md': ['---', 'tags:', '  - alpha', '---', '[[b]] [[missing]]'].join('\n'),
    'docs/b.md': ['---', 'tags:', '  - beta', '---', '[a](a.md)'].join('\n'),
    'root.md': '无链接',
  }
  const paths = Object.keys(contents)
  listMock.mockResolvedValue(paths.map(fileEntry))
  readMock.mockImplementation((_vault: string, path: string) =>
    Promise.resolve(contents[path] ?? ''),
  )
  const tabs = useTabsStore()
  tabs.setVault(vault)
  mountPanel()
}

describe('GraphPanel', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    readMock.mockReset()
    listMock.mockReset()
    fsOnChangeMock.mockReset()
    fsUnlistenMock.mockReset()
    capturedFsChange = null
    fsOnChangeMock.mockImplementation(
      (cb: (e: { path: string; kind: string }) => void) => {
        capturedFsChange = cb
        return Promise.resolve(fsUnlistenMock)
      },
    )
    resetVaultFileIndex()
  })

  afterEach(() => {
    for (const app of mounted) app.unmount()
    mounted = []
    host?.remove()
    host = null
    vi.restoreAllMocks()
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
    // A fixed number of macrotask ticks is not a reliable barrier for a chain
    // of reads; wait for the count the rebuild is expected to produce.
    await vi.waitFor(() => expect(readMock.mock.calls.length).toBe(readsAfterMount + 2))
  })

  it('truncates beyond the configured cap with a visible total', async () => {
    const many = Array.from({ length: 201 }, (_v, i) => fileEntry(`n${i}.md`))
    listMock.mockResolvedValue(many)
    readMock.mockResolvedValue('无链接')
    const tabs = useTabsStore()
    tabs.setVault('/vault-3')
    mountPanel({ maxNotes: 200 })
    // Wait for the capped load to finish before asserting on its output.
    await vi.waitFor(() => expect(readMock.mock.calls.length).toBe(200))
    // Non-silent: the notice names the cap AND the true total (not just "first N").
    // The capped read never loads more than the cap; a stale/leaked read would
    // over-read (or, under a partial load, under-count the header), so assert the
    // deterministic truncation signals rather than a transient exact count.
    expect(host!.textContent).toContain('仅展示前 200')
    expect(host!.textContent).toContain('201')
  })

  it('renders the full vault by default (no silent cap)', async () => {
    const many = Array.from({ length: 210 }, (_v, i) => fileEntry(`n${i}.md`))
    listMock.mockResolvedValue(many)
    readMock.mockResolvedValue('无链接')
    const tabs = useTabsStore()
    tabs.setVault('/vault-full')
    mountPanel()
    // Full vault default: every node is read and rendered, no truncation notice.
    await vi.waitFor(() => expect(readMock.mock.calls.length).toBe(210))
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

  it('rebuilds the graph (debounced) when a markdown note changes', async () => {
    listMock.mockResolvedValue([
      fileEntry('notes/a.md'),
      fileEntry('notes/b.md'),
      fileEntry('c.md'),
    ])
    readMock.mockImplementation((_vault: string, path: string) => {
      if (path === 'notes/a.md') return Promise.resolve('[[b]]')
      if (path === 'notes/b.md') return Promise.resolve('回到 [[a]]')
      return Promise.resolve('无链接')
    })
    const tabs = useTabsStore()
    tabs.setVault('/vault-fs')
    mountPanel()
    await flush()
    await flush()
    expect(host!.textContent).toContain('2 条链接')
    expect(host!.textContent).toContain('1 个孤立节点')
    const readsBefore = readMock.mock.calls.length

    // b.md gains a link to c.md (previously an orphan): the graph must rebuild
    // so the edge count and orphan count both change.
    readMock.mockImplementation((_vault: string, path: string) => {
      if (path === 'notes/a.md') return Promise.resolve('[[b]]')
      if (path === 'notes/b.md') return Promise.resolve('[[a]] [[c]]')
      return Promise.resolve('无链接')
    })
    emitFsChange('notes/b.md', 'update')

    // Debounced: nothing is read before REBUILD_DEBOUNCE_MS elapses.
    await flush()
    expect(readMock.mock.calls.length).toBe(readsBefore)

    // After the debounce the change is applied: the single changed note is
    // re-read and the graph shows the new edge (b.md → c.md, and c.md is no
    // longer an orphan).
    await vi.waitFor(() => expect(readMock.mock.calls.length).toBe(readsBefore + 1))
    await flush()
    await flush()
    expect(host!.textContent).toContain('3 条链接')
    expect(host!.textContent).toContain('0 个孤立节点')
  })

  it('ignores non-markdown fs changes (attachments)', async () => {
    listMock.mockResolvedValue([fileEntry('a.md'), fileEntry('b.md')])
    readMock.mockImplementation((_vault: string, path: string) =>
      Promise.resolve(path === 'b.md' ? '[[a]]' : '[[b]]'),
    )
    const tabs = useTabsStore()
    tabs.setVault('/vault-fs2')
    mountPanel()
    await flush()
    await flush()
    const readsBefore = readMock.mock.calls.length
    const listsBefore = listMock.mock.calls.length

    emitFsChange('assets/pic.png', 'update')

    // The handler bails synchronously: no debounce timer is armed at all.
    expect(state().rebuildTimer).toBeNull()
    // And nothing is re-listed or re-read after the (would-be) debounce window.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(readMock.mock.calls.length).toBe(readsBefore)
    expect(listMock.mock.calls.length).toBe(listsBefore)
  })

  it('cancels the pending fs-change rebuild on unmount', async () => {
    listMock.mockResolvedValue([fileEntry('a.md'), fileEntry('b.md')])
    readMock.mockResolvedValue('[[b]] [[c]]')
    const tabs = useTabsStore()
    tabs.setVault('/vault-fs3')
    mountPanel()
    await flush()
    await flush()
    const readsBefore = readMock.mock.calls.length

    emitFsChange('a.md', 'update')
    expect(state().rebuildTimer).not.toBeNull()

    // Unmount before the debounce fires: the pending timer must be cleared.
    // (Capture the setupState first: Vue nulls `app._instance` on unmount.)
    const setup = state()
    const app = mounted[0]!
    app.unmount()
    mounted.shift()
    expect(setup.rebuildTimer).toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(readMock.mock.calls.length).toBe(readsBefore)
  })

  it('directory filter keeps only nodes in the selected directory', async () => {
    mountFilterVault()
    await flush()
    await flush()
    expect(state().visibleGraph!.nodes).toHaveLength(3)

    selectFilter('目录', 'docs')

    await vi.waitFor(() => expect(state().layout).toHaveLength(2))
    expect(state().visibleGraph!.nodes.map((n) => n.id).sort()).toEqual([
      'docs/a.md',
      'docs/b.md',
    ])
    expect(state().layout.map((p) => p.id).sort()).toEqual(['docs/a.md', 'docs/b.md'])
    // Filtering hides nodes from the visible graph/layout, but the full-graph
    // count stays intact (nothing is dropped or truncated).
    expect(state().noteCount).toBe(3)
  })

  it('tag filter (parsed from frontmatter) keeps only notes carrying the tag', async () => {
    mountFilterVault()
    await flush()
    await flush()

    selectFilter('标签', 'beta')

    await vi.waitFor(() => expect(state().layout).toHaveLength(1))
    expect(state().visibleGraph!.nodes.map((n) => n.id)).toEqual(['docs/b.md'])
    // Edges must survive on both endpoints: the tag filter removed docs/a.md
    // so no edge passes through.
    expect(state().visibleGraph!.edges).toHaveLength(0)
  })

  it('link-kind filter separates wiki links from markdown links', async () => {
    mountFilterVault()
    await flush()
    await flush()

    selectFilter('链接类型', 'wiki')

    await vi.waitFor(() =>
      expect(state().visibleGraph!.edges).toEqual([
        { from: 'docs/a.md', to: 'docs/b.md', kind: 'wiki' },
      ]),
    )
    // Link-kind only filters edges; all nodes stay visible.
    expect(state().layout).toHaveLength(3)

    selectFilter('链接类型', 'markdown')

    await vi.waitFor(() =>
      expect(state().visibleGraph!.edges).toEqual([
        { from: 'docs/b.md', to: 'docs/a.md', kind: 'markdown' },
      ]),
    )
  })

  it('broken-link toggle hides the dangling-link stubs without dropping the source node', async () => {
    const dashCalls: number[][] = []
    let clearCalls = 0
    const ctx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(() => {
        clearCalls += 1
      }),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      setLineDash: vi.fn((dash: number[]) => {
        dashCalls.push([...dash])
      }),
      lineWidth: 1,
      strokeStyle: '',
      fillStyle: '',
      globalAlpha: 1,
    }
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    const dashedStubCount = (): number => dashCalls.filter((dash) => dash.length > 0).length

    mountFilterVault()
    await flush()
    await flush()
    await vi.waitFor(() => expect(state().layout).toHaveLength(3))

    // doc/a.md links `[[missing]]` (unresolvable): the source is marked.
    expect(state().brokenCount).toBe(1)
    expect(state().brokenSources.has('docs/a.md')).toBe(true)
    // Broken stubs are drawn as dashed strokes in the initial render.
    await vi.waitFor(() => expect(dashedStubCount()).toBeGreaterThan(0))
    const dashesBeforeToggle = dashedStubCount()

    toggleCheckbox('断链')
    expect(state().showBroken).toBe(false)

    // The toggle triggers a re-layout/re-draw; the dashes must not reappear.
    await vi.waitFor(() => expect(clearCalls).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(dashedStubCount()).toBe(dashesBeforeToggle)
    // Toggling only hides the marking: the node itself stays in the graph.
    expect(state().visibleGraph!.nodes.map((n) => n.id)).toContain('docs/a.md')
    getContextSpy.mockRestore()
  })

  it('orphan toggle hides degree-0 nodes from the visible graph', async () => {
    mountFilterVault()
    await flush()
    await flush()

    expect(state().orphanCount).toBe(1)
    expect(state().visibleGraph!.nodes.map((n) => n.id)).toContain('root.md')

    toggleCheckbox('孤立节点')
    expect(state().showOrphans).toBe(false)

    await vi.waitFor(() => expect(state().layout).toHaveLength(2))
    expect(state().visibleGraph!.nodes.map((n) => n.id).sort()).toEqual([
      'docs/a.md',
      'docs/b.md',
    ])
    // Toggling hides orphans from the visible graph; the full-graph count is
    // untouched.
    expect(state().orphanCount).toBe(1)
  })
})
