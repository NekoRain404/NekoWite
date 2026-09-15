/**
 * A `.tmp/…` string in a note's PROSE is a mention, not a reference, and a
 * mention may not rename anything.
 *
 * The relocation derived its work set from the note body by matching the
 * substring `.tmp/…` anywhere in the text. So a note that only talks about the
 * feature — "The app keeps pasted images in `.tmp/` until the note is saved." —
 * renamed a file on EVERY save, and the `endsWith('/')` guard written for that
 * very sentence was defeated by the backtick around it: the backtick is not in
 * the excluded character class, so the match ran on into it and the rename
 * target became a file named `` ` ``. The rename rejected (ENOENT), the pair was
 * written back, the "could not move the image" toast fired on every save and
 * every autosave with nothing the user could do to end it, and the destination
 * directory was created as a side effect.
 *
 * The worse shape is the second test: when the prose names a file that IS in
 * `.tmp` — staged by ANOTHER note — the old derivation moved it into this note's
 * assets directory and rewrote this note's sentence, which left the note that
 * actually pasted it pointing at a file that is no longer there.
 *
 * Both are driven through a real save, because that is where the damage was
 * visible: the rename, the toast and the directory are the save's, not the
 * relocation's alone.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { t } from '../i18n'
import { useTabsStore } from './tabs'
import { tmpRefsInContent } from './tab-assets'

const notifyErrorMock = vi.hoisted(() => vi.fn())
vi.mock('../services/errors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/errors')>()),
  notifyError: notifyErrorMock,
}))

const readMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())
const deleteFileMock = vi.hoisted(() => vi.fn())
const statMock = vi.hoisted(() => vi.fn())
const listHistoryMock = vi.hoisted(() => vi.fn())
const restoreHistoryMock = vi.hoisted(() => vi.fn())
const readHistoryMock = vi.hoisted(() => vi.fn())
const createDirMock = vi.hoisted(() => vi.fn())
const renameEntryMock = vi.hoisted(() => vi.fn())
const saveFileDialogMock = vi.hoisted(() => vi.fn())
vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: writeMock,
    list: vi.fn(),
    watch: vi.fn(),
    deleteFile: deleteFileMock,
    stat: statMock,
    listHistory: listHistoryMock,
    readHistory: readHistoryMock,
    restoreHistory: restoreHistoryMock,
    createDir: createDirMock,
    renameEntry: renameEntryMock,
    saveFileDialog: saveFileDialogMock,
  },
}))

const VAULT = '/vault'
const NOTE = '/vault/notes/foo.md'
const OTHER = '/vault/notes/bar.md'
const SAVED_TOAST = t('tabs.saveAttachmentFailed')

/** The sentence from the finding, backticks and all. */
const PROSE = 'The app keeps pasted images in `.tmp/` until the note is saved.\n'
/** The same mention, with no backticks — the shape the old pattern matched
 *  exactly, because the next character was a space. */
const PROSE_NAMING_A_FILE = 'It landed in .tmp/paste-1.png and was never moved.\n'

/** Vault-relative key for a path that may arrive in either spelling. */
function rel(path: string): string {
  const norm = path.replace(/\\/g, '/')
  return norm.startsWith(`${VAULT}/`) ? norm.slice(VAULT.length + 1) : norm
}

interface FakeVault {
  files: Map<string, string>
  /** Every rename that was attempted, in order. */
  moves: Array<[string, string]>
}

function installFakeFs(disk: FakeVault): void {
  readMock.mockImplementation(async (_vault: string, path: string): Promise<string> => {
    const content = disk.files.get(rel(path))
    if (content === undefined) throw new Error(`No such file: ${path}`)
    return content
  })
  writeMock.mockImplementation(
    async (_vault: string, path: string, content: string): Promise<string | null> => {
      disk.files.set(rel(path), content)
      return null
    },
  )
  statMock.mockImplementation(
    async (_vault: string, path: string): Promise<{ size: number; mtime: number }> => {
      const content = disk.files.get(rel(path))
      if (content === undefined) throw new Error(`No such file: ${path}`)
      return { size: content.length, mtime: 0 }
    },
  )
  createDirMock.mockImplementation(async (_vault: string, path: string): Promise<string> => path)
  renameEntryMock.mockImplementation(
    async (_vault: string, from: string, to: string): Promise<string> => {
      disk.moves.push([from, to])
      const content = disk.files.get(from)
      if (content === undefined) throw new Error(`not found: ${from}`)
      if (disk.files.has(to)) throw new Error(`target already exists: ${to}`)
      disk.files.delete(from)
      disk.files.set(to, content)
      return to
    },
  )
}

function fakeVault(seed: Record<string, string>): FakeVault {
  const disk: FakeVault = { files: new Map(Object.entries(seed)), moves: [] }
  installFakeFs(disk)
  return disk
}

/** The relocation's own toast, by message: the save says other things too. */
const toasts = () =>
  notifyErrorMock.mock.calls.filter(([message]) => message === SAVED_TOAST).length

/** Directories the save created, by name. */
const createdDirs = () => createDirMock.mock.calls.map(([, path]) => String(path))

/** Whether anything asked the disk about a staged asset at all. */
const tmpStats = () =>
  statMock.mock.calls.filter(([, path]) => String(path).includes('.tmp')).length

beforeEach(() => {
  setActivePinia(createPinia())
  notifyErrorMock.mockReset()
  for (const m of [
    readMock,
    writeMock,
    deleteFileMock,
    statMock,
    listHistoryMock,
    readHistoryMock,
    restoreHistoryMock,
    createDirMock,
    renameEntryMock,
    saveFileDialogMock,
  ]) {
    m.mockReset()
  }
})

describe('a note that only mentions the temp directory', () => {
  it('is not touched by a save: no rename, no toast, no assets directory', async () => {
    const disk = fakeVault({ 'notes/foo.md': PROSE })

    const s = useTabsStore()
    s.setVault(VAULT)
    await s.openTab(NOTE)
    await s.saveActive()

    // One assertion, because on the pre-fix tree what the save DID is the whole
    // of the evidence and vitest prints the first failing one only. Pre-fix it
    // reads: `moves: [['.tmp/`', 'notes/foo_assets/`']]` — the match ran from
    // `.tmp/` into the backtick, so the rename target is a file named `` ` `` —
    // with the destination directory created anyway (the stray `foo_assets/`
    // the user is left looking at) and the toast about an image that could not
    // be moved fired for a note that has no image.
    expect({
      moves: disk.moves,
      createdDirs: createdDirs(),
      toasts: toasts(),
      askedAboutStagedFiles: tmpStats(),
      tabContent: s.tabs[0].content,
      onDisk: disk.files.get('notes/foo.md'),
    }).toEqual({
      moves: [],
      createdDirs: [],
      toasts: 0,
      askedAboutStagedFiles: 0,
      tabContent: PROSE,
      onDisk: PROSE,
    })
  })
})

describe("another note's staged file, named by this note's prose", () => {
  it('stays where the note that pasted it says it is', async () => {
    const disk = fakeVault({
      'notes/foo.md': PROSE_NAMING_A_FILE,
      [OTHER]: '![pic](.tmp/paste-1.png)\n',
      '.tmp/paste-1.png': 'image bytes',
    })

    const s = useTabsStore()
    s.setVault(VAULT)
    await s.openTab(NOTE)
    await s.saveActive()

    // Pre-fix the file is moved into `notes/foo_assets/` and `foo.md`'s sentence
    // is rewritten to point at it — while `bar.md`, the note that pasted it,
    // still says `.tmp/paste-1.png` and now shows a broken image. The mention
    // here carries no backticks precisely so the old pattern matches the file
    // name exactly and the move really lands.
    expect({
      moves: disk.moves,
      stagedFile: disk.files.get('.tmp/paste-1.png'),
      theNoteThatPastedIt: disk.files.get(OTHER),
      theNoteThatMentionedIt: disk.files.get('notes/foo.md'),
      toasts: toasts(),
    }).toEqual({
      moves: [],
      stagedFile: 'image bytes',
      theNoteThatPastedIt: '![pic](.tmp/paste-1.png)\n',
      theNoteThatMentionedIt: PROSE_NAMING_A_FILE,
      toasts: 0,
    })
  })
})

describe("the app's own insert form, in the same note", () => {
  it('still relocates the file and rewires the reference', async () => {
    // No staged list: the note was restored by path (`pendingAssetPaths: []`),
    // so the body is the only thing that can say what is outstanding — which is
    // what the bound must not break.
    const disk = fakeVault({
      'notes/foo.md': '![pic](.tmp/paste-1.png)\n',
      '.tmp/paste-1.png': 'image bytes',
    })

    const s = useTabsStore()
    s.setVault(VAULT)
    await s.openTab(NOTE)
    expect(s.tabs[0].pendingAssetPaths).toEqual([])
    await s.saveActive()

    expect(disk.moves).toEqual([['.tmp/paste-1.png', 'notes/foo_assets/paste-1.png']])
    expect(disk.files.has('.tmp/paste-1.png')).toBe(false)
    expect(disk.files.get('notes/foo_assets/paste-1.png')).toBe('image bytes')
    expect(s.tabs[0].content).toBe('![pic](foo_assets/paste-1.png)\n')
    expect(disk.files.get('notes/foo.md')).toBe('![pic](foo_assets/paste-1.png)\n')
    expect(toasts()).toBe(0)
  })
})

describe('what counts as a reference', () => {
  it('is the image destination, and never a mention of the path', () => {
    // The app's own writes, in the shapes CommonMark allows.
    expect(tmpRefsInContent('![a](.tmp/pic.png)')).toEqual(['.tmp/pic.png'])
    expect(tmpRefsInContent('![a](.tmp/pic.png "title")')).toEqual(['.tmp/pic.png'])
    expect(tmpRefsInContent('![a](<.tmp/pic 1.png>)')).toEqual(['.tmp/pic 1.png'])

    // Mentions: inline code, a bare path, a link, a directory.
    expect(tmpRefsInContent(PROSE)).toEqual([])
    expect(tmpRefsInContent('see `.tmp/pic.png` for the staged copy')).toEqual([])
    expect(tmpRefsInContent('it went to .tmp/pic.png yesterday')).toEqual([])
    expect(tmpRefsInContent('a link: [x](.tmp/pic.png)')).toEqual([])
    expect(tmpRefsInContent('![x](.tmp/dir/)')).toEqual([])
    // A destination that merely CONTAINS a `.tmp/…` run is not under `.tmp/`
    // itself — the old substring match took the tail of it for a staged path.
    expect(tmpRefsInContent('![x](notes/.tmp/pic.png)')).toEqual([])
  })
})
