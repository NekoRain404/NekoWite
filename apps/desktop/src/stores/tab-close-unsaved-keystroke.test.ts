/**
 * A close must not discard text typed while the save it began was writing.
 *
 * `saveTab` answering `true` means "a write landed", NOT "the tab is saved":
 * a keystroke during the write marks the tab dirty at the keystroke (see
 * `tab-save.ts`'s `editRevisions`) while `tab.content` still holds the text the
 * write captured, so the write's own answer leaves `dirty` set. `closeTab` used
 * to read that answer as final and remove the tab — the only copy of the newer
 * text — and `closeAll` did the same for every tab through `flushDirty`.
 *
 * The keystroke is delivered through the rendered pane's real persistence layer
 * (`tab-save-unsaved-keystroke.test.ts`'s harness), so `markDirty` runs at the
 * keystroke and the publish through the real 120 ms debounce.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setSourceViewHandle } from '../services/source-view'
import { setRenderedFlush } from '../services/editor-ownership'
import { documentKey } from '../features/editor/model/document-session'
import { useTabsStore } from './tabs'

const readMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())
vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: writeMock,
    list: vi.fn(async () => []),
    watch: vi.fn(async () => () => {}),
    deleteFile: vi.fn(async () => ''),
    stat: vi.fn(async () => ({ size: 0, mtime: 0 })),
    listHistory: vi.fn(async () => []),
    readHistory: vi.fn(async () => ''),
    restoreHistory: vi.fn(async () => ''),
    createDir: vi.fn(async () => ''),
    renameEntry: vi.fn(async () => ''),
    saveFileDialog: vi.fn(async () => null),
  },
}))

/** The editor, as far as the persistence layer is concerned (see the sibling
 *  harness): one `type()` is one keystroke — it changes the document and fires
 *  the change handlers synchronously. */
function fakeEditor(initial: string) {
  const handlers = new Set<() => void>()
  let doc = initial
  return {
    get doc() {
      return doc
    },
    type(text: string) {
      doc += text
      handlers.forEach((h) => h())
    },
    async save() {
      return doc
    },
    onContentChange(cb: () => void) {
      handlers.add(cb)
      return () => handlers.delete(cb)
    },
  }
}

/** The writes the save path asked for, in order, with the ability to hold one
 *  open — the interleaving is controllable rather than timed. */
function parkedWrite() {
  const written: string[] = []
  let parked: Array<(fail: boolean) => void> = []
  writeMock.mockImplementation((_v: string, _p: string, content: string) => {
    written.push(content)
    return new Promise<string | null>((resolve, reject) =>
      parked.push((fail) => (fail ? reject(new Error('disk full')) : resolve(null))),
    )
  })
  return {
    written,
    get started() {
      return written.length > 0
    },
    /** Let the write in flight finish — successfully, or as a failure. */
    release: (fail = false) => {
      const waiting = parked
      parked = []
      waiting.forEach((go) => go(fail))
    },
    /** Every later write lands on its own — for the follow-up save, whose
     *  interleaving is not what a test here is controlling. */
    landFromNowOn: () => {
      writeMock.mockImplementation((_v: string, _p: string, content: string) => {
        written.push(content)
        return Promise.resolve(null)
      })
    },
    /** Every later write fails (the follow-up save's failure case). */
    failFromNowOn: () => {
      writeMock.mockImplementation((_v: string, _p: string, content: string) => {
        written.push(content)
        return Promise.reject(new Error('disk full'))
      })
    },
  }
}

/** The rendered pane's persistence layer for `editor`, publishing into the open
 *  tab through the real 120 ms debounce — and registered as the pane's flush
 *  hook, which is what a save reaches for before it writes. */
async function attachPane(
  editor: ReturnType<typeof fakeEditor>,
  content: string,
  vault: string,
  tabId: string,
) {
  const { createEditorPersistence } = await import(
    '../features/editor/controller/editor-persistence'
  )
  const persistence = createEditorPersistence({
    session: {
      editor: editor as never,
      gen: 0,
      appliedContent: content,
      appliedKey: documentKey(vault, tabId),
      lastLocalMarkdown: content,
      lastDoc: content,
      docChangeTimer: null,
      applyingExternal: false,
      pendingExternal: null,
      parseFailed: false,
      calloutViewSet: true,
    },
  })
  persistence.attachChangeListener()
  setRenderedFlush(() => persistence.flush())
  return persistence
}

describe('a close whose own save is overtaken by a keystroke', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    readMock.mockReset()
    writeMock.mockReset()
    readMock.mockResolvedValue('v1')
    setSourceViewHandle(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    setRenderedFlush(null)
  })

  it('closeTab keeps the newer text: the write that lands carries it', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/a.md')
    const tab = tabs.tabs[0]
    const editor = fakeEditor('v1')
    await attachPane(editor, 'v1', '/vault', tab.id)

    const write = parkedWrite()
    tabs.markDirty(tab.id)
    vi.useFakeTimers()
    const closing = tabs.closeTab(tab.id)
    await vi.waitFor(() => expect(write.started).toBe(true))

    // The user types while the close's own write is in flight. The doc change
    // fires synchronously (as ProseMirror's does); the publish is 120 ms behind.
    editor.type(' NEW TEXT')
    expect(editor.doc).toBe('v1 NEW TEXT')
    expect(tab.dirty).toBe(true)
    expect(tab.content).toBe('v1')

    vi.advanceTimersByTime(50)
    write.release()
    write.landFromNowOn()
    await closing

    // The claim: the typing went to disk instead of going away with the tab.
    expect(write.written).toEqual(['v1', 'v1 NEW TEXT'])
    expect(tabs.tabs).toHaveLength(0)
    expect(tabs.hasUnsavedWork()).toBe(false)
  })

  it('closeTab keeps the tab when the follow-up write fails too', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/a.md')
    const tab = tabs.tabs[0]
    const editor = fakeEditor('v1')
    await attachPane(editor, 'v1', '/vault', tab.id)

    const write = parkedWrite()
    tabs.markDirty(tab.id)
    vi.useFakeTimers()
    const closing = tabs.closeTab(tab.id)
    await vi.waitFor(() => expect(write.started).toBe(true))

    editor.type(' NEW TEXT')
    vi.advanceTimersByTime(50)
    write.release(true)
    await closing

    // Nothing was written, so nothing may be closed: the text is still in the
    // tab, where the user can try again.
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.tabs[0].dirty).toBe(true)
  })

  it('a second close in flight does not drop it either', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/a.md')
    const tab = tabs.tabs[0]
    const editor = fakeEditor('v1')
    await attachPane(editor, 'v1', '/vault', tab.id)

    const write = parkedWrite()
    tabs.markDirty(tab.id)
    vi.useFakeTimers()
    const first = tabs.closeTab(tab.id)
    const second = tabs.closeTab(tab.id)
    await vi.waitFor(() => expect(write.started).toBe(true))

    editor.type(' NEW TEXT')
    vi.advanceTimersByTime(50)
    write.release()
    write.landFromNowOn()
    await Promise.all([first, second])

    expect(tabs.tabs).toHaveLength(0)
    expect(write.written).toContain('v1 NEW TEXT')
  })

  it('closeAll writes what the flush did not carry', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/a.md')
    const tab = tabs.tabs[0]
    const editor = fakeEditor('v1')
    await attachPane(editor, 'v1', '/vault', tab.id)

    const write = parkedWrite()
    tabs.markDirty(tab.id)
    vi.useFakeTimers()
    const closing = tabs.closeAll()
    await vi.waitFor(() => expect(write.started).toBe(true))

    editor.type(' NEW TEXT')
    vi.advanceTimersByTime(50)
    write.release()
    write.landFromNowOn()
    await expect(closing).resolves.toBe(true)

    expect(write.written).toEqual(['v1', 'v1 NEW TEXT'])
    expect(tabs.tabs).toHaveLength(0)
  })
})
