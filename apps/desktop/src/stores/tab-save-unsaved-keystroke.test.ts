/**
 * A save must not call a tab saved while the user has typed since it began.
 *
 * The two modules that make this hard to see are both real here: the store's
 * save transaction (`tab-save.ts`) and the rendered pane's persistence layer
 * (`editor-persistence.ts`, whose `markdownSync` publishes `tab.content` through
 * a 120 ms debounce). A keystroke marks the tab dirty IMMEDIATELY — the
 * ProseMirror transaction fires `onContentChange` synchronously
 * (`packages/editor-core/src/editor.ts`) — but `tab.content` still holds the
 * previous text for the whole debounce window. A save that decided "did the user
 * type?" by comparing `tab.content` therefore cleared `dirty` over keystrokes
 * that were in neither the tab nor the file, and `dirty` is the only record that
 * such text exists.
 *
 * The keystroke is delivered by driving `createEditorPersistence`'s own change
 * handler, so the dirty flag moves through the store's real `markDirty` and the
 * publish moves through the real debounce, rather than being asserted by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setSourceViewHandle } from '../services/source-view'
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

/** The editor, as far as the persistence layer is concerned: a document, a
 *  change listener, and a serializer. `type()` is one keystroke — it changes the
 *  document and fires the change handlers synchronously, which is what a
 *  doc-changing ProseMirror transaction does. */
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

/** The writes the save path asked for, in order, and the ability to hold one
 *  open — which is what makes the interleaving controllable rather than timed. */
function parkedWrite() {
  const written: string[] = []
  let parked: Array<() => void> = []
  let autoLand = false
  writeMock.mockImplementation((_v: string, _p: string, content: string) => {
    written.push(content)
    if (autoLand) return Promise.resolve(null)
    return new Promise<string | null>((resolve) => parked.push(() => resolve(null)))
  })
  return {
    written,
    get started() {
      return written.length > 0
    },
    release: () => {
      const waiting = parked
      parked = []
      waiting.forEach((go) => go())
    },
    /** Every later write lands on its own — for the follow-up save, whose
     *  interleaving is not what a test here is controlling. */
    landFromNowOn: () => {
      autoLand = true
    },
  }
}

/** The rendered pane's persistence layer, wired to `editor` and a session that
 *  already holds the note. */
async function attachPane(editor: ReturnType<typeof fakeEditor>, content: string) {
  const { createEditorPersistence } = await import(
    '../features/editor/controller/editor-persistence'
  )
  const persistence = createEditorPersistence({
    session: {
      editor: editor as never,
      gen: 0,
      appliedContent: content,
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
  return persistence
}

describe('a save that races the editor publish debounce', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    readMock.mockReset()
    writeMock.mockReset()
    readMock.mockResolvedValue('hello')
    setSourceViewHandle(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the tab dirty, and the autosave that follows still writes the newer text', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/a.md')
    const tab = tabs.tabs[0]
    expect(tab.content).toBe('hello')

    const editor = fakeEditor('hello')
    await attachPane(editor, 'hello')

    const write = parkedWrite()
    // The tab is dirty from an earlier keystroke that HAS been published, which
    // is why the save writes 'hello'.
    tabs.markDirty(tab.id)
    vi.useFakeTimers()
    tabs.scheduleAutosave(tab.id)
    const saving = tabs.saveTab(tab.id)
    await vi.waitFor(() => expect(write.started).toBe(true))

    // One keystroke, while the write is in flight.
    editor.type('!')
    expect(editor.doc).toBe('hello!') // what the user sees
    expect(tab.dirty).toBe(true) // ...and the edit is recorded at once
    expect(tab.content).toBe('hello') // but not yet published

    // The write resolves inside the 120 ms debounce window.
    vi.advanceTimersByTime(50)
    write.release()
    await saving

    expect(write.written).toEqual(['hello']) // that IS what reached the disk
    expect(tab.savedContent).toBe('hello')
    // The claim this test exists for: the tab holds text that is not on disk,
    // so it may not be called saved.
    expect(tab.dirty).toBe(true)
    expect(tabs.hasUnsavedWork()).toBe(true)

    // The debounce publishes the keystroke, and the autosave the keystroke armed
    // is what puts it on disk. Run the real timer out (default interval 15 s,
    // ceiling 30 s) rather than calling saveTab by hand.
    write.landFromNowOn()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(tab.content).toBe('hello!')
    expect(write.written).toEqual(['hello', 'hello!'])
    expect(tab.dirty).toBe(false)
  })

  it('still calls a tab saved when nothing was typed during the write', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/a.md')
    const tab = tabs.tabs[0]
    const editor = fakeEditor('hello')
    await attachPane(editor, 'hello')

    const write = parkedWrite()
    tabs.markDirty(tab.id)
    vi.useFakeTimers()
    const saving = tabs.saveTab(tab.id)
    await vi.waitFor(() => expect(write.started).toBe(true))

    // No keystroke: the write carries everything the tab holds.
    vi.advanceTimersByTime(500)
    write.release()
    await saving

    expect(write.written).toEqual(['hello'])
    expect(tab.dirty).toBe(false)
    expect(tabs.hasUnsavedWork()).toBe(false)
  })

  /**
   * The four consumers of `dirty`, driven one by one.
   *
   * The flag is not the point — what the app does with it is. Each of these
   * skipped the raced keystroke when the flag was cleared over it, and each is
   * a separate way for the text to reach the disk (or not).
   */
  describe('the consumers of the flag', () => {
    /** Run the race and hand back the store and the parked write, with the
     *  keystroke published and nothing written yet. */
    async function racedSave() {
      const tabs = useTabsStore()
      tabs.setVault('/vault')
      await tabs.openTab('/vault/a.md')
      const tab = tabs.tabs[0]
      const editor = fakeEditor('hello')
      await attachPane(editor, 'hello')

      const write = parkedWrite()
      tabs.markDirty(tab.id)
      vi.useFakeTimers()
      const saving = tabs.saveTab(tab.id)
      await vi.waitFor(() => expect(write.started).toBe(true))
      editor.type('!')
      vi.advanceTimersByTime(50)
      write.release()
      await saving
      // The publish lands; `tab.content` is now ahead of the disk.
      await vi.advanceTimersByTimeAsync(200)
      expect(tab.content).toBe('hello!')
      expect(tab.dirty).toBe(true)
      return { tabs, tab, write }
    }

    it('1. the autosave timer saves it', async () => {
      const { write } = await racedSave()
      write.landFromNowOn()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(write.written).toEqual(['hello', 'hello!'])
    })

    it('2. hasUnsavedWork reports it, so the window close is blocked', async () => {
      const { tabs } = await racedSave()
      expect(tabs.hasUnsavedWork()).toBe(true)
    })

    it('3. the bulk flush (vault switch, window close) writes it', async () => {
      const { tabs, write } = await racedSave()
      write.landFromNowOn()
      expect(await tabs.flushDirty()).toBe(true)
      expect(write.written).toEqual(['hello', 'hello!'])
      expect(tabs.hasUnsavedWork()).toBe(false)
    })

    it('4. closeTab writes it instead of dropping the tab', async () => {
      const { tabs, tab, write } = await racedSave()
      write.landFromNowOn()
      await tabs.closeTab(tab.id)
      expect(write.written).toEqual(['hello', 'hello!'])
      expect(tabs.tabs).toHaveLength(0)
    })
  })

  it('does not clear dirty when an external apply replaced the document mid-write', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/a.md')
    const tab = tabs.tabs[0]
    const editor = fakeEditor('hello')
    await attachPane(editor, 'hello')

    const write = parkedWrite()
    tabs.markDirty(tab.id)
    vi.useFakeTimers()
    const saving = tabs.saveTab(tab.id)
    await vi.waitFor(() => expect(write.started).toBe(true))

    // A watcher-driven re-apply lands: the tab no longer holds what the save
    // captured, and no keystroke was involved — so the revision cannot tell us
    // anything. The content comparison is what refuses to call this saved.
    tab.content = 'from disk'
    tab.dirty = true
    write.release()
    await saving

    expect(tab.savedContent).toBe('hello') // what is on disk, truthfully
    expect(tab.dirty).toBe(true)
  })
})
