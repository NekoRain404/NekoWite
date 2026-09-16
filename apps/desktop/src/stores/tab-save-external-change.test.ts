/**
 * A save must not replace an edit somebody else made (L05's save-time half).
 *
 * The half that landed an hour ago decides an external change PER PATH for every
 * open tab — an event reaches the tab that holds the file, whether or not it is
 * on screen, and a background dirty tab is asked about. That is necessary and
 * not sufficient: the overwrite happens in the SAVE, and the save never looked
 * at the disk. A tab saved after the user switched back to it — where the
 * external change was read, was maybe even asked about, and was never acted on —
 * is the case that actually loses the other program's text.
 *
 * The read a save now takes first is the whole fix; what follows it is the
 * policy this file pins down.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { onNotify } from '../services/errors'
import { useTabsStore } from './tabs'

const readMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())
const saveFileDialogMock = vi.hoisted(() => vi.fn())
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
    saveFileDialog: saveFileDialogMock,
  },
}))

/**
 * The vault, as bytes.
 *
 * One map answers `openTab`'s read and the read a save takes before it writes,
 * because they are the same file — a mock that answered them differently would
 * be testing a world where the two disagree. An external change is this map
 * being written by somebody else; our own write is the write mock writing it.
 */
const disk = new Map<string, string>()

function resetDisk(): void {
  disk.clear()
  readMock.mockReset()
  writeMock.mockReset()
  saveFileDialogMock.mockReset()
  readMock.mockImplementation(async (_vault: string, path: string) => {
    const content = disk.get(path)
    // A path with nothing at it is a read that fails, which is what the backend
    // does for a file that was moved or deleted outside the app.
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  })
  writeMock.mockImplementation(async (_vault: string, path: string, content: string) => {
    disk.set(path, content)
    return null
  })
  saveFileDialogMock.mockResolvedValue(null)
}

/** Collect what the user is told while `run` executes. */
async function messagesDuring(run: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = []
  const off = onNotify((m) => seen.push(m))
  try {
    await run()
  } finally {
    off()
  }
  return seen
}

describe('a save over an edit somebody else made', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetDisk()
  })

  // The regression that matters most, because it is the one that overwrites:
  // the external change was decided for the tab's path when the event arrived,
  // the tab was switched back to, the user typed on top of the text they were
  // shown, and the save replaced the other program's version with it.
  it('does not overwrite the file when a tab is saved after switching back to it', async () => {
    disk.set('/vault/a.md', 'A before')
    disk.set('/vault/b.md', 'B before')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/a.md')
    await tabs.openTab('/vault/b.md')
    const b = tabs.tabs[1]

    // The user goes back to A and works there; B stays open behind it.
    tabs.setActive(tabs.tabs[0].id)
    // Another program — a sync client, a script, the user's own other editor —
    // writes B while it is off screen.
    disk.set('/vault/b.md', 'B external')

    // Back to B: switching re-points activeId and nothing else, so the tab still
    // holds the text the user was last shown.
    tabs.setActive(b.id)
    b.content = 'B before plus my edit'
    tabs.markDirty(b.id)

    const seen = await messagesDuring(() => tabs.saveActive())

    // The other program's text is still the file's...
    expect(disk.get('/vault/b.md')).toBe('B external')
    // ...nothing was written...
    expect(writeMock).not.toHaveBeenCalled()
    // ...the user's text is still here, and still unsaved (a tab that says
    // otherwise is the same defect with the opposite sign: they keep typing into
    // a document that is no longer being written)...
    expect(b.content).toBe('B before plus my edit')
    expect(b.dirty).toBe(true)
    // `failed`, not `dirty`: the tab is unsaved AND a save was just refused for
    // it. Plain `dirty` is the state of a tab nothing has tried to save yet, and
    // the sentence that says which of the two this is lives in a toast that is
    // gone in three seconds.
    expect(tabs.saveStateOf(b.id)).toBe('failed')
    // ...and the save did not stop silently.
    expect(seen.join(' ')).toContain('/vault/b.md')
  })

  it('forgets the refusal once the tab has taken the file\'s version', async () => {
    // The record is about the bytes the tab believed were on disk when the write
    // was refused, so it is spent by the tab changing its mind — not by a list of
    // places that must remember to clear it. Otherwise: the user takes the disk
    // version, types one word, and the status line says a save failed over text
    // no save has ever been attempted for.
    disk.set('/vault/b.md', 'B before')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/b.md')
    const b = tabs.tabs[0]
    disk.set('/vault/b.md', 'B external')
    b.content = 'B before plus my edit'
    tabs.markDirty(b.id)

    await tabs.saveActive()
    expect(tabs.saveStateOf(b.id)).toBe('failed')

    // The conflict prompt's "use the disk version" — an explicit answer, so it
    // wins over the edits even though the tab is dirty.
    await tabs.reloadFromDisk(b.id, { explicit: true })
    expect(b.dirty).toBe(false)
    expect(tabs.saveStateOf(b.id)).toBe('saved')

    // What they type next is text no refusal was ever about.
    b.content = 'B external plus my edit'
    tabs.markDirty(b.id)
    expect(tabs.saveStateOf(b.id)).toBe('dirty')
  })

  it('writes the tab text once the user asks again, having been told', async () => {
    disk.set('/vault/b.md', 'B before')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/b.md')
    const b = tabs.tabs[0]
    disk.set('/vault/b.md', 'B external')
    b.content = 'B before plus my edit'
    tabs.markDirty(b.id)

    await tabs.saveActive()
    await tabs.saveActive()

    expect(disk.get('/vault/b.md')).toBe('B before plus my edit')
    expect(b.savedContent).toBe('B before plus my edit')
    expect(b.dirty).toBe(false)
    // The question is settled: nothing about the file is outstanding, so the
    // next save takes the ordinary path.
    expect(b.externalConflict ?? null).toBeNull()
  })

  it('does not take a timer-driven save for the user answer', async () => {
    disk.set('/vault/b.md', 'B before')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/b.md')
    const b = tabs.tabs[0]
    disk.set('/vault/b.md', 'B external')
    b.content = 'B before plus my edit'
    tabs.markDirty(b.id)

    await tabs.saveActive()

    // The autosave timer (and a bulk flush, and the close path) reach the save
    // through this call. None of them stands for the user, and none of them may
    // replace somebody else's edit — nor ask again about a question already put.
    const seen = await messagesDuring(() => tabs.saveTab(b.id))

    expect(writeMock).not.toHaveBeenCalled()
    expect(disk.get('/vault/b.md')).toBe('B external')
    expect(b.dirty).toBe(true)
    expect(seen).toEqual([])
  })

  it('refuses a bulk flush of a background tab rather than replacing the file', async () => {
    disk.set('/vault/b.md', 'B before')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/b.md')
    const b = tabs.tabs[0]
    disk.set('/vault/b.md', 'B external')
    b.content = 'B before plus my edit'
    tabs.markDirty(b.id)

    // False is what blocks the lossy action the flush was called for — the vault
    // switch, the window close — instead of treating the note as saved.
    const ok = await tabs.flushDirty()

    expect(ok).toBe(false)
    expect(disk.get('/vault/b.md')).toBe('B external')
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('takes the conflict prompt "keep local" as the answer the next save reads', async () => {
    disk.set('/vault/b.md', 'B before')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/b.md')
    const b = tabs.tabs[0]
    b.content = 'B before plus my edit'
    tabs.markDirty(b.id)
    // The event-time prompt asked about this file and the user answered "Keep
    // local" — the choice the dialog reports to the app (`App.vue`).
    disk.set('/vault/b.md', 'B external')
    await tabs.keepLocalConflict(b.id)

    // Their answer is what the save path reads, so the write goes through
    // instead of the same question being put a second time. A timer-driven save
    // carries it too: the answer covered the bytes that are on the file, and
    // asking again once the user has decided is the prompt that "costs attention
    // and buys nothing".
    const seen = await messagesDuring(() => tabs.saveTab(b.id))

    expect(disk.get('/vault/b.md')).toBe('B before plus my edit')
    expect(b.dirty).toBe(false)
    expect(seen).toEqual([])
  })

  it('does not let a "keep local" answer cover bytes written after it', async () => {
    disk.set('/vault/b.md', 'B before')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/b.md')
    const b = tabs.tabs[0]
    b.content = 'B before plus my edit'
    tabs.markDirty(b.id)
    disk.set('/vault/b.md', 'B external')
    await tabs.keepLocalConflict(b.id)

    // The answer was about `B external`. The file moved on, so it is a question
    // the user has not answered — recording an answer is not a licence for
    // everything that lands afterwards.
    disk.set('/vault/b.md', 'B external, again')
    const seen = await messagesDuring(() => tabs.saveActive())

    expect(writeMock).not.toHaveBeenCalled()
    expect(disk.get('/vault/b.md')).toBe('B external, again')
    expect(seen.join(' ')).toContain('/vault/b.md')
  })

  it('asks again when the file changes a second time behind the question', async () => {
    disk.set('/vault/b.md', 'B before')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/b.md')
    const b = tabs.tabs[0]
    disk.set('/vault/b.md', 'B external')
    b.content = 'B before plus my edit'
    tabs.markDirty(b.id)
    await tabs.saveActive()

    // The user was told about `B external`; nobody answered yet, and the file
    // has moved on. Those are not the bytes the user was told about, so the
    // answer they have not given cannot stand for them.
    disk.set('/vault/b.md', 'B external, again')
    const seen = await messagesDuring(() => tabs.saveActive())

    expect(writeMock).not.toHaveBeenCalled()
    expect(disk.get('/vault/b.md')).toBe('B external, again')
    expect(seen.join(' ')).toContain('/vault/b.md')
  })

  it('writes normally once the file holds this tab text again', async () => {
    disk.set('/vault/b.md', 'B before')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/b.md')
    const b = tabs.tabs[0]
    disk.set('/vault/b.md', 'B external')
    b.content = 'B before plus my edit'
    tabs.markDirty(b.id)
    await tabs.saveActive()

    // The change went away — the other program undid it, or the user reverted it
    // there. There is nothing left to conflict with, and nothing to ask about.
    disk.set('/vault/b.md', 'B before')
    const seen = await messagesDuring(() => tabs.saveActive())

    expect(disk.get('/vault/b.md')).toBe('B before plus my edit')
    expect(b.dirty).toBe(false)
    expect(seen).toEqual([])
  })

  it('writes as before when the file still holds what this tab read', async () => {
    disk.set('/vault/a.md', 'A before')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/a.md')
    const a = tabs.tabs[0]
    a.content = 'A before plus my edit'
    tabs.markDirty(a.id)

    const seen = await messagesDuring(() => tabs.saveActive())

    // The check reads, it does not refuse: an ordinary save is untouched, and
    // the read is what proves it was ordinary.
    expect(disk.get('/vault/a.md')).toBe('A before plus my edit')
    expect(a.dirty).toBe(false)
    expect(seen).toEqual([])
  })

  it('writes a Save-As over a name that already holds a file', async () => {
    // The dialog that chose the name already asked about replacing what is
    // there, and an untitled tab has no bytes of its own at any path.
    disk.set('/vault/notes/foo.md', 'somebody else\'s note')
    saveFileDialogMock.mockResolvedValue('/vault/notes/foo.md')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(null, 'my new text')
    const t = tabs.tabs[0]
    tabs.markDirty(t.id)

    await tabs.saveActive()

    expect(disk.get('/vault/notes/foo.md')).toBe('my new text')
    expect(t.dirty).toBe(false)
  })

  it('does not block a save whose file could not be read', async () => {
    disk.set('/vault/a.md', 'A before')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/a.md')
    const a = tabs.tabs[0]
    // Deleted outside the app. There are no bytes of ours to compare against,
    // and the case belongs to the external-change service, which detaches the
    // tab and asks where the text should go; a save the user asked for still
    // puts their text somewhere rather than refusing on a comparison it could
    // not make.
    disk.delete('/vault/a.md')
    a.content = 'A before plus my edit'
    tabs.markDirty(a.id)

    await tabs.saveActive()

    expect(disk.get('/vault/a.md')).toBe('A before plus my edit')
  })

  it('writes nothing while the note is still being read into its tab', async () => {
    // Until the read lands the tab is an empty placeholder wearing the note's
    // path (`commitRead` is what fills it), so a save here would put the
    // placeholder over the note: the file's bytes are not this tab's text yet,
    // and the tab has no text of its own.
    disk.set('/vault/a.md', 'A before')
    let release: (text: string) => void = () => {}
    let started: () => void = () => {}
    const reading = new Promise<void>((resolve) => {
      started = resolve
    })
    readMock.mockImplementationOnce(async () => {
      started()
      return await new Promise<string>((resolve) => {
        release = resolve
      })
    })
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const opening = tabs.openTab('/vault/a.md')
    await reading

    const seen = await messagesDuring(async () => {
      await tabs.saveActive()
      // ...and again. For a loaded tab a second ask is the user's answer to a
      // conflict and the write goes through; here there is no conflict, only a
      // document that has not arrived — and the second ask must not be what puts
      // an empty placeholder over the note.
      await tabs.saveActive()
    })

    expect(writeMock).not.toHaveBeenCalled()
    expect(disk.get('/vault/a.md')).toBe('A before')
    // Not a question put to the user either: nothing has been decided about the
    // note, and its text is still on its way.
    expect(seen).toEqual([])

    release('A before')
    await opening
    expect(tabs.tabs[0].content).toBe('A before')
  })

  it('writes nothing when the vault changes while the save is reading the disk', async () => {
    disk.set('/vault/a.md', 'A before')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/a.md')
    const a = tabs.tabs[0]
    a.content = 'A before plus my edit'
    tabs.markDirty(a.id)

    // The read a save takes is an await, so the world can move inside it — the
    // same hazard the flush and the asset relocation already have a guard for.
    let release: (text: string) => void = () => {}
    let started: () => void = () => {}
    const reading = new Promise<void>((resolve) => {
      started = resolve
    })
    readMock.mockImplementationOnce(async () => {
      started()
      return await new Promise<string>((resolve) => {
        release = resolve
      })
    })
    const saving = tabs.saveTab(a.id)
    await reading
    tabs.removeAllTabs()
    tabs.setVault('/other')
    release('A before')

    await expect(saving).resolves.toBe(false)
    expect(writeMock).not.toHaveBeenCalled()
  })
})
