import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import SourcePane from './SourcePane.vue'
import { useAppearanceStore } from '../stores/appearance'
import { useTabsStore } from '../stores/tabs'
import { mirrorChange } from '../features/editor/model/mirror-change'

// The pane's job here is only to publish a direction; CodeMirror itself is
// exercised elsewhere, and its real host cannot run in happy-dom.
const hostMock = vi.hoisted(() => ({
  mount: vi.fn(),
  getView: vi.fn((): unknown => null),
  setText: vi.fn(),
  flush: vi.fn(),
  reconfigure: vi.fn(),
  resetHistory: vi.fn(),
  destroy: vi.fn(),
}))

vi.mock('../services/code-mirror-host', () => ({
  createCodeMirrorHost: () => hostMock,
  // The real one is a CodeMirror annotation; the pane only has to hand it to a
  // dispatch, so a stand-in with the same surface is enough here.
  ExternalChange: { of: (value: boolean) => ({ isExternalChange: value }) },
}))

const readMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    watch: vi.fn(),
    stat: vi.fn(),
    onFsChange: vi.fn().mockResolvedValue(() => undefined),
    listHistory: vi.fn().mockResolvedValue([]),
    listTrash: vi.fn().mockResolvedValue([]),
  },
}))

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let pinia: Pinia
let mounted: VueApp[] = []

function mountPane(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(SourcePane)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  return host
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  readMock.mockReset()
  readMock.mockResolvedValue('# hello')
  hostMock.setText.mockClear()
  hostMock.resetHistory.mockClear()
  hostMock.getView.mockReturnValue(null)
  document.body.innerHTML = ''
  mounted = []
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

async function openDoc(content: string): Promise<void> {
  const tabs = useTabsStore()
  tabs.setVault('/vault')
  readMock.mockResolvedValue(content)
  await tabs.openTab('/vault/a.md')
}

describe('SourcePane content direction', () => {
  it('follows the document when the setting is auto', async () => {
    // The rendered pane already honoured the "content direction" setting; the
    // source pane did not, so split mode showed the same Arabic/Hebrew note
    // LTR on the left and RTL on the right.
    await openDoc('# عنوان عربي')
    const host = mountPane()
    await flush()
    await nextTick()

    expect(host.querySelector('[data-testid="source-pane"]')!.getAttribute('dir')).toBe('rtl')
  })

  it('reacts to the setting changing while the pane is open', async () => {
    await openDoc('# plain latin text')
    const host = mountPane()
    await flush()
    await nextTick()
    const pane = host.querySelector('[data-testid="source-pane"]')!
    expect(pane.getAttribute('dir')).toBe('ltr')

    // The setting is reactive; the pane has to follow it without a reload,
    // exactly like the rendered pane does.
    useAppearanceStore().setContentDirection('rtl')
    await nextTick()
    expect(pane.getAttribute('dir')).toBe('rtl')

    useAppearanceStore().setContentDirection('auto')
    await nextTick()
    expect(pane.getAttribute('dir')).toBe('ltr')
  })

  describe('mirroring the tab text', () => {
    /** The live CodeMirror view the pane would be holding, as far as the pane's
     *  own code is concerned: a document it can read and a dispatch it makes. */
    function stubView(doc: string) {
      const dispatch = vi.fn()
      return {
        dispatch,
        view: {
          state: { doc: { toString: () => doc } },
          dispatch,
          // The pane's teardown detaches its scroll listener from the view.
          scrollDOM: { addEventListener: vi.fn(), removeEventListener: vi.fn(), scrollTop: 0 },
        },
      }
    }

    it('applies an edit of the same note as the smallest change, never a whole-document replacement', async () => {
      // Measured defect (browser, 9000px note, split mode): the host's setText
      // replaces the whole document, CodeMirror maps its scroll anchor to
      // position 0 for that, and the pane collapses from 4145px to 115px — which
      // the split sync then reads as a scroll the user made and drags the other
      // pane to the top with it. A minimal change maps every position through
      // itself, so nothing moves.
      await openDoc('# Note\n\nfirst line\n')
      const stub = stubView('# Note\n\nfirst line\n')
      hostMock.getView.mockReturnValue(stub.view)
      mountPane()
      await flush()
      await nextTick()

      const tabs = useTabsStore()
      tabs.activeTab!.content = '# Note\n\nfirst line EDITED\n'
      await nextTick()
      await flush()

      expect(stub.dispatch).toHaveBeenCalledTimes(1)
      const spec = stub.dispatch.mock.calls[0]![0] as { changes: { from: number; to: number; insert: string } }
      expect(spec.changes).toEqual(mirrorChange('# Note\n\nfirst line\n', '# Note\n\nfirst line EDITED\n'))
      // The whole document is NOT the range: that is the defect this pins.
      expect(spec.changes.to - spec.changes.from).toBeLessThan('# Note\n\nfirst line\n'.length)
      // The host is still told, so its snapshot bookkeeping stays its own; the
      // document already holds the text, which is its documented no-op path.
      expect(hostMock.setText).toHaveBeenCalledWith('# Note\n\nfirst line EDITED\n')
      expect(hostMock.resetHistory).toHaveBeenCalled()
    })

    it('falls back to the host when the view does not exist yet', async () => {
      await openDoc('# Note\n')
      hostMock.getView.mockReturnValue(null)
      mountPane()
      await flush()
      await nextTick()
      hostMock.setText.mockClear()

      const tabs = useTabsStore()
      tabs.activeTab!.content = '# Note edited\n'
      await nextTick()
      await flush()

      expect(hostMock.setText).toHaveBeenCalledWith('# Note edited\n')
    })
  })

  it('drops the CodeMirror undo stack when the mirrored tab changes', async () => {
    // Two notes holding identical text are a document swap `setText` cannot
    // see — it compares text, so it takes its "nothing to do" path and leaves
    // the previous note's undo entries reachable. Ctrl+Z in the new note would
    // then invert an edit made in the old one and autosave the result into the
    // new file. The pane knows a switch happened even when `setText` does not,
    // so it has to drop the stack itself.
    await openDoc('# same text in both notes')
    mountPane()
    await flush()
    await nextTick()
    hostMock.resetHistory.mockClear()

    const tabs = useTabsStore()
    readMock.mockResolvedValue('# same text in both notes')
    await tabs.openTab('/vault/b.md')
    await flush()
    await nextTick()

    expect(tabs.activeId).toBe(tabs.tabs.find((t) => t.path === '/vault/b.md')!.id)
    expect(hostMock.resetHistory).toHaveBeenCalled()
  })
})
