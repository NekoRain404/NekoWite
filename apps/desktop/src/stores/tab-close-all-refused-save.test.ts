/**
 * A refused save does not leave "Close all" with nothing to press, and the
 * sentence it refuses with is the close's own.
 *
 * `flushDirty()` cannot put a read-only tab's text on disk — the backend refuses
 * that write deliberately and no retry of it can land — so Close All used to
 * return false under *"Some files could not be saved; the vault was not
 * switched."*: a sentence about an action the user never took, on the one step
 * where the window's X offers a way out (`rescueUnflushableTabs`). A note
 * restored from the trash carries the read-only bit, so a user can meet this
 * without ever having set it.
 *
 * Both halves are tested here. The route: a copy under a name the user picks,
 * from the one function the window close asks for the same thing
 * (`unflushable-rescue.ts`) — the two controls differ, the question does not. The
 * sentence: `unsavedWorkBlockerCloseAll`, which is about the tabs rather than
 * about the window or the vault, while the write path still names the file that
 * refused.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const h = vi.hoisted(() => {
  const fs = {
    // Signatures declared, not inferred: an inferred mock answers only the value
    // it was built with, and the tests below answer with several (see the note on
    // `saveFileDialog`).
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
  return { fs, notifyError: vi.fn(), notifyRecovery: vi.fn() }
})

vi.mock('../platform/gateways/fs', () => ({ fsService: h.fs }))

vi.mock('../services/errors', () => ({
  notifyError: h.notifyError,
  notifyRecovery: h.notifyRecovery,
}))

// Keys, plus params: which sentence was chosen AND which file it named.
vi.mock('../i18n', () => ({
  t: (key: string, params?: Record<string, unknown>): string =>
    params ? `${key} ${JSON.stringify(params)}` : key,
}))

import { useTabsStore } from './tabs'
import { READ_ONLY_PREFIX, copyNameFor } from './write-refusal'
import type { RecoveryPrompt } from '../services/errors'

const VAULT_SWITCH_SENTENCE = 'tabs.unsavedWorkBlocker'
const WINDOW_SENTENCE = 'tabs.unsavedWorkBlockerClose'
const CLOSE_ALL_SENTENCE = 'tabs.unsavedWorkBlockerCloseAll'
const COPY_OFFER = 'tabs.unsavedWorkRescue'
const UNTITLED_PROMPT = 'tabs.untitledCloseAllMsg'

const NOTE = '/vault/ro.md'
const COPY = '/vault/ro (copy).md'
const TYPED = 'typed into a protected note'

/** Every question the close raised, in order. The test answers each one, which is
 *  what makes "the route was offered" and "the user took it" two different
 *  states rather than one. */
let prompts: RecoveryPrompt[] = []
/** Every sentence either the close or the write path put in front of the user. */
let notices: string[] = []

function collect(): void {
  notices = []
  prompts = []
  h.notifyError.mockImplementation((m: string) => {
    notices.push(m)
  })
  h.notifyRecovery.mockImplementation((p: RecoveryPrompt) => {
    prompts.push(p)
    notices.push(p.message)
  })
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Every write that landed on `path`, by content. */
function writesTo(path: string): string[] {
  return h.fs.write.mock.calls.filter((call) => call[1] === path).map((call) => call[2])
}

/** A note whose file refuses every write aimed at it, with the user's typing in
 *  the tab: the state a note restored from the trash puts them in. The two
 *  attempts at the note are the flush's and then the copy route's, and both are
 *  refused; anything after them — the copy itself — lands. */
async function typedIntoAReadOnlyNote() {
  const refused = (): Error => new Error(`${READ_ONLY_PREFIX}read-only file`)
  h.fs.write.mockRejectedValueOnce(refused()).mockRejectedValueOnce(refused())
  const tabs = useTabsStore()
  tabs.setVault('/vault')
  await tabs.openTab(NOTE)
  tabs.tabs[0].content = TYPED
  tabs.markDirty(tabs.tabs[0].id)
  return tabs
}

describe('Close all and a save the file refuses', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    h.fs.read.mockResolvedValue('on disk')
    h.fs.write.mockResolvedValue(null)
    h.fs.saveFileDialog.mockResolvedValue(null)
    collect()
    localStorage.clear()
  })

  it('offers the copy route, and closes once the user takes it', async () => {
    h.fs.saveFileDialog.mockResolvedValue(COPY)
    const tabs = await typedIntoAReadOnlyNote()

    const closing = tabs.closeAll()
    await flush()
    // The way out the window's X has always had, now on this control too — asked,
    // never taken on the user's behalf.
    expect(prompts.map((p) => p.message.split(' ')[0])).toEqual([COPY_OFFER])

    prompts[0].onRestore()
    await expect(closing).resolves.toBe(true)

    // The text is on disk under the name the user picked, and the protected file
    // was never written to: both attempts at it were refused.
    expect(h.fs.saveFileDialog).toHaveBeenCalledWith(copyNameFor(NOTE), '/vault')
    expect(writesTo(COPY)).toEqual([TYPED])
    expect(writesTo(NOTE)).toEqual([TYPED, TYPED])
    expect(tabs.tabs).toHaveLength(0)
    // The refusal named the file, and said what it was doing instead.
    expect(notices).toContain(`tabs.saveBlockedReadOnlyCopy {"path":"${NOTE}"}`)
    expect(notices).not.toContain(VAULT_SWITCH_SENTENCE)
  })

  it('refuses in the close\'s own words when the copy route is declined', async () => {
    const tabs = await typedIntoAReadOnlyNote()

    const closing = tabs.closeAll()
    await flush()
    expect(prompts).toHaveLength(1)
    prompts[0].onDismiss()
    await expect(closing).resolves.toBe(false)

    // Nothing closed, and the text is still where the user can reach it.
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.tabs[0].content).toBe(TYPED)
    expect(tabs.tabs[0].dirty).toBe(true)
    expect(writesTo(COPY)).toEqual([])
    // The obstruction, named by the write path that met it.
    expect(notices).toContain(`tabs.saveBlockedReadOnly {"path":"${NOTE}"}`)
    // And the summary is about the tabs: not the vault switch, and not the
    // window's sentence either, which is the window close's own claim.
    expect(notices).toContain(CLOSE_ALL_SENTENCE)
    expect(notices).not.toContain(VAULT_SWITCH_SENTENCE)
    expect(notices).not.toContain(WINDOW_SENTENCE)
  })

  it('reports the close\'s sentence for a refused save of an untitled document too', async () => {
    // The other refusal site in `closeAll`: the Save-As the untitled prompt's
    // "save" answer opens, whose write does not land.
    h.fs.saveFileDialog.mockResolvedValue('/vault/picked.md')
    h.fs.write.mockRejectedValue(new Error('disk full'))
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(null, 'never named')
    tabs.markDirty(tabs.activeId!)

    const closing = tabs.closeAll()
    await flush()
    expect(prompts).toHaveLength(1)
    expect(prompts[0].message).toContain(UNTITLED_PROMPT)
    prompts[0].onRestore()

    await expect(closing).resolves.toBe(false)

    expect(tabs.tabs).toHaveLength(1)
    expect(notices).toContain(CLOSE_ALL_SENTENCE)
    expect(notices).not.toContain(VAULT_SWITCH_SENTENCE)
  })
})
