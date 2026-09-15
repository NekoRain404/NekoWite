/**
 * A keystroke typed into ANOTHER tab while the window close's prompt is up is
 * either saved or asked about, before the window goes.
 *
 * The prompt is a corner toast with no focus trap: the app stays live behind it,
 * and the tab that raised it is only the tab that was blocking. What the close
 * used to do was take a snapshot of the untitled dirty tabs BEFORE raising it,
 * and then — once the user had answered — capture the session and call
 * `win.close()`. Everything the answer did not name went with the process: the
 * tabs it looked at were the tabs of an earlier moment, and the autosave timer a
 * keystroke armed is cancelled by the close that follows.
 *
 * Two ways a tab is missed by that snapshot, and both are here: a tab the user
 * types into during the answer (it had a file and no pending edits when the
 * question was raised), and a tab that did not exist yet (the + button).
 *
 * The store is the REAL one — only the window, the appearance store and the two
 * notification channels are mocked — so the loop's reads are the store's own:
 * `saveUntilSettled` answers true only for a tab that holds nothing that is not
 * on disk (`tab-settle.ts`), which is what lets a re-ask end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const h = vi.hoisted(() => {
  const windowMock = { onCloseRequested: vi.fn(), close: vi.fn(), destroy: vi.fn() }
  const fs = {
    // Signatures declared, not inferred: an inferred mock answers only the value
    // it was built with, and these are answered per test.
    read: vi.fn<(_vault: string, _path: string) => Promise<string>>(),
    write: vi.fn<
      (_vault: string, _path: string, _content: string, _maxHistory?: number) => Promise<string | null>
    >(),
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
  }
  return {
    windowMock,
    fs,
    appearanceMock: { autosaveOnBlur: false, touchSystem: vi.fn() },
    windowTracking: { restore: vi.fn(), start: vi.fn(), flush: vi.fn(), dispose: vi.fn() },
    // Stated against the real type rather than inferred: `'discard' as const`
    // would narrow the mock's answer to that one literal, so a test answering
    // "save" is a type error vitest never shows.
    requestUntitledVaultSwitch: vi.fn<
      (_d: { count: number }) => Promise<UntitledVaultChoice>
    >(),
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

vi.mock('../i18n', () => ({ t: (key: string): string => key }))

import { createAppLifecycle } from './app-lifecycle'
import { useTabsStore } from '../stores/tabs'
import type { UntitledVaultChoice } from './recovery-closed-loop'

const PICKED = '/vault/picked.md'

/** Every question the close put in front of the user, with the control to answer
 *  it: a question the test holds open is a question the app is live behind,
 *  which is the state every test here is about. */
let prompts: { count: number; answer: (choice: UntitledVaultChoice) => void }[] = []

/** Every write the save path issued, by content. */
let written: string[] = []

/** Whether anything was still unsaved at the instant the window was closed —
 *  `win.close()` ends the process, so this is the whole question. */
let closedWhileDirty: boolean[] = []

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

type CloseHandler = (e: { preventDefault: () => void }) => Promise<void>

function registeredCloseHandler(): CloseHandler {
  const calls = h.windowMock.onCloseRequested.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0] as CloseHandler
}

/** Start a close and wait for it to reach its question. */
async function closingWithPrompt(): Promise<{ closing: Promise<void>; preventDefault: () => void }> {
  const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
  await lifecycle.mount()
  const preventDefault = vi.fn()
  const closing = registeredCloseHandler()({ preventDefault })
  await vi.waitFor(() => expect(prompts.length).toBeGreaterThan(0))
  return { closing, preventDefault }
}

describe('a keystroke typed while the window close is asking', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    // mount() only registers the native close-requested listener under a Tauri
    // runtime; expose the flag so the close path is exercised.
    ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    h.windowMock.onCloseRequested.mockResolvedValue(() => {})
    h.windowMock.close.mockResolvedValue(undefined)
    h.windowMock.destroy.mockResolvedValue(undefined)
    h.fs.read.mockResolvedValue('v1')
    // The disk a save reads before it writes (`tab-write-preconditions.ts`):
    // whatever the last landed write left there, so an ordinary save is not
    // refused as somebody else's edit — a different mechanism than the one under
    // test here.
    h.fs.write.mockImplementation(async (_v, _p, content) => {
      written.push(content)
      return null
    })
    prompts = []
    written = []
    closedWhileDirty = []
    h.fs.read.mockImplementation(async () => written[written.length - 1] ?? 'v1')
    h.requestUntitledVaultSwitch.mockImplementation(
      (d: { count: number }) =>
        new Promise<UntitledVaultChoice>((resolve) => {
          prompts.push({ count: d.count, answer: resolve })
        }),
    )
    // The refused-save route's own question: declined by default, so a test that
    // is not about it never has to answer it.
    h.notifyRecovery.mockImplementation((p: { onDismiss: () => void }) => p.onDismiss())
    h.windowMock.close.mockImplementation(() => {
      const tabs = useTabsStore()
      closedWhileDirty.push(tabs.tabs.some((t) => t.dirty))
      return Promise.resolve()
    })
    localStorage.clear()
  })

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('asks about the untitled tab the user opened while the question was up', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(null, 'first text')
    tabs.markDirty(tabs.activeId!)
    h.fs.saveFileDialog.mockResolvedValue(PICKED)

    const { closing } = await closingWithPrompt()
    // One question, and it names the one tab that existed when it was raised.
    expect(prompts.map((p) => p.count)).toEqual([1])

    // The user presses + and types, with the toast still on the screen.
    await tabs.openTab(null, 'late text')
    tabs.markDirty(tabs.activeId!)
    prompts[0].answer('discard')

    // The answer covered the tab it named and no other: the close is still
    // asking, about the tab it has never asked about. Before this, the promise
    // had already been resolved and the window was closed over the late text —
    // in no file, in no prompt, its autosave timer cancelled on the way out.
    await flush()
    expect(prompts.map((p) => p.count)).toEqual([1, 1])
    expect(tabs.tabs.map((t) => t.content)).toEqual(['late text'])

    prompts[1].answer('save')
    await closing

    expect(written).toEqual(['late text'])
    expect(closedWhileDirty).toEqual([false])
    expect(h.notifyError).not.toHaveBeenCalled()
  })

  it('saves the keystroke typed into another tab while the question was up', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(null, 'first text')
    tabs.markDirty(tabs.activeId!)
    // The tab the user types into is not the tab that raised the question: it
    // has a file, it was clean when the close flushed, and the flush is behind
    // the question — so nothing but this loop can carry what they type next.
    await tabs.openTab('/vault/b.md')
    const other = tabs.tabs.find((t) => t.path === '/vault/b.md')!

    const { closing } = await closingWithPrompt()

    other.content = 'v1 typed during the question'
    tabs.markDirty(other.id)
    prompts[0].answer('discard')
    await closing

    expect(written).toEqual(['v1 typed during the question'])
    expect(closedWhileDirty).toEqual([false])
    expect(tabs.tabs.find((t) => t.id === other.id)?.dirty).toBe(false)
  })

  it('asks once and closes when the user answers the one question it raised', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(null, 'only text')
    tabs.markDirty(tabs.activeId!)
    h.fs.saveFileDialog.mockResolvedValue(PICKED)

    const { closing, preventDefault } = await closingWithPrompt()
    expect(prompts.map((p) => p.count)).toEqual([1])
    prompts[0].answer('save')
    await closing

    // The ordinary close: one question, one write, and no second pass asking
    // about a tab the user has already ruled on. A loop that re-asked on every
    // pass would pass the two tests above and ruin this one.
    expect(preventDefault).toHaveBeenCalled()
    expect(prompts).toHaveLength(1)
    expect(written).toEqual(['only text'])
    expect(h.windowMock.close).toHaveBeenCalled()
    expect(closedWhileDirty).toEqual([false])
  })

  it('does not ask again about the tabs the question already named', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(null, 'one')
    tabs.markDirty(tabs.activeId!)
    await tabs.openTab(null, 'two')
    tabs.markDirty(tabs.activeId!)
    h.fs.saveFileDialog.mockResolvedValue(PICKED)

    const { closing } = await closingWithPrompt()
    // One question covering both, and the answer to it is final.
    expect(prompts.map((p) => p.count)).toEqual([2])
    prompts[0].answer('save')
    await closing

    expect(prompts).toHaveLength(1)
    expect(written).toEqual(['one', 'two'])
    expect(h.windowMock.close).toHaveBeenCalled()
  })

  it('still closes a set with nothing unsaved, and asks nothing', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/b.md')

    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()
    const preventDefault = vi.fn()
    await registeredCloseHandler()({ preventDefault })

    // Nothing to save is not a question: the close is not even prevented, and the
    // loop never runs.
    expect(preventDefault).not.toHaveBeenCalled()
    expect(prompts).toHaveLength(0)
    expect(written).toEqual([])
    expect(h.notifyError).not.toHaveBeenCalled()
  })
})
