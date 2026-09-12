import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useAppearanceStore } from '../stores/appearance'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'

// The note is built inside the factory: `vi.mock` is hoisted above every
// top-level binding, so it cannot close over one.
vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: vi.fn().mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
    ),
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
    saveAttachment: vi.fn(),
    importAttachment: vi.fn(),
    resolveMediaPath: vi.fn(),
  },
}))

import EditorPane from './EditorPane.vue'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let pinia: Pinia
let mounted: VueApp[] = []

/** happy-dom performs no layout, so every scroll container reports a range of
 *  zero and both panes would treat every scroll as a no-op. Giving the two
 *  containers a real range is what makes the ratio math observable. */
function fakeScrollMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
}

describe('EditorPane split scroll sync', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    useAppearanceStore().setAutoSyncScroll(true)
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    useAppearanceStore().setAutoSyncScroll(true)
    document.body.innerHTML = ''
  })

  async function mountSplit(): Promise<{ rendered: HTMLElement; sourceScroller: HTMLElement }> {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('notes/a.md')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(EditorPane)
    app.use(pinia)
    app.mount(host)
    mounted.push(app)
    await flush()

    useViewStore().setMode('split')
    // The source pane is an async component (CodeMirror is loaded on demand).
    for (let i = 0; i < 40; i += 1) {
      await flush()
      if (host.querySelector('.pane.source .cm-scroller')) break
    }

    const rendered = host.querySelector<HTMLElement>('.pane.rendered')
    const sourceScroller = host.querySelector<HTMLElement>('.pane.source .cm-scroller')
    expect(rendered).not.toBeNull()
    expect(sourceScroller).not.toBeNull()
    fakeScrollMetrics(rendered!, 1000, 100)
    fakeScrollMetrics(sourceScroller!, 1000, 100)
    await nextTick()
    return { rendered: rendered!, sourceScroller: sourceScroller! }
  }

  it('keeps the panes in step while the setting is on (default)', async () => {
    const { rendered, sourceScroller } = await mountSplit()

    // Scroll the rendered pane to half of its range; the source pane must land
    // on the same ratio.
    rendered.scrollTop = 450
    useViewStore().syncScroll('rendered', 450)
    await flush()

    expect(sourceScroller.scrollTop).toBeCloseTo(450, 3)
  })

  it('leaves the other pane where it is once the setting is off', async () => {
    const { rendered, sourceScroller } = await mountSplit()
    useAppearanceStore().setAutoSyncScroll(false)

    rendered.scrollTop = 810
    useViewStore().syncScroll('rendered', 810)
    await flush()

    expect(sourceScroller.scrollTop).toBe(0)
  })

  it('starts syncing again when the setting is turned back on', async () => {
    const { rendered, sourceScroller } = await mountSplit()
    useAppearanceStore().setAutoSyncScroll(false)
    rendered.scrollTop = 810
    useViewStore().syncScroll('rendered', 810)
    await flush()
    expect(sourceScroller.scrollTop).toBe(0)

    useAppearanceStore().setAutoSyncScroll(true)
    rendered.scrollTop = 900
    useViewStore().syncScroll('rendered', 900)
    await flush()

    expect(sourceScroller.scrollTop).toBeCloseTo(900, 3)
  })
})
