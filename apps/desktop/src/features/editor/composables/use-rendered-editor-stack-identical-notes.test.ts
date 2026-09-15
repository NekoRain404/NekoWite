/**
 * Two notes that hold the same text are still two documents.
 *
 * The rendered pane reconciles its model with `tabs.activeTab.content`, and it
 * used to decide "this is the document I already have" by the TEXT alone. For
 * two notes whose text happens to be equal — two empty ones most obviously —
 * switching between them changed nothing the pane could see, so the model kept
 * the note being left: its undo stack, its caret, its stored positions. Ctrl+Z
 * in the new note then inverted an edit made in the old one, and the next
 * autosave wrote the result into the new note's file.
 *
 * L06's fix direction is that the state boundary must include the vault and the
 * document id, not the body: `session.appliedKey` is that identity, the
 * content watcher fires on it as well as on the text, and the idempotence and
 * echo guards ask about it — so a switch between two identical notes re-opens
 * the model, which is what gives the new note its own (empty) history.
 *
 * This is the audit's reproduction, end to end: edit a note until its text
 * equals another open note's, switch to it, and try to undo the edit you made
 * in the other one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, ref, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { undo, undoDepth } from '@milkdown/prose/history'
import { useTabsStore } from '../../../stores/tabs'

const readMock = vi.hoisted(() => vi.fn())
vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
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

import { useRenderedEditorStack } from './use-rendered-editor-stack'

const realFlush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let pinia: Pinia
let mounted: VueApp[] = []

function mountStack() {
  const scrollEl = ref<HTMLElement | null>(null)
  const editorEl = ref<HTMLElement | null>(null)
  let api: ReturnType<typeof useRenderedEditorStack> | null = null
  const host = defineComponent({
    setup() {
      api = useRenderedEditorStack({
        getScrollEl: () => scrollEl.value,
        getEditorEl: () => editorEl.value,
        handlers: { onEditorClick: () => {}, onKeydown: () => {} },
      })
      return () => h('div', { ref: scrollEl }, [h('div', { ref: editorEl })])
    },
  })
  const app = createApp(host)
  app.use(pinia)
  app.mount(document.createElement('div'))
  mounted.push(app)
  return api as unknown as ReturnType<typeof useRenderedEditorStack>
}

describe('two notes holding the same text', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    document.body.innerHTML = ''
    mounted = []
    readMock.mockReset()
    readMock.mockImplementation(async (_vault: string, path: string) =>
      path.endsWith('b.md') ? 'Xshared\n' : 'shared\n',
    )
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  it('gives the note being switched to its own history, not the one being left', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    // b.md's file already holds the text a.md is about to be edited into.
    await tabs.openTab('notes/b.md')
    await tabs.openTab('notes/a.md')
    const stack = mountStack()
    await realFlush()
    await realFlush()

    const a = tabs.tabs.find((t) => t.path === 'notes/a.md')!
    const b = tabs.tabs.find((t) => t.path === 'notes/b.md')!
    const editor = stack.editorForPanel.value!
    const view = editor.getView()

    // The user edits a.md into exactly b.md's text.
    view.dispatch(view.state.tr.insertText('X', 1))
    expect(await editor.save()).toContain('Xshared')
    expect(undoDepth(view.state)).toBeGreaterThan(0)
    // Let the publish land, so the switch below is a text-identical one.
    await new Promise((r) => setTimeout(r, 200))
    expect(a.content).toBe('Xshared\n')
    expect(b.content).toBe('Xshared\n')

    tabs.setActive(b.id)
    await new Promise((r) => setTimeout(r, 200))

    // The claim: the model is b.md's document now, so the edit made in a.md is
    // not on its undo stack — and undoing cannot silently rewrite b.md's file.
    expect(undoDepth(view.state)).toBe(0)
    const before = await editor.save()
    expect(undo(view.state, (tr) => view.dispatch(tr))).toBe(false)
    expect(await editor.save()).toBe(before)
    expect(b.dirty).toBe(false)
  })

  it('does the same for two empty notes', async () => {
    readMock.mockResolvedValue('')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('notes/empty-b.md')
    await tabs.openTab('notes/empty-a.md')
    const stack = mountStack()
    await realFlush()
    await realFlush()

    const first = tabs.tabs.find((t) => t.path === 'notes/empty-a.md')!
    const second = tabs.tabs.find((t) => t.path === 'notes/empty-b.md')!
    const view = stack.editorForPanel.value!.getView()
    const versionBefore = stack.documentVersion.value

    view.dispatch(view.state.tr.insertText('typed here', 1))
    expect(undoDepth(view.state)).toBeGreaterThan(0)

    tabs.setActive(second.id)
    await new Promise((r) => setTimeout(r, 200))

    // Nothing about the text changed, so only the document identity can tell
    // the pane that this is a different note — and it has to.
    expect(stack.documentVersion.value).toBe(versionBefore + 1)
    expect(undoDepth(view.state)).toBe(0)
    expect(await stack.editorForPanel.value!.save()).toBe('')
    expect(first.content).toContain('typed here')
  })
})
