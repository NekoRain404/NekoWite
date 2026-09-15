/**
 * Closing a tab whose first read has not landed.
 *
 * The placeholder holds an EMPTY document wearing the note's path, so it has no
 * text of its own to save. `closeTab` nevertheless routed every dirty tab
 * through `saveUntilSettled`, and the write path refuses while `loading`
 * (`tab-write-preconditions.ts`: "the read that is still running settles it, and
 * a keystroke in the meantime is `commitRead`'s to rescue"). That refusal is
 * right about WRITING and wrong about CLOSING: on a tab that is both loading and
 * dirty the X did nothing and said nothing, and a read that never lands left the
 * tab with no way to close it at all.
 *
 * What a close has to do instead is what the read commit does with the same
 * state: the typing is not the note's and cannot be sent to it, so it moves to a
 * tab of its own (`rescuePlaceholderTyping`) — and the note, which the user did
 * ask to close, closes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { onNotify } from '../services/errors'
import { setRenderedFlush } from '../services/editor-ownership'
import { setSourceViewHandle } from '../services/source-view'
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
    saveFileDialog: vi.fn(async (): Promise<string | null> => null),
  },
}))

/** A first read the test decides when to answer. Later reads — the save path
 *  compares the disk against the tab before it writes — answer at once with the
 *  same text, so a close that does reach the save gate does not park on them. */
function parkedRead(disk: string) {
  let settle: ((content: string) => void) | null = null
  let first = true
  readMock.mockImplementation(() => {
    if (!first) return Promise.resolve(disk)
    first = false
    return new Promise<string>((resolve) => {
      settle = resolve
    })
  })
  return {
    /** The file's text arrives: the read lands. */
    land: () => settle?.(disk),
  }
}

/** A keystroke as the panes deliver it: the text goes into the tab and the edit
 *  is recorded at the keystroke. */
function typeInto(tab: { id: string; content: string }, text: string): void {
  const tabs = useTabsStore()
  tab.content = text
  tabs.markDirty(tab.id)
}

describe('closing a tab whose first read has not landed', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    readMock.mockReset()
    writeMock.mockReset()
    writeMock.mockResolvedValue(null)
    setSourceViewHandle(null)
  })

  it('closes it, and keeps the typing in a tab of its own', async () => {
    const read = parkedRead('DISK BEFORE')
    const seen: string[] = []
    const off = onNotify((m) => seen.push(m))
    const tabs = useTabsStore()
    tabs.setVault('/vault')

    const opening = tabs.openTab('/vault/a.md')
    const placeholder = tabs.tabs[0]
    typeInto(placeholder, 'USER TYPED')

    await tabs.closeTab(placeholder.id)

    // The note the user asked to close is gone...
    expect(tabs.tabs.some((t) => t.id === placeholder.id)).toBe(false)
    expect(tabs.tabs.some((t) => t.path === '/vault/a.md')).toBe(false)
    // ...and the text they typed is not: it is a document of its own, the state
    // it is actually in (it belongs to no file).
    const rescued = tabs.tabs.find((t) => t.path === null)
    expect(rescued?.content).toBe('USER TYPED')
    expect(rescued?.dirty).toBe(true)
    // The placeholder's borrowed text never went to the note's file.
    expect(writeMock).not.toHaveBeenCalled()
    // Not silent: a tab appearing beside theirs is not something to discover
    // later.
    expect(seen.length).toBeGreaterThan(0)
    off()

    // The read lands afterwards and finds no tab to commit into — the close it
    // missed must not be undone by it.
    read.land()
    await opening
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.tabs[0].content).toBe('USER TYPED')
  })

  it('closes it even when the read never answers', async () => {
    // A read that never resolves, which is what made this unbounded: the save
    // gate answered "not saved" for as long as it stayed pending, so the tab
    // could never be closed at all.
    parkedRead('DISK BEFORE')
    const seen: string[] = []
    const off = onNotify((m) => seen.push(m))
    const tabs = useTabsStore()
    tabs.setVault('/vault')

    const opening = tabs.openTab('/vault/a.md')
    const placeholder = tabs.tabs[0]
    typeInto(placeholder, 'USER TYPED')

    await tabs.closeTab(placeholder.id)

    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.tabs[0].path).toBeNull()
    expect(tabs.tabs[0].content).toBe('USER TYPED')
    expect(seen.length).toBeGreaterThan(0)
    off()
    // The open is still pending; nothing about it may be awaited by the close.
    void opening
  })

  it('is an ordinary close when the read lands first', async () => {
    const read = parkedRead('DISK BEFORE')
    const tabs = useTabsStore()
    tabs.setVault('/vault')

    const opening = tabs.openTab('/vault/a.md')
    const placeholder = tabs.tabs[0]
    typeInto(placeholder, 'USER TYPED')
    read.land()
    await opening

    // The commit already did the rescue, so the note is a note again.
    const note = tabs.tabs.find((t) => t.path === '/vault/a.md')
    expect(note?.loading).toBe(false)

    await tabs.closeTab(note!.id)

    expect(tabs.tabs.some((t) => t.path === '/vault/a.md')).toBe(false)
    const rescued = tabs.tabs.find((t) => t.path === null)
    expect(rescued?.content).toBe('USER TYPED')
    expect(rescued?.dirty).toBe(true)
  })

  it('closes a loading tab with nothing typed into it, and says nothing', async () => {
    const read = parkedRead('DISK BEFORE')
    const seen: string[] = []
    const off = onNotify((m) => seen.push(m))
    const tabs = useTabsStore()
    tabs.setVault('/vault')

    const opening = tabs.openTab('/vault/a.md')
    const placeholder = tabs.tabs[0]
    expect(placeholder.loading).toBe(true)

    await tabs.closeTab(placeholder.id)

    // Nothing of the user's was in it, so there is nothing to rescue and nothing
    // to say — this is the regression to watch: the close is what it always was.
    expect(tabs.tabs).toHaveLength(0)
    expect(tabs.activeId).toBeNull()
    expect(seen).toHaveLength(0)
    off()

    read.land()
    await opening
    expect(tabs.tabs).toHaveLength(0)
  })
})

/** The editor, as far as the persistence layer is concerned (the harness
 *  `tab-open-late-read.test.ts` and the save-race tests share): one `type()` is
 *  one keystroke — it changes the document and fires the change handlers
 *  synchronously, as ProseMirror's markdownUpdated does. */
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

/** The rendered pane's real persistence layer over `editor`, publishing into the
 *  open tab through the 120 ms debounce — and registered as the pane's flush
 *  hook, which is what a close reaches for to publish the keystroke NOW. */
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

describe('a close must publish the pane before it reads the tab', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    readMock.mockReset()
    writeMock.mockReset()
    writeMock.mockResolvedValue(null)
    setSourceViewHandle(null)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    setRenderedFlush(null)
  })

  it('rescues the typing the rendered pane has not published yet', async () => {
    // The read stays parked: the close must not wait on it.
    parkedRead('DISK BEFORE')
    const seen: string[] = []
    const off = onNotify((m) => seen.push(m))
    const tabs = useTabsStore()
    tabs.setVault('/vault')

    const opening = tabs.openTab('/vault/a.md')
    const placeholder = tabs.tabs[0]
    const editor = fakeEditor('')
    await attachPane(editor, '', '/vault', placeholder.id)

    editor.type('USER TYPED')
    // In the model and in `dirty` — and NOT yet in the tab, which the close's
    // rescue reads once. Without the flush it copies the empty field into the
    // new tab and tells the user their text is in it.
    expect(placeholder.dirty).toBe(true)
    expect(placeholder.content).toBe('')

    await tabs.closeTab(placeholder.id)
    off()

    const rescued = tabs.tabs.find((t) => t.path === null)
    expect(rescued?.content).toBe('USER TYPED')
    expect(rescued?.dirty).toBe(true)
    expect(seen.length).toBeGreaterThan(0)

    void opening
  })
})
