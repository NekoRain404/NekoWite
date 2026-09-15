/**
 * The relocation's idea of "outstanding" used to die with the process, and a
 * move that landed but was not reported used to be retried forever (the two L07
 * residuals `521e6a3` named and left).
 *
 * Shape A, end to end: an image pasted into an untitled note, a first save whose
 * move fails, a restart. The stored session is a list of paths, so the restored
 * tab has `pendingAssetPaths: []` while its body — read back from disk — still
 * says `.tmp/pic.png`. `tab-save.ts` only called the relocation when the list was
 * non-empty, so an empty list meant "do not look" and the image never moved
 * again. The body is where that state survives, and it is what the tests below
 * drive the repair from.
 *
 * Shape B: `renameEntry` is an IPC command, so a rename that landed on disk and
 * whose response was lost rejects like any other failure. Believing the throw
 * retries a source that is no longer there, once per save, for the life of the
 * note — with a toast the user cannot act on.
 *
 * The GC question the brief makes mandatory is measured in the last block, and
 * it decides the severity: `referencedTmpPaths()` is only the OPEN-tab half of
 * the app's "not orphaned" predicate (`app-bootstrap.ts` unions it with a
 * vault-wide scan of every note on disk), so the measurement is taken twice —
 * with and without that other half.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createTmpRecovery } from '../app/recovery-closed-loop'
import { scanTmpReferences } from '../services/tmp-references'
import { t } from '../i18n'
import { useTabsStore } from './tabs'
import { createTabAssets } from './tab-assets'
import type { OpenTab } from './tabs'

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
const SAVED_TOAST = t('tabs.saveAttachmentFailed')

/** Vault-relative key for a path that may arrive in either spelling: `relocate`
 *  is handed vault-relative asset paths and the fs port is handed absolute ones. */
function rel(path: string): string {
  const norm = path.replace(/\\/g, '/')
  return norm.startsWith(`${VAULT}/`) ? norm.slice(VAULT.length + 1) : norm
}

/**
 * One map standing in for the vault, answering the store's fs port — so the
 * text a save reads, the text it writes and the file an image moves to are the
 * same file, as they are on disk.
 */
interface FakeVault {
  files: Map<string, string>
  /** Every rename that was attempted, in order. */
  moves: Array<[string, string]>
  /** The fault injected for a source, read by the port below. */
  faultsOf(from: string): 'refuse' | 'after' | undefined
  /** Refuse the move of `from` without touching the disk (a transient). */
  failMovesOf(from: string): void
  /** Move `from` and THEN reject — an IPC whose response was lost. */
  failAfterMoving(from: string): void
  clearFaults(): void
}

function fakeVault(seed: Record<string, string>): FakeVault {
  const files = new Map(Object.entries(seed))
  const moves: Array<[string, string]> = []
  const faults = new Map<string, 'refuse' | 'after'>()
  return {
    files,
    moves,
    faultsOf: (from) => faults.get(from),
    failMovesOf: (from) => void faults.set(from, 'refuse'),
    failAfterMoving: (from) => void faults.set(from, 'after'),
    clearFaults: () => faults.clear(),
  }
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
      const fault = disk.faultsOf(from)
      if (fault === 'refuse') throw new Error(`injected fault moving ${from}`)
      const content = disk.files.get(from)
      if (content === undefined) throw new Error(`not found: ${from}`)
      if (disk.files.has(to)) throw new Error(`target already exists: ${to}`)
      disk.files.delete(from)
      disk.files.set(to, content)
      // The move HAPPENED; the caller is told it did not. This is Shape B.
      if (fault === 'after') throw new Error(`ipc closed after moving ${from}`)
      return to
    },
  )
}

function stagedTab(content: string, pending: string[]): OpenTab {
  return {
    id: 't1',
    path: null,
    content,
    savedContent: '',
    dirty: false,
    pendingAssetPaths: pending,
  }
}

function assetsHarness(port: {
  createDir(vault: string, path: string): Promise<string>
  renameEntry(vault: string, from: string, to: string): Promise<string>
  stat(vault: string, path: string): Promise<{ size: number; mtime: number }>
}) {
  const errors: string[] = []
  return {
    errors,
    assets: createTabAssets({
      files: port,
      t: (key) => key,
      notifyError: (message) => errors.push(message),
    }),
  }
}

/** The port a fake vault offers, on its own (no store, no gateway). */
function portFor(disk: FakeVault) {
  installFakeFs(disk)
  return {
    createDir: async (_vault: string, path: string) => path,
    renameEntry: async (_vault: string, from: string, to: string) => {
      return await renameEntryMock(_vault, from, to)
    },
    stat: async (_vault: string, path: string) => await statMock(_vault, path),
  }
}

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

describe('Shape A — a note whose image never moved, restored from a session', () => {
  it('moves the image on the next save, with no list to tell it to', async () => {
    const disk = fakeVault({
      '.tmp/pic.png': 'image bytes',
      'notes/foo.md': '',
    })
    installFakeFs(disk)
    saveFileDialogMock.mockImplementation(async (): Promise<string> => NOTE)

    const s = useTabsStore()
    s.setVault(VAULT)
    // 1. Paste into an untitled note: the file lands in `.tmp/` and the body —
    //    and the tab's staged list — reference it (use-image-intake.ts).
    await s.openTab(null, '![pic](.tmp/pic.png)\n')
    const first = s.tabs[0]
    first.pendingAssetPaths.push('.tmp/pic.png')
    s.markDirty(first.id)

    // 2. The first save. Its rename fails (a transient the loop already expects),
    //    so the text is written, the tab gets a path, and the pair stays staged.
    disk.failMovesOf('.tmp/pic.png')
    await s.saveActive()
    expect(disk.files.get('notes/foo.md')).toBe('![pic](.tmp/pic.png)\n')
    expect(first.pendingAssetPaths).toEqual(['.tmp/pic.png'])

    // 3/4. The app closes and reopens. The session is a list of paths, so the
    //      list this pair was in does not survive; the body does.
    s.captureSession()
    s.removeAllTabs()
    disk.clearFaults()
    await s.restoreSession()
    const tab = s.tabs[0]
    expect(tab.path).toBe(NOTE)
    expect(tab.content).toBe('![pic](.tmp/pic.png)\n')
    expect(tab.pendingAssetPaths).toEqual([])

    // 5. The next save. Nothing remembers the pair — the note says so itself.
    const attemptsBefore = disk.moves.length
    await s.saveActive()

    // Only this save's attempt, and it is the pair the body names.
    expect(disk.moves.slice(attemptsBefore)).toEqual([['.tmp/pic.png', 'notes/foo_assets/pic.png']])
    expect(disk.files.has('.tmp/pic.png')).toBe(false)
    expect(disk.files.get('notes/foo_assets/pic.png')).toBe('image bytes')
    expect(s.tabs[0].content).toBe('![pic](foo_assets/pic.png)\n')
    // The rewrite is what was written: the file and the tab agree.
    expect(disk.files.get('notes/foo.md')).toBe('![pic](foo_assets/pic.png)\n')
    expect(s.tabs[0].pendingAssetPaths).toEqual([])
  })

  it('leaves a note with nothing staged alone: no port call at all', async () => {
    const disk = fakeVault({ 'notes/foo.md': '# ordinary\n' })
    installFakeFs(disk)

    const s = useTabsStore()
    s.setVault(VAULT)
    await s.openTab(NOTE)
    await s.saveActive()

    expect(disk.moves).toEqual([])
    expect(createDirMock).not.toHaveBeenCalled()
    // Nothing asked the disk about a staged asset. (`stat` IS called once, by
    // openTab's crash-recovery probe, for the note itself — the relocation must
    // not add a second question.)
    expect(statMock.mock.calls.filter(([, p]) => String(p).includes('.tmp'))).toEqual([])
  })
})

describe('Shape B — a move that landed and was reported as a failure', () => {
  /** The state Shape B describes: the rename ran, then its response was lost. */
  async function movedButReportedAsFailed() {
    const disk = fakeVault({ '.tmp/pic.png': 'image bytes', 'notes/foo.md': '' })
    installFakeFs(disk)
    saveFileDialogMock.mockImplementation(async (): Promise<string> => NOTE)
    const s = useTabsStore()
    s.setVault(VAULT)
    await s.openTab(null, '![pic](.tmp/pic.png)\n')
    const tab = s.tabs[0]
    tab.pendingAssetPaths.push('.tmp/pic.png')
    s.markDirty(tab.id)
    disk.failAfterMoving('.tmp/pic.png')
    await s.saveActive()
    return { disk, tab, s }
  }

  const toasts = () => notifyErrorMock.mock.calls.filter(([m]) => m === SAVED_TOAST).length

  it('drops the pair and rewires the note when the move landed anyway', async () => {
    const { disk, tab } = await movedButReportedAsFailed()

    // The file moved, so the note must stop pointing at where it was.
    expect(disk.files.has('.tmp/pic.png')).toBe(false)
    expect(disk.files.get('notes/foo.md')).toBe('![pic](foo_assets/pic.png)\n')
    expect(tab.pendingAssetPaths).toEqual([])
    // The source is gone and the destination is there: this is not a failure,
    // and the user is not told about a move that worked.
    expect(toasts()).toBe(0)
  })

  it('does not retry it on the next save, and does not tell the user again', async () => {
    const { disk, s } = await movedButReportedAsFailed()

    await s.saveActive()

    // Nothing to tell the user: the toast they can never resolve is the one
    // this assert exists for. Pre-fix it has fired twice by now.
    expect(toasts()).toBe(0)
    // One attempt, the one that moved the file. Pre-fix this is two: the second
    // save retries a source that is no longer there.
    expect(disk.moves).toHaveLength(1)
  })

  it('does not mistake an occupied destination for a completed move', async () => {
    const disk = fakeVault({
      '.tmp/pic.png': 'image bytes',
      'notes/foo_assets/pic.png': 'a different image',
      'notes/foo.md': '',
    })
    installFakeFs(disk)
    const { assets, errors } = assetsHarness(portFor(disk))
    const tab = stagedTab('![pic](.tmp/pic.png)\n', ['.tmp/pic.png'])

    await assets.relocate(tab, VAULT, NOTE)

    // Refused, not replaced and not renamed around: the source is still there,
    // so this is not a move that happened.
    expect(disk.files.get('.tmp/pic.png')).toBe('image bytes')
    expect(tab.content).toBe('![pic](.tmp/pic.png)\n')
    expect(tab.pendingAssetPaths).toEqual(['.tmp/pic.png'])
    expect(errors).toEqual(['tabs.saveAttachmentFailed'])
  })

  it('keeps a reference to nothing in the note, and keeps saying so', async () => {
    // No source and no destination: the image is at neither end. Deleting the
    // user's prose about it would be worse than the toast they can act on.
    const disk = fakeVault({ 'notes/foo.md': '![pic](.tmp/gone.png)\n' })
    installFakeFs(disk)
    const { assets, errors } = assetsHarness(portFor(disk))
    const tab = stagedTab('![pic](.tmp/gone.png)\n', [])

    await assets.relocate(tab, VAULT, NOTE)

    expect(tab.content).toBe('![pic](.tmp/gone.png)\n')
    expect(tab.pendingAssetPaths).toEqual(['.tmp/gone.png'])
    expect(errors).toEqual(['tabs.saveAttachmentFailed'])
  })
})

describe("the relocation's outstanding set", () => {
  it('L07: a pair behind a failed one still moves, and the retry starts from what is outstanding', async () => {
    const disk = fakeVault({ '.tmp/a.png': 'a', '.tmp/b.png': 'b' })
    const { assets, errors } = assetsHarness(portFor(disk))
    const tab = stagedTab('![a](.tmp/a.png)\n\n![b](.tmp/b.png)\n', ['.tmp/a.png', '.tmp/b.png'])

    disk.failMovesOf('.tmp/a.png')
    await assets.relocate(tab, VAULT, NOTE)

    expect([...disk.files.keys()].sort()).toEqual(['.tmp/a.png', 'notes/foo_assets/b.png'])
    expect(tab.content).toBe('![a](.tmp/a.png)\n\n![b](foo_assets/b.png)\n')
    expect(tab.pendingAssetPaths).toEqual(['.tmp/a.png'])
    expect(errors).toEqual(['tabs.saveAttachmentFailed'])

    disk.clearFaults()
    await assets.relocate(tab, VAULT, NOTE)

    expect([...disk.files.keys()].sort()).toEqual(['notes/foo_assets/a.png', 'notes/foo_assets/b.png'])
    expect(tab.content).toBe('![a](foo_assets/a.png)\n\n![b](foo_assets/b.png)\n')
    expect(tab.pendingAssetPaths).toEqual([])
    // The loop did not start over: `a` was attempted twice, `b` exactly once.
    expect(disk.moves.filter(([from]) => from === '.tmp/a.png')).toHaveLength(2)
    expect(disk.moves.filter(([from]) => from === '.tmp/b.png')).toHaveLength(1)
  })

  it('still moves a staged file the body never managed to reference', async () => {
    // The paste inserted nothing (`attachments.editorNotReady`), so the file is
    // staged and in the list while the body has no ref for it. Deriving the
    // outstanding set from the body ALONE would strand it in `.tmp/`, where the
    // recovery GC eventually deletes it as an orphan.
    const disk = fakeVault({ '.tmp/pic.png': 'image bytes' })
    const { assets } = assetsHarness(portFor(disk))
    const tab = stagedTab('text with no image\n', ['.tmp/pic.png'])

    await assets.relocate(tab, VAULT, NOTE)

    expect(disk.files.has('.tmp/pic.png')).toBe(false)
    expect(disk.files.get('notes/foo_assets/pic.png')).toBe('image bytes')
    expect(tab.content).toBe('text with no image\n')
    expect(tab.pendingAssetPaths).toEqual([])
  })

  it('ignores a `.tmp/` ref that names a directory rather than a file', async () => {
    const disk = fakeVault({ 'notes/foo.md': 'see ![x](.tmp/dir/)\n' })
    const { assets } = assetsHarness(portFor(disk))
    const tab = stagedTab('see ![x](.tmp/dir/)\n', [])

    // `moveAttachments` refuses a pair whose file name is empty, and a throw out
    // of `relocate` is a throw out of the save transaction.
    await expect(assets.relocate(tab, VAULT, NOTE)).resolves.toBe(false)
    expect(disk.moves).toEqual([])
  })
})

/**
 * The measurement the brief makes mandatory, and it sets the severity.
 *
 * `referencedTmpPaths()` is the OPEN-tab half of the app's "not orphaned"
 * predicate. The app's own provider (`app-bootstrap.ts`) unions it with
 * `services/tmp-references`' vault-wide scan of every note on disk, so what the
 * user's image meets when the note is CLOSED is that union — and the two halves
 * give different answers, which is the point of measuring both.
 */
describe('the recovery GC, with the note closed', () => {
  const DAY = 24 * 60 * 60 * 1000
  const NOW = Date.UTC(2026, 8, 15)
  /** Staged 30 days ago: past the 7-day GC threshold either way. */
  const STAGED_AT = NOW - 30 * DAY
  /** The vault: the note on disk (closed) and the staged image it points at. */
  const DISK: Record<string, string> = {
    'notes/foo.md': '![pic](.tmp/pic.png)\n',
    '.tmp/pic.png': 'image bytes',
  }

  function gcVault() {
    const files = new Map(Object.entries(DISK))
    const deletions: string[] = []
    return {
      files,
      deletions,
      fs: {
        list: async (_vault: string, dir: string) =>
          dir === '.tmp' && files.has('.tmp/pic.png')
            ? [{ name: 'pic.png', path: '.tmp/pic.png', is_dir: false, is_mdx: false }]
            : [],
        // Absolute, and rejecting when it is not there: the shape both real
        // backends have (`stat_file` rejects on a missing path).
        stat: async (_vault: string, path: string): Promise<{ size: number; mtime: number }> => {
          const content = files.get(rel(path))
          if (content === undefined) throw new Error(`No such file: ${path}`)
          return { size: content.length, mtime: rel(path) === '.tmp/pic.png' ? STAGED_AT : NOW }
        },
        deleteFile: async (_vault: string, path: string): Promise<string> => {
          deletions.push(rel(path))
          files.delete(rel(path))
          return path
        },
        renameEntry: async (_vault: string, from: string, to: string): Promise<string> => {
          const content = files.get(rel(from))
          if (content === undefined) throw new Error(`not found: ${rel(from)}`)
          files.delete(rel(from))
          files.set(rel(to), content)
          return to
        },
      },
    }
  }

  /** What the app unions before the GC sees it (`app-bootstrap.ts:94-103`). */
  function appProvider(files: Map<string, string>, notes: string[]) {
    return async (): Promise<{ paths: Set<string>; complete: boolean }> => {
      const open = useTabsStore().referencedTmpPaths()
      const onDisk = await scanTmpReferences(VAULT, {
        notes,
        read: async (_vault: string, path: string): Promise<string> => {
          const content = files.get(rel(path))
          if (content === undefined) throw new Error(`No such file: ${path}`)
          return content
        },
        isComplete: () => true,
      })
      return { paths: new Set([...open, ...onDisk.paths]), complete: onDisk.complete }
    }
  }

  it('deletes the image when only the OPEN tabs are consulted', async () => {
    // The brief's premise, measured: with the note closed, the open-tab set is
    // empty and the staged file is indistinguishable from crash litter.
    const vault = gcVault()
    const gc = createTmpRecovery({
      fs: vault.fs,
      getReferencedTmp: () => useTabsStore().referencedTmpPaths(),
      now: () => NOW,
      notify: () => {},
      notifyError: () => {},
    })

    expect(useTabsStore().tabs).toHaveLength(0)
    expect(await gc.gc(VAULT)).toBe(1)
    expect(vault.files.has('.tmp/pic.png')).toBe(false)
  })

  it('does NOT delete it once the vault-wide half is included: the note body protects it', async () => {
    const vault = gcVault()
    const gc = createTmpRecovery({
      fs: vault.fs,
      getReferencedTmp: appProvider(vault.files, [NOTE]),
      now: () => NOW,
      notify: () => {},
      notifyError: () => {},
    })

    expect(await gc.gc(VAULT)).toBe(0)
    expect(vault.deletions).toEqual([])
    expect(vault.files.get('.tmp/pic.png')).toBeDefined()
  })
})
