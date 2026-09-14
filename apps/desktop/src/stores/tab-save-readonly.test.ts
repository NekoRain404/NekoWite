/**
 * A save the backend refuses because the file on disk is read-only.
 *
 * The refusal is not a failure. Nothing was written, the text is safe in the
 * editor, and no retry of the same write can ever land — so `tabs.saveFailed`
 * ("…please retry") is advice the user cannot carry out, exactly the defect
 * `tabs.saveBlockedUnrenderable` was introduced to fix for the unrenderable
 * case. Worse, the refused save keeps `flushDirty()` false, and `flushDirty()`
 * is what gates the window close (`app/app-lifecycle.ts`): the user typed into
 * a protected note, was told to retry, retried, and then could not quit. A note
 * restored from the trash carries the read-only bit with it, so none of this
 * needs the user to have set the bit themselves.
 *
 * These cases drive the real tabs store over a recording fs port.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { clearRefusedDocument, markRefusedDocument } from '../services/editor-ownership'
import { useTabsStore } from './tabs'
import { t } from '../i18n'
import { READ_ONLY_PREFIX } from './write-refusal'

const readMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())
const saveFileDialogMock = vi.hoisted(() => vi.fn())
const notifyErrorMock = vi.hoisted(() => vi.fn())
const announceMock = vi.hoisted(() => vi.fn())
vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: writeMock,
    list: vi.fn(),
    watch: vi.fn(),
    deleteFile: vi.fn(),
    stat: vi.fn(),
    listHistory: vi.fn(),
    readHistory: vi.fn(),
    restoreHistory: vi.fn(),
    createDir: vi.fn(),
    renameEntry: vi.fn(),
    saveFileDialog: saveFileDialogMock,
  },
}))
vi.mock('../services/errors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/errors')>()),
  notifyError: notifyErrorMock,
}))
vi.mock('../services/announcer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/announcer')>()),
  announce: announceMock,
}))

/** The refusal `write_file` returns for `path`, token and all. */
const refusalFor = (path: string): string =>
  `${READ_ONLY_PREFIX}could not replace ${path}: the file is read-only (mode 0444), ` +
  'so it was left untouched; clear the read-only permission to save over it, or ' +
  'save it under a different name'

const RO = '/vault/ro.md'
const COPY = '/vault/ro (copy).md'

/** Every write the save path attempted, in order — refused ones included. */
let attempts: Array<{ path: string; content: string }> = []
/** What the backend ACCEPTED: the files that actually took the text. */
let written: Array<{ path: string; content: string }> = []

/**
 * The fs port as the backend behaves: every write is recorded, and the write to
 * a protected file is refused — a refusal is about THAT file, so a copy under
 * another name is not refused with it.
 */
function seedWrites(protectedPaths: string[] = [RO]): void {
  attempts = []
  written = []
  writeMock.mockImplementation((_vault: string, path: string, content: string) => {
    attempts.push({ path, content })
    if (protectedPaths.includes(path)) return Promise.reject(refusalFor(path))
    written.push({ path, content })
    return Promise.resolve(null)
  })
}

describe('a save refused because the file is read-only', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    readMock.mockReset()
    writeMock.mockReset()
    saveFileDialogMock.mockReset()
    notifyErrorMock.mockReset()
    announceMock.mockReset()
    seedWrites()
  })

  /** A dirty tab over a note whose file refuses the write. */
  async function openProtectedNote(): Promise<ReturnType<typeof useTabsStore>> {
    readMock.mockResolvedValue('on disk')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab(RO)
    const tab = s.tabs[0]
    tab.content = 'typed while the file was protected'
    s.markDirty(tab.id)
    return s
  }

  it('names the reason instead of inviting a retry that cannot work', async () => {
    const s = await openProtectedNote()

    await s.saveActive()

    // What the user reads: the file is read-only, and here is the way out.
    expect(notifyErrorMock).toHaveBeenCalledWith(t('tabs.saveBlockedReadOnlyCopy', { path: RO }))
    // Not the message that says "please retry" — that one is for a failure the
    // user can act on.
    expect(notifyErrorMock).not.toHaveBeenCalledWith(t('tabs.saveFailed'))
    // Nothing was written to the file the user protected, and their text is
    // still in the editor.
    expect(written).toEqual([])
    expect(s.tabs[0].content).toBe('typed while the file was protected')
    expect(s.tabs[0].dirty).toBe(true)
  })

  it('an autosave reports the same reason without opening a dialog', async () => {
    const s = await openProtectedNote()

    // The autosave timer (and the window-blur save) reach `saveTab` directly:
    // background work must not put a file dialog in front of the user.
    await s.saveTab(s.tabs[0].id)

    expect(notifyErrorMock).toHaveBeenCalledWith(t('tabs.saveBlockedReadOnly', { path: RO }))
    expect(saveFileDialogMock).not.toHaveBeenCalled()
    expect(s.tabs[0].dirty).toBe(true)
  })

  it('offers a copy instead, and leaves the protected file alone', async () => {
    const s = await openProtectedNote()
    saveFileDialogMock.mockResolvedValue(COPY)

    await s.saveActive()

    // The copy — not the note — took the text, and the note was attempted once
    // (the refusal) and then left alone.
    expect(written).toEqual([{ path: COPY, content: 'typed while the file was protected' }])
    expect(attempts.map((w) => w.path)).toEqual([RO, COPY])
    // The tab follows the text to where it now is, so the next save has
    // somewhere to go and the work is no longer unsaved.
    expect(s.tabs[0].path).toBe(COPY)
    expect(s.tabs[0].savedContent).toBe('typed while the file was protected')
    expect(s.tabs[0].dirty).toBe(false)
    expect(announceMock).toHaveBeenCalledWith(t('tabs.savedAsCopy', { path: COPY }))
  })

  it('cancelling the dialog keeps the text in the editor, tab still dirty', async () => {
    const s = await openProtectedNote()
    saveFileDialogMock.mockResolvedValue(null)

    await s.saveActive()

    expect(written).toEqual([])
    expect(s.tabs[0].path).toBe(RO)
    expect(s.tabs[0].content).toBe('typed while the file was protected')
    expect(s.tabs[0].dirty).toBe(true)
  })

  it('a copy that is itself refused is reported, not retried forever', async () => {
    const s = await openProtectedNote()
    saveFileDialogMock.mockResolvedValue('/vault/also-read-only.md')
    seedWrites([RO, '/vault/also-read-only.md'])

    await s.saveActive()

    expect(notifyErrorMock).toHaveBeenCalledWith(
      t('tabs.saveBlockedReadOnly', { path: '/vault/also-read-only.md' }),
    )
    // The write to the copy was attempted once — the refusal is not answered by
    // a second dialog.
    expect(saveFileDialogMock).toHaveBeenCalledTimes(1)
    expect(s.tabs[0].path).toBe(RO)
    expect(s.tabs[0].dirty).toBe(true)
  })

  it('a refused first save leaves an untitled tab untitled', async () => {
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab(null, '')
    const tab = s.tabs[0]
    tab.content = 'text with nowhere to go'
    s.markDirty(tab.id)
    // The user picks the protected note as the destination, and then declines
    // the copy the refusal offers.
    saveFileDialogMock.mockResolvedValueOnce(RO).mockResolvedValue(null)

    await s.saveActive()

    expect(written).toEqual([])
    // The pick bound the tab to a file this save never wrote — and never read.
    // Left standing, it would make `savedContent` of '' a claim that the note on
    // disk is empty, and aim the next save at a destination chosen for a write
    // that never happened.
    expect(tab.path).toBeNull()
    expect(tab.savedContent).toBe('')
    expect(tab.dirty).toBe(true)
    expect(tab.content).toBe('text with nowhere to go')
  })

  it('an ordinary write failure still says "please retry"', async () => {
    readMock.mockResolvedValue('on disk')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab(RO)
    s.tabs[0].content = 'edited'
    s.markDirty(s.tabs[0].id)
    writeMock.mockRejectedValue(new Error('disk full'))

    await s.saveActive()

    expect(notifyErrorMock).toHaveBeenCalledWith(t('tabs.saveFailed'))
    // A failure the user can act on is not answered with a Save-As dialog.
    expect(saveFileDialogMock).not.toHaveBeenCalled()
  })
})

describe('a refusal that is not about the file at all', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    readMock.mockReset()
    writeMock.mockReset()
    saveFileDialogMock.mockReset()
    notifyErrorMock.mockReset()
    announceMock.mockReset()
    seedWrites()
  })

  // The refused-document marker is module state, and it outlives the test that
  // set it.
  afterEach(() => {
    clearRefusedDocument()
  })

  it('a document the model refused keeps its own message, and never takes the copy route', async () => {
    // The unrenderable refusal is decided BEFORE the write and keys on the tab
    // holding exactly the text the model failed to load. It has to keep saying
    // what it says, and it deliberately has no copy route: the editor cannot
    // vouch for what it would write, so it will not write it anywhere — the way
    // out there is the source pane, whose edits are the user's own text (see
    // `tab-save-refused-parse.test.ts`).
    readMock.mockResolvedValue('the text that failed')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab(RO)
    const tab = s.tabs[0]
    tab.dirty = true
    markRefusedDocument(tab.content)

    await s.saveActive()

    expect(notifyErrorMock).toHaveBeenCalledWith(t('tabs.saveBlockedUnrenderable'))
    expect(notifyErrorMock).not.toHaveBeenCalledWith(
      t('tabs.saveBlockedReadOnlyCopy', { path: RO }),
    )
    expect(saveFileDialogMock).not.toHaveBeenCalled()
    expect(written).toEqual([])
    expect(tab.content).toBe('the text that failed')
  })
})

describe('the window close after a refused save', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    readMock.mockReset()
    writeMock.mockReset()
    saveFileDialogMock.mockReset()
    notifyErrorMock.mockReset()
    announceMock.mockReset()
    seedWrites()
  })

  /** The trap in one place: a dirty tab over a file that refuses the write. */
  async function openDirtyProtectedNote(): Promise<ReturnType<typeof useTabsStore>> {
    readMock.mockResolvedValue('on disk')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab(RO)
    s.tabs[0].content = 'typed while the file was protected'
    s.markDirty(s.tabs[0].id)
    return s
  }

  it('flushDirty refuses while the file does — the trap', async () => {
    const s = await openDirtyProtectedNote()

    // This is the gate the window close goes through (`app-lifecycle.ts`).
    await expect(s.flushDirty()).resolves.toBe(false)
    expect(s.hasUnsavedWork()).toBe(true)
  })

  it('the copy route unblocks it: the same flush succeeds once the text is somewhere', async () => {
    const s = await openDirtyProtectedNote()

    await expect(s.flushDirty()).resolves.toBe(false)

    // The way out the refusal names: Ctrl+S asks again, and this time the save
    // may put the text under a name the user chooses.
    saveFileDialogMock.mockResolvedValue(COPY)
    await s.saveActive()
    expect(written).toEqual([{ path: COPY, content: 'typed while the file was protected' }])

    // The close gate is now open, and the protected note is untouched.
    await expect(s.flushDirty()).resolves.toBe(true)
    expect(s.hasUnsavedWork()).toBe(false)
  })
})
