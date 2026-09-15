/**
 * The properties panel's writes have to publish the pane the user is typing in
 * before they rewrite the document.
 *
 * Every write here is a whole-document read-modify-write (`replaceFrontmatter`
 * over `tab.content`), and `tab.content` lags the rendered pane by its 120 ms
 * publish debounce — the default view's only mounted pane. A panel edit landing
 * inside that window applied the frontmatter to the pre-keystroke text, wrote
 * that back, and the model was then rebuilt from it: the typing went with it, and
 * the autosave wrote the truncated document to the file.
 *
 * The window is the debounce, not a race: the clock is faked BEFORE the
 * keystroke, so the pending publish can never fire on its own and nothing below
 * advances it past 0 ms. Only the flush under test can publish the typing — and
 * the test asserts that intermediate state (model has it, tab does not) rather
 * than assigning `tab.content`, which would pass against the defect.
 *
 * The pane is the app's own: `createEditorPersistence` wired the way
 * `use-rendered-editor-stack.ts` wires it on mount, with `setRenderedFlush`, and
 * `createEditorExternalSync` behind the pane's content watcher.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, watch, type EffectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { setRenderedFlush } from '../../../services/editor-ownership'
import { setSourceViewHandle } from '../../../services/source-view'
import { documentKey } from '../../editor/model/document-session'
import { useTabsStore, type OpenTab } from '../../../stores/tabs'
import { useFrontmatterPanel, type FrontmatterPanelModel } from './use-frontmatter-panel'

const DOC = '---\ntitle: A\ntags:\n  - math\n  - 随笔\n---\n\n# Body'
const VAULT = '/vault'
const PATH = '/vault/a.md'

/** Every document the save path put on disk, in order. */
const written = vi.hoisted((): string[] => [])
const readMock = vi.hoisted(() => vi.fn(async (): Promise<string> => DOC))
const writeMock = vi.hoisted(() =>
  vi.fn(async (_vault: string, _path: string, content: string): Promise<string | null> => {
    written.push(content)
    return null
  }),
)

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: writeMock,
    list: vi.fn(async () => []),
    stat: vi.fn(async (): Promise<{ size: number; mtime: number }> => ({ size: 0, mtime: 0 })),
    watch: vi.fn(async () => undefined),
    deleteFile: vi.fn(async (): Promise<string> => ''),
    listHistory: vi.fn(async () => []),
    readHistory: vi.fn(async (): Promise<string> => ''),
    restoreHistory: vi.fn(async (): Promise<string> => ''),
    createDir: vi.fn(async (): Promise<string> => ''),
    renameEntry: vi.fn(async (): Promise<string> => ''),
    saveFileDialog: vi.fn(async (): Promise<string | null> => null),
  },
}))

let scopes: EffectScope[] = []

/** The rendered pane's model, as far as persistence and the external sync can
 *  see it: a document, a change listener, an opener and a serializer. `type()`
 *  is one keystroke — it changes the document and fires the change handlers
 *  synchronously, which is what a doc-changing ProseMirror transaction does. */
function fakeEditor(initial: string) {
  const handlers = new Set<() => void>()
  let doc = initial
  return {
    get doc(): string {
      return doc
    },
    type(text: string): void {
      doc += text
      handlers.forEach((h) => h())
    },
    async save(): Promise<string> {
      return doc
    },
    async open(content: string): Promise<void> {
      doc = content
    },
    getView(): null {
      return null
    },
    onContentChange(cb: () => void): () => void {
      handlers.add(cb)
      return () => {
        handlers.delete(cb)
      }
    },
  }
}

/** The pane's persistence layer and its external sync, over `editor`. */
async function attachRenderedPane(
  tabs: ReturnType<typeof useTabsStore>,
  tab: OpenTab,
  editor: ReturnType<typeof fakeEditor>,
): Promise<void> {
  const { createEditorPersistence } = await import('../../editor/controller/editor-persistence')
  const { createEditorExternalSync } = await import('../../editor/controller/editor-external-sync')
  const session = {
    editor: editor as never,
    gen: 0,
    appliedContent: DOC,
    appliedKey: documentKey(VAULT, tab.id),
    lastLocalMarkdown: DOC,
    lastDoc: DOC,
    docChangeTimer: null,
    applyingExternal: false,
    pendingExternal: null,
    parseFailed: false,
    calloutViewSet: true,
  }
  const persistence = createEditorPersistence({ session })
  persistence.attachChangeListener()
  setRenderedFlush(() => persistence.flush())
  const externalSync = createEditorExternalSync({
    session,
    getEditor: () => session.editor,
    scheduleOverlayRefresh: () => {},
  })
  const scope = effectScope()
  scope.run(() => {
    watch(
      () => [tabs.activeId, tabs.activeTab?.content] as const,
      ([, content]) => externalSync.onContentChanged(content),
    )
  })
  scopes.push(scope)
}

/** The panel, over a note the rendered pane is holding unpublished keystrokes
 *  for. The composable's watchers need a scope, so it is given one. */
async function noteWithPanel(): Promise<{
  tabs: ReturnType<typeof useTabsStore>
  tab: OpenTab
  editor: ReturnType<typeof fakeEditor>
  panel: FrontmatterPanelModel
}> {
  const tabs = useTabsStore()
  tabs.setVault(VAULT)
  await tabs.openTab(PATH)
  const tab = tabs.tabs[0]
  const editor = fakeEditor(tab.content)
  await attachRenderedPane(tabs, tab, editor)
  const scope = effectScope()
  const panel = scope.run(() => useFrontmatterPanel())!
  scopes.push(scope)
  return { tabs, tab, editor, panel }
}

/** Let every await already queued run — and no timer, because 0 ms is never
 *  past the 120 ms publish the test is holding open. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
}

describe('the properties panel and the rendered pane’s unpublished keystrokes', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    readMock.mockClear()
    writeMock.mockClear()
    written.length = 0
    scopes = []
    setSourceViewHandle(null)
    setRenderedFlush(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    scopes.forEach((scope) => scope.stop())
    scopes = []
    setRenderedFlush(null)
    setSourceViewHandle(null)
  })

  it('removes the tag from the text the user typed, and the save keeps it', async () => {
    const { tabs, tab, editor, panel } = await noteWithPanel()
    expect(panel.form.value.tags).toEqual(['math', '随笔'])

    vi.useFakeTimers()
    editor.type(' NEW SENTENCE')
    // The app's real intermediate state, asserted rather than assumed.
    expect(editor.doc).toBe(`${DOC} NEW SENTENCE`)
    expect(tab.content).toBe(DOC)

    await panel.removeTag('math')
    await nextTick()
    await settle()

    // Pre-fix this is the pre-keystroke text with the tag gone: the sentence was
    // never in it, and the model has since been rebuilt from that text.
    expect(tab.content).toContain('NEW SENTENCE')
    expect(tab.content).not.toContain('math')
    expect(editor.doc).toContain('NEW SENTENCE')
    expect(tab.dirty).toBe(true)

    await tabs.saveTab(tab.id)
    expect(written).toHaveLength(1)
    expect(written[0]).toContain('NEW SENTENCE')
    expect(written[0]).not.toContain('math')
  })

  it('keeps the typing when a title edit is committed', async () => {
    const { tab, editor, panel } = await noteWithPanel()

    vi.useFakeTimers()
    editor.type(' NEW SENTENCE')
    panel.form.value.title = 'Renamed'

    await panel.commit()
    await nextTick()
    await settle()

    expect(tab.content).toContain('title: Renamed')
    expect(tab.content).not.toContain('title: A')
    expect(tab.content).toContain('NEW SENTENCE')
  })
})
