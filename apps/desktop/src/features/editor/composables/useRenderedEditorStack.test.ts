import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, ref, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useTabsStore } from '../../../stores/tabs'

vi.mock('../../../platform/gateways/fs', () => ({
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
    saveAttachment: vi.fn(),
    resolveMediaPath: vi.fn(),
  },
}))

import { fsService } from '../../../platform/gateways/fs'
import { useRenderedEditorStack, type RenderedEditorStackOptions } from './useRenderedEditorStack'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let pinia: Pinia
let mounted: VueApp[] = []

/**
 * A host with nothing on it but the two elements the stack mounts onto — the
 * whole point of the extraction is that this contract can be exercised without
 * going through the rendered pane.
 */
function mountStack(overrides: Partial<RenderedEditorStackOptions['handlers']> = {}) {
  const scrollEl = ref<HTMLElement | null>(null)
  const editorEl = ref<HTMLElement | null>(null)
  let api: ReturnType<typeof useRenderedEditorStack> | null = null
  const handlers = {
    onEditorClick: overrides.onEditorClick ?? (() => {}),
    onKeydown: overrides.onKeydown ?? (() => {}),
  }
  const host = defineComponent({
    setup() {
      api = useRenderedEditorStack({
        getScrollEl: () => scrollEl.value,
        getEditorEl: () => editorEl.value,
        handlers,
      })
      return () => h('div', { ref: scrollEl }, [h('div', { ref: editorEl })])
    },
  })
  const app = createApp(host)
  app.use(pinia)
  app.mount(document.createElement('div'))
  mounted.push(app)
  return {
    stack: api as unknown as ReturnType<typeof useRenderedEditorStack>,
    editorEl,
  }
}

describe('useRenderedEditorStack', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  it('mounts an editor over the open document, and only then listens for changes', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    vi.mocked(fsService.read).mockResolvedValue('# Welcome\n\nbody')
    await tabs.openTab('notes/welcome.md')

    const { stack } = mountStack()
    await flush()
    await flush()

    const editor = stack.editorForPanel.value
    expect(editor).not.toBeNull()
    expect(await editor?.save()).toContain('# Welcome')

    // The change listeners go on after the open of the mount. Were they on
    // first, loading the document would report itself as an edit and open every
    // note with its tab already dirty (and an autosave timer armed). The edit
    // below is what keeps this from passing vacuously.
    expect(tabs.activeTab?.dirty).toBe(false)
    const view = editor!.getView()
    view.dispatch(view.state.tr.insertText('more ', 1))
    expect(tabs.activeTab?.dirty).toBe(true)
  })

  it('unwires the pane handlers and the editor when the host unmounts', async () => {
    const onEditorClick = vi.fn()
    const onKeydown = vi.fn()
    const { stack, editorEl } = mountStack({ onEditorClick, onKeydown })
    await flush()

    // Held across the unmount: Vue clears the template ref there, and dispatching
    // on a null would make the "no longer called" half of this test vacuous.
    const el = editorEl.value
    expect(el).not.toBeNull()

    el!.dispatchEvent(new Event('click'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }))
    expect(onEditorClick).toHaveBeenCalledTimes(1)
    expect(onKeydown).toHaveBeenCalledTimes(1)

    mounted[0]!.unmount()
    mounted = []

    expect(stack.editorForPanel.value).toBeNull()
    el!.dispatchEvent(new Event('click'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }))
    expect(onEditorClick).toHaveBeenCalledTimes(1)
    expect(onKeydown).toHaveBeenCalledTimes(1)
  })
})
