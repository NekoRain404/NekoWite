/**
 * `closeAll` asks about every untitled dirty tab that exists when it destroys
 * the set — including the ones that appear while it is asking.
 *
 * The prompt is a corner toast with no focus trap, so the app stays live behind
 * it, and there are two ways a tab arrives during the answer: the + button
 * (`TabBar.vue` → `openTab(null)`), and a read landing on a placeholder the user
 * typed into, which turns what they typed into a tab of its own
 * (`rescuePlaceholderTyping`). Both produce an untitled dirty tab.
 *
 * `closeAll` snapshotted `untitledDirtyTabs()` BEFORE the prompt, and the loop
 * after it skipped everything path-less (`if (!tab.path || !tab.dirty) continue`).
 * So a tab born during the answer was removed by `removeAllTabs` with its
 * autosave timer cancelled, its text in no file and in no prompt: `flushDirty`
 * skips path-less tabs, and `captureSession()` persists paths only.
 *
 * The last test is the shape §4 requires to stay unchanged: a set with nothing
 * unsaved closes on one click, with no prompt and no write.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const h = vi.hoisted(() => {
  const fs = {
    // Signatures declared, not inferred: an inferred mock answers only the value
    // it was built with, and the tests below answer with several.
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
    // The return is stated rather than inferred: a bare `vi.fn(async () => null)`
    // types as Promise<null>, so a test answering with a path is a type error —
    // and vitest strips types while eslint does not typecheck, so `vue-tsc` is
    // the only thing that sees it.
    saveFileDialog: vi.fn(async (): Promise<string | null> => null),
  }
  return { fs, notifyError: vi.fn(), notifyRecovery: vi.fn() }
})

vi.mock('../platform/gateways/fs', () => ({ fsService: h.fs }))

vi.mock('../services/errors', () => ({
  notifyError: h.notifyError,
  notifyRecovery: h.notifyRecovery,
}))

// The keys are what the user-facing sentence is, so asserting on the key keeps
// the tests about which sentence was chosen. The params ride along: a prompt that
// names one tab and one that names two are different questions, and the count is
// how the test tells them apart.
vi.mock('../i18n', () => ({
  t: (key: string, params?: Record<string, unknown>): string =>
    params ? `${key} ${JSON.stringify(params)}` : key,
}))

import { useTabsStore } from './tabs'
import type { RecoveryPrompt } from '../services/errors'

const UNTITLED_PROMPT = 'tabs.untitledCloseAllMsg'

/** Every prompt the close raised, in order. The test answers them itself, which
 *  is what makes "while the prompt is up" a state it can stand in. */
let prompts: RecoveryPrompt[] = []
/** Every error sentence either the close or the write path put in front of the
 *  user, in order. */
let notices: string[] = []

function collect(): void {
  prompts = []
  notices = []
  h.notifyError.mockImplementation((m: string) => {
    notices.push(m)
  })
  h.notifyRecovery.mockImplementation((p: RecoveryPrompt) => {
    prompts.push(p)
  })
}

/** Let an in-flight close reach the prompt it raises. A macrotask boundary is
 *  past every await on the way (the placeholder step, then the flush). */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A first read the test decides when — or whether — to answer. Later reads (the
 *  save path compares the disk against the tab before it writes) answer at once,
 *  so a close that does reach the save gate does not park on them. */
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

describe('closeAll takes the set as it stands at the end, not when it asked', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    h.fs.read.mockResolvedValue('')
    h.fs.write.mockResolvedValue(null)
    h.fs.saveFileDialog.mockResolvedValue(null)
    collect()
    localStorage.clear()
  })

  it('asks about a tab opened while the prompt is up, and destroys nothing before that', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(null, 'first text')
    tabs.markDirty(tabs.activeId!)

    const closing = tabs.closeAll()
    await flush()
    // One question, and it names the one tab that existed when it was raised.
    expect(prompts).toHaveLength(1)
    expect(prompts[0].message).toContain(UNTITLED_PROMPT)

    // The user presses + and types, with the toast still on screen.
    await tabs.openTab(null, 'late text')
    tabs.markDirty(tabs.activeId!)
    prompts[0].onDismiss()

    await flush()
    // Both texts are still here, and the close is still asking: the tab that
    // appeared after the snapshot is not removed on an answer that never named
    // it. Before the fix this was `[]` and the promise had already resolved true
    // — the text was gone, autosave timer cancelled, in no file and no prompt.
    expect(tabs.tabs.map((tab) => tab.content)).toEqual(['first text', 'late text'])
    expect(prompts).toHaveLength(2)

    prompts[1].onDismiss()
    await expect(closing).resolves.toBe(true)
    expect(tabs.tabs).toHaveLength(0)
  })

  it('lets the answer that covers the late tab govern it', async () => {
    h.fs.saveFileDialog.mockResolvedValue('/vault/kept.md')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(null, 'first text')
    tabs.markDirty(tabs.activeId!)

    const closing = tabs.closeAll()
    await flush()
    await tabs.openTab(null, 'late text')
    tabs.markDirty(tabs.activeId!)
    prompts[0].onDismiss()

    await flush()
    expect(prompts).toHaveLength(2)
    // The late tab is saved under the name the user picks — the same route the
    // prompt always offered, now reaching a tab it never used to cover.
    prompts[1].onRestore()
    await expect(closing).resolves.toBe(true)

    expect(h.fs.write.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ['/vault/kept.md', 'late text'],
    ])
    expect(tabs.tabs).toHaveLength(0)
  })

  it('asks about the tab a late read rescues into, too', async () => {
    const read = parkedRead('DISK')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(null, 'first text')
    tabs.markDirty(tabs.activeId!)
    const opening = tabs.openTab('/vault/a.md')
    const placeholder = tabs.tabs[1]
    expect(placeholder.loading).toBe(true)

    const closing = tabs.closeAll()
    await flush()
    expect(prompts).toHaveLength(1)

    // The user types into the note that has not finished opening, and the read
    // lands: their typing moves to a tab of its own — the second way a tab
    // arrives during the answer, and one the snapshot cannot have contained.
    typeInto(placeholder, 'typed while loading')
    read.land()
    await opening
    expect(tabs.tabs.filter((tab) => tab.path === null && tab.dirty)).toHaveLength(2)

    prompts[0].onDismiss()
    await flush()

    expect(tabs.tabs.map((tab) => tab.content)).toContain('typed while loading')
    expect(prompts).toHaveLength(2)
    prompts[1].onDismiss()
    await expect(closing).resolves.toBe(true)
    expect(tabs.tabs).toHaveLength(0)
  })

  it('does not ask twice about the tabs the prompt already named', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(null, 'one')
    tabs.markDirty(tabs.activeId!)
    await tabs.openTab(null, 'two')
    tabs.markDirty(tabs.activeId!)

    const closing = tabs.closeAll()
    await flush()
    // One question covering both, and the answer to it is final: a second pass
    // that re-asked would be a prompt the user has already answered.
    expect(prompts).toHaveLength(1)
    expect(prompts[0].message).toBe(`${UNTITLED_PROMPT} {"count":2}`)
    prompts[0].onDismiss()
    await expect(closing).resolves.toBe(true)

    expect(prompts).toHaveLength(1)
    expect(tabs.tabs).toHaveLength(0)
  })

  it('closes a set with nothing unsaved in one pass, with no prompt', async () => {
    h.fs.read.mockResolvedValue('# note')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/a.md')
    await tabs.openTab(null, '')

    await expect(tabs.closeAll()).resolves.toBe(true)

    expect(tabs.tabs).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(notices).toHaveLength(0)
    expect(h.fs.write).not.toHaveBeenCalled()
  })
})
