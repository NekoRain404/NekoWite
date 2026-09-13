import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { setSourceViewHandle } from '../../../services/sourceView'
import { onNotify } from '../../../services/errors'
import {
  resetMemoryPickedFiles,
  seedMemoryPickedFiles,
} from '../../../platform/gateways/memory'

const importAttachmentMock = vi.hoisted(() => vi.fn())

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    read: vi.fn().mockResolvedValue('Hello\n'),
    write: vi.fn(),
    list: vi.fn(),
    watch: vi.fn(),
    deleteFile: vi.fn(),
    stat: vi.fn(),
    listHistory: vi.fn().mockResolvedValue([]),
    saveAttachment: vi.fn(),
    importAttachment: importAttachmentMock,
    resolveMediaPath: vi.fn(),
    onFsChange: vi.fn(),
  },
}))

import { useImageIntake } from './useImageIntake'

/** Real-EditorState stand-in so the source insert runs through CodeMirror. */
function makeSourceView(doc: string) {
  let state = EditorState.create({ doc, selection: EditorSelection.single(doc.length) })
  const view = {
    hasFocus: true,
    get state() {
      return state
    },
    dispatch: (spec: Parameters<EditorState['update']>[0]) => {
      state = state.update(spec).state
    },
    focus: () => undefined,
  }
  return { view: view as unknown as EditorView, doc: () => state.doc.toString() }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let pinia: Pinia
let mounted: VueApp[] = []
let intake: ReturnType<typeof useImageIntake> | null = null
let notifications: string[] = []

/**
 * The intake flow is shared by both panes, so it is exercised here against a
 * host component rather than through either pane's template.
 */
const Harness = defineComponent({
  setup() {
    intake = useImageIntake()
    return () => null
  },
})

function mountHarness(): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(Harness)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
}

describe('useImageIntake picker flow', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    intake = null
    notifications = []
    setSourceViewHandle(null)
    resetMemoryPickedFiles()
    importAttachmentMock.mockReset()
    importAttachmentMock.mockResolvedValue('attachments/2026-09/cat.png')
    useTabsStore().setVault('/vault')
    void useTabsStore().openTab('notes/a.md')
    mountHarness()
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
    setSourceViewHandle(null)
    resetMemoryPickedFiles()
  })

  it('imports the picked files and inserts Markdown into the source pane', async () => {
    const source = makeSourceView('raw text\n')
    setSourceViewHandle({ getView: () => source.view, flush: () => undefined })
    useViewStore().setMode('source')
    seedMemoryPickedFiles({ 'C:/pics/cat.png': 'QQ==' })

    await intake!.insertImagesFromPicker()
    await flush()

    // Picked files keep their own name on disk, so no rename is prompted.
    expect(importAttachmentMock).toHaveBeenCalledWith('/vault', 'C:/pics/cat.png', 'notes/a_assets')
    expect(source.doc()).toContain('![cat.png](../attachments/2026-09/cat.png)')
  })

  it('does nothing when the picker is cancelled', async () => {
    const source = makeSourceView('raw\n')
    setSourceViewHandle({ getView: () => source.view, flush: () => undefined })
    useViewStore().setMode('source')

    await intake!.insertImagesFromPicker()
    await flush()

    expect(importAttachmentMock).not.toHaveBeenCalled()
    expect(source.doc()).toBe('raw\n')
  })

  it('imports every file of a multi-select in order', async () => {
    const source = makeSourceView('')
    setSourceViewHandle({ getView: () => source.view, flush: () => undefined })
    useViewStore().setMode('source')
    importAttachmentMock.mockImplementation(async (_v: string, path: string) =>
      `attachments/2026-09/${path.split('/').pop()}`,
    )
    seedMemoryPickedFiles({ 'C:/pics/one.png': 'QQ==', 'C:/pics/two.png': 'QQ==' })

    await intake!.insertImagesFromPicker()
    await flush()

    expect(importAttachmentMock).toHaveBeenCalledTimes(2)
    const doc = source.doc()
    // Both images, in pick order.
    expect(doc.indexOf('![one.png](../attachments/2026-09/one.png)')).toBeGreaterThanOrEqual(0)
    expect(doc.indexOf('![two.png](../attachments/2026-09/two.png)')).toBeGreaterThan(
      doc.indexOf('![one.png](../attachments/2026-09/one.png)'),
    )
  })

  it('surfaces an import failure without touching the document', async () => {
    const source = makeSourceView('raw\n')
    setSourceViewHandle({ getView: () => source.view, flush: () => undefined })
    useViewStore().setMode('source')
    seedMemoryPickedFiles({ 'C:/pics/cat.png': 'QQ==' })
    importAttachmentMock.mockRejectedValue(new Error('too large'))
    const off = onNotify((msg) => notifications.push(msg))

    await intake!.insertImagesFromPicker()
    await flush()
    off()

    expect(source.doc()).toBe('raw\n')
    expect(notifications).toHaveLength(1)
  })

  it('stays quiet when no vault is open', async () => {
    useTabsStore().vault = null
    seedMemoryPickedFiles({ 'C:/pics/cat.png': 'QQ==' })
    const off = onNotify((msg) => notifications.push(msg))

    await intake!.insertImagesFromPicker()
    await flush()
    off()

    expect(importAttachmentMock).not.toHaveBeenCalled()
    expect(notifications).toHaveLength(1)
  })
})
