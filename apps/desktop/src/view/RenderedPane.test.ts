import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useTabsStore } from '../stores/tabs'

const saveAttachmentMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: vi.fn().mockResolvedValue('Hello\n'),
    write: vi.fn(),
    list: vi.fn(),
    watch: vi.fn(),
    deleteFile: vi.fn(),
    stat: vi.fn(),
    listHistory: vi.fn().mockResolvedValue([]),
    readHistory: vi.fn(),
    restoreHistory: vi.fn(),
    openFolderDialog: vi.fn(),
    saveFileDialog: vi.fn(),
    onFsChange: vi.fn(),
    listTrash: vi.fn(),
    restoreFromTrash: vi.fn(),
    saveAttachment: saveAttachmentMock,
    resolveMediaPath: vi.fn(),
  },
}))

vi.mock('../services/announcer', () => ({ announce: vi.fn() }))

import RenderedPane from './RenderedPane.vue'
import { editorBridge } from '../services/editor-bridge'
import { fsService } from '../platform/gateways/fs'
import { announce } from '../services/announcer'
import { setRenderSearchState } from '../services/render-search'
import { t } from '../i18n'
import { useAppearanceStore } from '../stores/appearance'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let pinia: Pinia
let mounted: VueApp[] = []

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  saveAttachmentMock.mockReset()
  saveAttachmentMock.mockResolvedValue('attachments/2026-09/paste-x.png')
  document.body.innerHTML = ''
  mounted = []
  // The search state is module-scope: a pane that leaves a query behind would
  // be read by the next case.
  setRenderSearchState({ open: false, query: '', active: 0, ranges: [], replace: '' })
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

describe('RenderedPane content injection', () => {
  it('renders the loaded markdown when the tab opens AFTER the pane mounts (E2E order)', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(RenderedPane)
    app.use(pinia)
    app.mount(host)
    mounted.push(app)
    await flush()

    // The file read is async and resolved AFTER the placeholder tab exists —
    // the disk content must reach the editor (it was previously lost because
    // the read mutated the raw placeholder object, which bypasses Vue
    // reactivity so the content watcher never re-fired).
    vi.mocked(fsService.read).mockResolvedValue('# Welcome\n\nbody')
    await tabs.openTab('notes/welcome.md')
    await flush()
    await flush()

    const h1 = document.querySelector('.rendered-pane .ProseMirror h1')
    expect(h1?.textContent).toBe('Welcome')
    const md = await editorBridge.getEditor()?.save()
    expect(md).toContain('# Welcome')
  })

  it('follows the task-list rendering setting without rebuilding the editor', async () => {
    const appearance = useAppearanceStore()
    appearance.setRenderTaskChecklist(true)
    vi.mocked(fsService.read).mockResolvedValue('- [ ] todo\n- [x] done\n')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(RenderedPane)
    app.use(pinia)
    app.mount(host)
    mounted.push(app)
    await flush()

    await tabs.openTab('notes/tasks.md')
    await flush()
    await flush()

    const items = (): HTMLElement[] => [
      ...document.querySelectorAll<HTMLElement>('.rendered-pane li[data-item-type="task"]'),
    ]
    // The class is editor-core's TASK_PLAIN_CLASS; spelled out here so this case
    // keeps failing for the right reason (no consumer) on an older editor-core.
    const plain = (): HTMLElement[] => [
      ...document.querySelectorAll<HTMLElement>('.rendered-pane li.neko-task-plain'),
    ]
    expect(items()).toHaveLength(2)
    expect(plain()).toHaveLength(0)

    // Off: the item keeps its markdown marker as text, the box is gone.
    appearance.setRenderTaskChecklist(false)
    await nextTick()
    expect(plain()).toHaveLength(2)
    expect(items()[0]!.getAttribute('data-neko-task-marker')).toBe('[ ]')
    expect(items()[1]!.getAttribute('data-neko-task-marker')).toBe('[x]')

    // ...and back on again, on the same editor instance.
    appearance.setRenderTaskChecklist(true)
    await nextTick()
    expect(plain()).toHaveLength(0)
  })
})

describe('RenderedPane teardown', () => {
  // The find panel's live-region announcer watches the SHARED render-search
  // state, so a watch that outlived its pane would keep announcing that pane's
  // count for whatever the next pane searches — and the pane tears the overlay
  // down with `cancelRefresh()`, never `dispose()` (brief 28 item 2). The watch
  // is created during setup, so Vue's effect scope stops it at unmount; this
  // pins that, and the live half above the unmount is what keeps the silence
  // below from passing vacuously.
  it('stops the find count announcer when the pane unmounts', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    vi.mocked(fsService.read).mockResolvedValue('alpha beta')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(RenderedPane)
    app.use(pinia)
    app.mount(host)
    mounted.push(app)
    await flush()
    await tabs.openTab('notes/a.md')
    await flush()
    await flush()

    // Ctrl+F through the pane's own window handler: the announcer only speaks
    // while the find panel is open, so the watch has to be armed to be tested.
    document
      .querySelector('.rendered-pane')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
    await nextTick()
    expect(document.querySelector('.nw-render-search-host')).not.toBeNull()

    vi.mocked(announce).mockClear()
    setRenderSearchState({ query: 'zzz', ranges: [{ from: 0, to: 1 }, { from: 2, to: 3 }] })
    await nextTick()
    expect(announce).toHaveBeenCalledWith(t('recovery.searchCount', { count: 2 }))

    app.unmount()
    mounted = []

    // Nothing is mounted any more. The state below is the state another pane
    // would drive; the count must not be announced a second time.
    vi.mocked(announce).mockClear()
    setRenderSearchState({ query: 'zzz', ranges: [{ from: 0, to: 1 }] })
    await nextTick()
    expect(announce).not.toHaveBeenCalled()
  })
})
