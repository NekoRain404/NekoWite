/**
 * A note whose first read has not landed yet is not editable.
 *
 * `openTab` pushes the tab, makes it active and reads the file — so for the
 * length of that read the pane is holding an EMPTY document with the note's
 * path on it, and the user can type into it. The read then wrote its text over
 * whatever they had typed: `content` and `savedContent` both became the file's
 * old bytes, and the typing was gone without a trace.
 *
 * What the commit may not do (L03's fix direction): "unconditionally overwrite a
 * placeholder document the user has edited". The file's text is the note's and
 * the typing is the user's, so neither is written over the other — the typing
 * moves to an untitled tab of its own, which is the state it is actually in.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { onNotify, onRecovery } from '../services/errors'
import { useTabsStore } from './tabs'

const readMock = vi.hoisted(() => vi.fn())
vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: vi.fn(async () => null),
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

/** A read the test decides when to answer, and with what. */
function parkedRead() {
  let answer: ((content: string) => void) | null = null
  let refused: ((e: unknown) => void) | null = null
  const started: Array<() => void> = []
  readMock.mockImplementation(
    () =>
      new Promise<string>((resolve, reject) => {
        answer = resolve
        refused = reject
        started.forEach((fn) => fn())
      }),
  )
  return {
    /** Answer the parked read with the file's text. */
    resolve: (content: string) => answer?.(content),
    reject: (e: unknown) => refused?.(e),
  }
}

/** Exactly what the panes do to the tab for a keystroke: the text goes in (the
 *  source pane publishes immediately, the rendered pane on its debounce) and
 *  the edit is recorded at the keystroke. */
function typeInto(tab: { id: string; content: string }, text: string): void {
  const tabs = useTabsStore()
  tab.content = text
  tabs.markDirty(tab.id)
}

describe('a note opened while the user is already typing in it', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    readMock.mockReset()
  })

  it('keeps the typing as its own document and shows the note the file holds', async () => {
    const read = parkedRead()
    const seen: string[] = []
    const off = onNotify((m) => seen.push(m))
    const tabs = useTabsStore()
    tabs.setVault('/vault')

    const opening = tabs.openTab('/vault/a.md')
    const placeholder = tabs.tabs[0]
    expect(tabs.activeId).toBe(placeholder.id)
    typeInto(placeholder, 'USER TYPED')

    read.resolve('DISK BEFORE')
    await opening
    off()

    // The note is the file's text — and the typing is still in memory, in a tab
    // of its own rather than written over the file's bytes.
    const note = tabs.tabs.find((t) => t.path === '/vault/a.md')
    expect(note?.content).toBe('DISK BEFORE')
    const rescued = tabs.tabs.find((t) => t.path === null)
    expect(rescued?.content).toBe('USER TYPED')
    expect(rescued?.dirty).toBe(true)
    expect(note?.savedContent).toBe('DISK BEFORE')
    expect(note?.loading).toBe(false)
    // The note stays the active tab: the user asked for a.md, not for a
    // nameless document — the typing is parked, not shoved in front of them.
    expect(tabs.activeId).toBe(note?.id)
    // ...and it is not silent.
    expect(seen.length).toBeGreaterThan(0)
  })

  it('loads the note normally when nothing was typed into it', async () => {
    const read = parkedRead()
    const tabs = useTabsStore()
    tabs.setVault('/vault')

    const opening = tabs.openTab('/vault/a.md')
    expect(tabs.tabs[0].loading).toBe(true)
    read.resolve('DISK BEFORE')
    await opening

    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.tabs[0].content).toBe('DISK BEFORE')
    expect(tabs.tabs[0].savedContent).toBe('DISK BEFORE')
    expect(tabs.tabs[0].dirty).toBe(false)
    expect(tabs.tabs[0].loading).toBe(false)
  })

  it('keeps the typing when the read fails', async () => {
    const read = parkedRead()
    const seen: string[] = []
    const off = onNotify((m) => seen.push(m))
    const tabs = useTabsStore()
    tabs.setVault('/vault')

    const opening = tabs.openTab('/vault/a.md')
    typeInto(tabs.tabs[0], 'USER TYPED')
    read.reject(new Error('io'))
    await opening
    off()

    // The failed read takes its own tab away (there is no note to show) and
    // must not take the typing with it.
    expect(tabs.tabs.some((t) => t.path === '/vault/a.md')).toBe(false)
    const rescued = tabs.tabs.find((t) => t.path === null)
    expect(rescued?.content).toBe('USER TYPED')
    expect(tabs.activeId).toBe(rescued?.id)
    expect(seen.length).toBeGreaterThan(0)
  })

  it('leaves nothing behind when the tab is closed inside the read', async () => {
    const read = parkedRead()
    const tabs = useTabsStore()
    tabs.setVault('/vault')

    const opening = tabs.openTab('/vault/a.md')
    const id = tabs.tabs[0].id
    await tabs.closeTab(id)
    expect(tabs.tabs).toHaveLength(0)

    read.resolve('DISK BEFORE')
    await opening

    // A read that lands after the document was closed must not resurrect it.
    expect(tabs.tabs).toHaveLength(0)
    expect(tabs.activeId).toBeNull()
  })

  it('reads a file once when it is opened twice while the read is pending', async () => {
    const read = parkedRead()
    const tabs = useTabsStore()
    tabs.setVault('/vault')

    const first = tabs.openTab('/vault/a.md')
    const second = tabs.openTab('/vault/a.md')
    read.resolve('DISK BEFORE')
    await Promise.all([first, second])

    expect(readMock).toHaveBeenCalledTimes(1)
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.tabs[0].content).toBe('DISK BEFORE')
  })

  it('drops a read that lands after the vault changed', async () => {
    const read = parkedRead()
    const tabs = useTabsStore()
    tabs.setVault('/vault')

    const opening = tabs.openTab('/vault/a.md')
    // The vault switch clears the tab set (appBootstrap's removeAllTabs) and
    // then the switch lands; the old vault's read must not open a tab in the
    // new one.
    tabs.removeAllTabs()
    tabs.setVault('/other')
    read.resolve('DISK BEFORE')
    await opening

    expect(tabs.tabs).toHaveLength(0)
    expect(tabs.activeId).toBeNull()
  })

  it('does not turn a read that failed into a second copy of a closed tab', async () => {
    // A recovery prompt is raised by a completed open; a failed one must not
    // leave a tab behind for it to appear over.
    const read = parkedRead()
    let prompts = 0
    const off = onRecovery(() => { prompts += 1 })
    const tabs = useTabsStore()
    tabs.setVault('/vault')

    const opening = tabs.openTab('/vault/missing.md')
    read.reject(new Error('not found'))
    await opening
    off()

    expect(tabs.tabs).toHaveLength(0)
    expect(prompts).toBe(0)
  })
})
