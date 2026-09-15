/**
 * A tab whose first read has not landed blocks BOTH bulk closes.
 *
 * `e70de91` fixed the tab's own X: a placeholder is an EMPTY document wearing
 * the note's path, it has no text of its own to save, and the write path's
 * `loading` refusal is about WRITING — reading it as a refusal to CLOSE left the
 * X inert. Two routes reach the tab set from above `flushDirty()` and were left
 * standing, so both are blocked by the same refusal:
 *
 *   - `closeAll` asks `flushDirty()`, which returns false and closes nothing —
 *     under a sentence about a vault switch the user never asked for.
 *   - the window X asks `flushDirty()`, fails, prompts for a copy of the text,
 *     and its `saveTab(id, { offerCopy: true })` is refused for the same
 *     `loading` reason. The prompt cannot deliver: the window stays up, and
 *     pressing it again loops. A user cannot close the application.
 *
 * Both are unbounded, and every test here parks the first read (never resolving
 * it) for that reason.
 *
 * The fix has two halves, and the second is what makes it compose: the rescue
 * clears the flag it emptied the tab of (`rescuePlaceholderTyping`), and the
 * reconciliation that runs the rescue for every loading dirty tab is ONE
 * function called by both routes before their flush — so the untitled prompt
 * that follows covers the tab it just created.
 *
 * The store is the REAL one here; the fs gateway, the window, the notification
 * channels and the untitled prompt are mocked. `closeAll` is driven through the
 * store, the window close through the real `onCloseRequested`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setRenderedFlush } from '../services/editor-ownership'
import { setSourceViewHandle } from '../services/source-view'
import { documentKey } from '../features/editor/model/document-session'

const h = vi.hoisted(() => {
  const windowMock = { onCloseRequested: vi.fn(), close: vi.fn(), destroy: vi.fn() }
  const fs = {
    read: vi.fn(),
    write: vi.fn(),
    list: vi.fn(async () => []),
    watch: vi.fn(async () => () => {}),
    deleteFile: vi.fn(async () => ''),
    stat: vi.fn(async () => ({ size: 0, mtime: 0 })),
    listHistory: vi.fn(async () => []),
    readHistory: vi.fn(async () => ''),
    restoreHistory: vi.fn(async () => ''),
    createDir: vi.fn(async () => ''),
    renameEntry: vi.fn(async () => ''),
    // The return is stated rather than inferred: a bare `vi.fn(async () => null)`
    // types as Promise<null>, so the tests that answer with a path
    // (`mockResolvedValue('/vault/kept.md')`) are a type error — and vitest
    // strips types while eslint does not typecheck, so `vue-tsc` is the only
    // thing that sees it.
    saveFileDialog: vi.fn(async (): Promise<string | null> => null),
  }
  return {
    windowMock,
    fs,
    appearanceMock: { autosaveOnBlur: false, touchSystem: vi.fn() },
    windowTracking: { restore: vi.fn(), start: vi.fn(), flush: vi.fn(), dispose: vi.fn() },
    requestUntitledVaultSwitch: vi.fn(),
    notifyError: vi.fn(),
    notifyRecovery: vi.fn(),
  }
})

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => h.windowMock,
  CloseRequestedEvent: class {},
}))

vi.mock('../platform/gateways/fs', () => ({ fsService: h.fs }))

vi.mock('../stores/appearance', () => ({ useAppearanceStore: () => h.appearanceMock }))

vi.mock('./recovery-closed-loop', () => ({
  requestUntitledVaultSwitch: h.requestUntitledVaultSwitch,
}))

vi.mock('../services/errors', () => ({
  notifyError: h.notifyError,
  notifyRecovery: h.notifyRecovery,
}))

// The keys are what the user-facing sentence is; asserting on the key keeps the
// test about which sentence was chosen.
vi.mock('../i18n', () => ({ t: (key: string): string => key }))

import { createAppLifecycle } from './app-lifecycle'
import { useTabsStore } from '../stores/tabs'

const CLOSE_WHILE_LOADING = 'tabs.closeWhileLoading'
const UNTITLED_CLOSE_ALL = 'tabs.untitledCloseAllMsg'
const CLOSE_BLOCKED = 'tabs.unsavedWorkBlockerClose'

/** Every sentence either route put in front of the user, in order. */
let notices: string[] = []

/** Answers for the untitled keep-or-discard prompt. Set before the action. */
let untitledAnswer: 'save' | 'discard' = 'discard'

/** The tab set as it stood when the untitled prompt was raised — this is where
 *  the ORDER the fix depends on is read: the reconciliation has to have created
 *  the untitled tab before the prompt asks the user about it. */
let atUntitledPrompt: string[] = []

const snapshot = (): string[] =>
  useTabsStore().tabs.map((tab) => `${tab.path ?? 'untitled'}|${tab.dirty}|${tab.content}`)

function collectNotices(): void {
  notices = []
  atUntitledPrompt = []
  h.notifyError.mockImplementation((m: string) => {
    notices.push(m)
  })
  h.notifyRecovery.mockImplementation((p: { message: string; onRestore: () => void; onDismiss: () => void }) => {
    notices.push(p.message)
    if (p.message === UNTITLED_CLOSE_ALL) {
      atUntitledPrompt = snapshot()
      if (untitledAnswer === 'save') p.onRestore()
      else p.onDismiss()
      return
    }
    // Every other prompt (the copy offer, crash recovery) is declined: a test
    // that is not about it never has to answer it.
    p.onDismiss()
  })
}

/** A first read the test decides when — or whether — to answer. Later reads
 *  (the save path compares the disk against the tab before it writes) answer at
 *  once, so a close that does reach the save gate does not park on them. */
function parkedRead(disk: string) {
  let settle: ((content: string) => void) | null = null
  let first = true
  h.fs.read.mockImplementation(() => {
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

/** A keystroke as the panes deliver it once published: the text is in the tab
 *  and the edit is recorded. */
function typeInto(tab: { id: string; content: string }, text: string): void {
  const tabs = useTabsStore()
  tab.content = text
  tabs.markDirty(tab.id)
}

/** The note the placeholder is wearing, never written to by any route here. */
const NOTE_PATH = '/vault/a.md'

function writesTo(path: string): unknown[] {
  return h.fs.write.mock.calls.filter((c) => c[1] === path)
}

type CloseHandler = (e: { preventDefault: () => void }) => Promise<void>

function registeredCloseHandler(): CloseHandler {
  const calls = h.windowMock.onCloseRequested.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0] as CloseHandler
}

/** Walk the window's own close route, as the user does by pressing the X. */
async function pressTheWindowX(): Promise<{ preventDefault: ReturnType<typeof vi.fn> }> {
  const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
  await lifecycle.mount()
  const preventDefault = vi.fn()
  await registeredCloseHandler()({ preventDefault })
  return { preventDefault }
}

describe('a bulk close with a tab whose first read has not landed', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    h.windowMock.onCloseRequested.mockResolvedValue(() => {})
    h.windowMock.close.mockResolvedValue(undefined)
    h.windowMock.destroy.mockResolvedValue(undefined)
    h.fs.write.mockResolvedValue(null)
    h.fs.saveFileDialog.mockResolvedValue(null)
    h.requestUntitledVaultSwitch.mockResolvedValue('discard')
    untitledAnswer = 'discard'
    collectNotices()
    setSourceViewHandle(null)
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    setRenderedFlush(null)
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('closeAll closes the set, moving the typing into a tab the prompt then covers', async () => {
    // The read never lands: this is the unbounded form.
    parkedRead('DISK BEFORE')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const opening = tabs.openTab(NOTE_PATH)
    typeInto(tabs.tabs[0], 'USER TYPED')

    expect(await tabs.closeAll()).toBe(true)

    expect(tabs.tabs).toHaveLength(0)
    // The user's text was in an untitled tab BEFORE the prompt asked about it —
    // the order that makes a "Close all" they answer discard an informed one.
    expect(atUntitledPrompt).toContain('untitled|true|USER TYPED')
    expect(notices).toContain(CLOSE_WHILE_LOADING)
    // Not the vault-switch sentence, and not a refusal: a close needs no write.
    expect(notices).not.toContain('tabs.unsavedWorkBlocker')
    expect(h.fs.write).not.toHaveBeenCalled()
    void opening
  })

  it('the window X closes the application', async () => {
    // The read never lands. Before the fix this is a user who cannot close the
    // application at all: the prompt appears, they accept, the copy save is
    // refused for the same `loading` reason, and the window stays up — on this
    // press and on every one after it.
    parkedRead('DISK BEFORE')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const opening = tabs.openTab(NOTE_PATH)
    typeInto(tabs.tabs[0], 'USER TYPED')

    const { preventDefault } = await pressTheWindowX()

    expect(preventDefault).toHaveBeenCalled()
    expect(h.windowMock.close).toHaveBeenCalled()
    expect(notices).toContain(CLOSE_WHILE_LOADING)
    // Neither the refusal this route used to end on, nor the copy prompt it
    // used to raise for text that was never the note's to write.
    expect(notices).not.toContain(CLOSE_BLOCKED)
    expect(notices).not.toContain('tabs.unsavedWorkRescue')
    expect(h.fs.write).not.toHaveBeenCalled()
    void opening
  })

  it('the window X asks about the moved text in a prompt that covers it', async () => {
    parkedRead('DISK BEFORE')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const opening = tabs.openTab(NOTE_PATH)
    typeInto(tabs.tabs[0], 'USER TYPED')
    const atPromptChoice: string[] = []
    h.requestUntitledVaultSwitch.mockImplementation(async () => {
      atPromptChoice.push(...snapshot())
      return 'discard'
    })

    await pressTheWindowX()

    // The untitled tab exists before the keep-or-discard prompt runs, so the
    // user is answering about the text rather than losing it to the close.
    expect(atPromptChoice).toContain('untitled|true|USER TYPED')
    void opening
  })

  it('keeps the typing in ONE untitled tab when the save-as cannot land, and never writes the note', async () => {
    parkedRead('DISK BEFORE')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const opening = tabs.openTab(NOTE_PATH)
    typeInto(tabs.tabs[0], 'USER TYPED')
    // The user answers "save" and then cancels the file dialog: the close is
    // blocked, and their text has to be where they left it.
    untitledAnswer = 'save'

    expect(await tabs.closeAll()).toBe(false)

    const untitled = tabs.tabs.filter((t) => t.path === null)
    expect(untitled).toHaveLength(1)
    expect(untitled[0].content).toBe('USER TYPED')
    expect(untitled[0].dirty).toBe(true)
    // The placeholder's borrowed text must never reach the note's file.
    expect(writesTo(NOTE_PATH)).toHaveLength(0)
    expect(h.fs.write).not.toHaveBeenCalled()

    // The user tries the same thing again. The note's tab is not dirty any more
    // (the rescue took what it was holding), so this must not copy their words a
    // second time — one more attempt, one untitled tab.
    expect(await tabs.closeAll()).toBe(false)
    expect(tabs.tabs.filter((t) => t.path === null)).toHaveLength(1)
    void opening
  })

  it('saves the typing under the name the user picks, and never to the note', async () => {
    parkedRead('DISK BEFORE')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const opening = tabs.openTab(NOTE_PATH)
    typeInto(tabs.tabs[0], 'USER TYPED')
    untitledAnswer = 'save'
    h.fs.saveFileDialog.mockResolvedValue('/vault/kept.md')

    expect(await tabs.closeAll()).toBe(true)

    expect(tabs.tabs).toHaveLength(0)
    expect(writesTo(NOTE_PATH)).toHaveLength(0)
    expect(h.fs.write.mock.calls.map((c) => c[1])).toEqual(['/vault/kept.md'])
    expect(h.fs.write.mock.calls[0][2]).toBe('USER TYPED')
    void opening
  })

  it('rescues exactly once when the read lands while the close is reconciling', async () => {
    const read = parkedRead('DISK BEFORE')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const opening = tabs.openTab(NOTE_PATH)
    typeInto(tabs.tabs[0], 'USER TYPED')
    // The read answers while the close is in flight: the commit and the
    // reconciliation both own this tab's typing, and only one of them may move
    // it. A second rescue would be a second copy of the user's words under a
    // tab holding the note again.
    read.land()
    await opening

    expect(await tabs.closeAll()).toBe(true)

    expect(tabs.tabs).toHaveLength(0)
    // Exactly one tab was handed the words: two would be two copies of the same
    // text, one of them in a tab the user never asked for.
    expect(atUntitledPrompt.filter((state) => state.endsWith('|USER TYPED'))).toHaveLength(1)
    expect(h.fs.write).not.toHaveBeenCalled()
  })

  // The regression to watch: an ordinary note still goes through the gate.
  it('still blocks a close whose save is refused', async () => {
    const read = parkedRead('DISK BEFORE')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const opening = tabs.openTab(NOTE_PATH)
    read.land()
    await opening
    const note = tabs.tabs[0]
    expect(note.loading).toBe(false)
    typeInto(note, 'EDITED')
    h.fs.write.mockRejectedValue(new Error('read-only'))

    expect(await tabs.closeAll()).toBe(false)

    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.tabs[0].dirty).toBe(true)
    expect(notices).toContain('tabs.unsavedWorkBlocker')
    expect(atUntitledPrompt).toHaveLength(0)
  })

  it('closes a loading tab with nothing typed into it, silently, on both routes', async () => {
    parkedRead('DISK BEFORE')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const opening = tabs.openTab(NOTE_PATH)
    expect(tabs.tabs[0].loading).toBe(true)

    expect(await tabs.closeAll()).toBe(true)

    expect(tabs.tabs).toHaveLength(0)
    // Nothing of the user's was in it: no rescue, no sentence, no prompt.
    expect(notices).toHaveLength(0)
    expect(atUntitledPrompt).toHaveLength(0)
    expect(h.fs.write).not.toHaveBeenCalled()
    void opening

    // And on the window's route a loading CLEAN tab is not dirty work at all, so
    // the close is not even prevented — it is what it always was.
    parkedRead('DISK BEFORE')
    const openingSecond = tabs.openTab(NOTE_PATH)
    const { preventDefault } = await pressTheWindowX()

    expect(preventDefault).not.toHaveBeenCalled()
    expect(h.windowMock.close).not.toHaveBeenCalled()
    expect(notices).toHaveLength(0)
    void openingSecond
  })
})

/** The editor, as far as the persistence layer is concerned (the harness
 *  `tab-close-loading.test.ts` and the save-race tests share): one `type()` is
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
      handlers.forEach((x) => x())
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

describe('a bulk close must publish the pane before it reads the tab', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    h.fs.write.mockResolvedValue(null)
    h.fs.saveFileDialog.mockResolvedValue(null)
    untitledAnswer = 'discard'
    collectNotices()
    setSourceViewHandle(null)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    setRenderedFlush(null)
  })

  it('rescues the typing the rendered pane has not published yet', async () => {
    parkedRead('DISK BEFORE')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const opening = tabs.openTab(NOTE_PATH)
    const placeholder = tabs.tabs[0]
    const editor = fakeEditor('')
    await attachPane(editor, '', '/vault', placeholder.id)

    editor.type('USER TYPED')
    // In the model and in `dirty` — and NOT yet in the tab, which the rescue
    // reads once. Without the pane flush the reconciliation copies the empty
    // field into the new tab and tells the user their text is in it.
    expect(placeholder.dirty).toBe(true)
    expect(placeholder.content).toBe('')

    expect(await tabs.closeAll()).toBe(true)

    // The prompt is the last moment the text is still readable: it was moved,
    // not copied empty.
    expect(atUntitledPrompt).toContain('untitled|true|USER TYPED')
    expect(h.fs.write).not.toHaveBeenCalled()
    void opening
  })
})
