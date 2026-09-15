/**
 * The × on a tag row: it has to publish the pane the user is typing in before
 * it transforms the document.
 *
 * `removeCurrentTag` is a whole-document read-modify-write, so it may only run
 * against text the panes have finished publishing. The rendered pane publishes
 * through a 120 ms trailing debounce (`editor-persistence.ts`) and in the
 * default rendered view it is the only pane mounted, so a click landing inside
 * that window transformed the pre-keystroke text, wrote the result back, and
 * the autosave that followed put the truncated document on disk.
 *
 * The window is the debounce here, not a race against it: the clock is faked
 * BEFORE the keystroke, so the pending publish can never fire on its own, and
 * nothing below advances it past 0 ms. The only thing that can publish the
 * typing is the flush under test — which is also why the test asserts the
 * intermediate state (the model has the text, the tab does not) rather than
 * assigning `tab.content` and hoping.
 *
 * The pane is real, not stubbed: `createEditorPersistence` is wired the way
 * `use-rendered-editor-stack.ts` wires it on mount (including
 * `setRenderedFlush`), and `createEditorExternalSync` is the app's own
 * reconciliation behind the pane's content watcher — so the model rebuild that
 * turns a stale write-back into lost text is exercised, not assumed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, watch, type EffectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { setRenderedFlush } from '../../../services/editor-ownership'
import { setSourceViewHandle } from '../../../services/source-view'
import { documentKey } from '../../editor/model/document-session'
import { useTabsStore, type OpenTab } from '../../../stores/tabs'
import { useSidebarTags } from './use-sidebar-tags'

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

/** The watcher scope the pane's content listener runs in, disposed per test. */
let scopes: EffectScope[] = []

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

/** The pane's persistence layer and its external sync, over `editor` — the two
 *  controllers a mounted rendered pane runs its document through. */
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
  // The pane's own content watcher (`use-rendered-editor-stack.ts`): an
  // external write to the tab is reconciled into the model, which is how a
  // stale write-back becomes lost text rather than a mere stale field.
  const scope = effectScope()
  scope.run(() => {
    watch(
      () => [tabs.activeId, tabs.activeTab?.content] as const,
      ([, content]) => externalSync.onContentChanged(content),
    )
  })
  scopes.push(scope)
}

async function openNote(): Promise<{
  tabs: ReturnType<typeof useTabsStore>
  tab: OpenTab
  editor: ReturnType<typeof fakeEditor>
}> {
  const tabs = useTabsStore()
  tabs.setVault(VAULT)
  await tabs.openTab(PATH)
  const tab = tabs.tabs[0]
  const editor = fakeEditor(tab.content)
  await attachRenderedPane(tabs, tab, editor)
  return { tabs, tab, editor }
}

/** Let every await already queued run — and no timer, because 0 ms is never
 *  past the 120 ms publish the test is holding open. Repeating it drains the
 *  chains the sync builds (open → save → the pending-content arm). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
}

const click = (): MouseEvent => new MouseEvent('click')

describe('the tag row × and the rendered pane’s unpublished keystrokes', () => {
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
    const { tabs, tab, editor } = await openNote()

    vi.useFakeTimers()
    editor.type(' NEW SENTENCE')
    // The app's real intermediate state, asserted rather than assumed: the
    // model has the sentence, the tab does not, and the publish is pending.
    expect(editor.doc).toBe(`${DOC} NEW SENTENCE`)
    expect(tab.content).toBe(DOC)

    const tags = useSidebarTags()
    await tags.removeCurrentTag('math', click())
    // The content watcher and the model rebuild are microtasks behind the click.
    await nextTick()
    await settle()

    // Pre-fix this is the pre-keystroke text with the tag gone: the sentence was
    // never in it, and `applyContent` had already rebuilt the model from it.
    expect(tab.content).toContain('NEW SENTENCE')
    expect(tab.content).not.toContain('math')
    expect(editor.doc).toContain('NEW SENTENCE')
    expect(tab.dirty).toBe(true)

    // What the file receives is the autosave's write, so run the real save.
    await tabs.saveTab(tab.id)
    expect(written).toHaveLength(1)
    expect(written[0]).toContain('NEW SENTENCE')
    expect(written[0]).not.toContain('math')
  })

  it('still removes the tag when the keystrokes are in the source pane', async () => {
    // The case the old call was written for, and the reason the defect went
    // unnoticed: in source mode `flushSourceEdits()` is complete, because the
    // CodeMirror pane IS the pane the user is typing in.
    const { tabs, tab } = await openNote()
    const source = { text: `${DOC} SOURCE SENTENCE` }
    setSourceViewHandle({
      getView: () => null,
      flush: () => {
        tab.content = source.text
      },
    })

    const tags = useSidebarTags()
    await tags.removeCurrentTag('math', click())

    expect(tab.content).toContain('SOURCE SENTENCE')
    expect(tab.content).not.toContain('math')
    expect(tab.dirty).toBe(true)
    expect(tabs.activeTab?.content).toBe(tab.content)
  })

  it('leaves the document alone when the tag is not in it', async () => {
    const { tab } = await openNote()
    vi.useFakeTimers()
    const before = tab.content

    const tags = useSidebarTags()
    await tags.removeCurrentTag('absent', click())
    await nextTick()
    await settle()

    expect(tab.content).toBe(before)
    expect(tab.dirty).toBe(false)
  })
})
