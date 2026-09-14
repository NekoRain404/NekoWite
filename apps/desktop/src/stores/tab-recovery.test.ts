import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { onRecovery } from '../services/errors'
import type { RecoveryPrompt } from '../services/errors'
import { useTabsStore } from './tabs'
import { t } from '../i18n'
import { READ_ONLY_PREFIX } from './write-refusal'

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

function resetFsMocks(): void {
  notifyErrorMock.mockReset()
  readMock.mockReset()
  writeMock.mockReset()
  deleteFileMock.mockReset()
  statMock.mockReset()
  listHistoryMock.mockReset()
  readHistoryMock.mockReset()
  restoreHistoryMock.mockReset()
  createDirMock.mockReset()
  renameEntryMock.mockReset()
  saveFileDialogMock.mockReset()
}

describe('restoreHistoryToActive', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('restores a version into the tab and clears dirty', async () => {
    readMock.mockResolvedValue('abc')
    restoreHistoryMock.mockResolvedValue('restored')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    tab.content = 'dirty'
    s.markDirty(tab.id)
    const result = await s.restoreHistoryToActive(tab.id, 'v1')
    expect(result).toBe('restored')
    expect(restoreHistoryMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'v1')
    expect(tab.content).toBe('restored')
    expect(tab.savedContent).toBe('restored')
    expect(tab.dirty).toBe(false)
  })
})

/**
 * A restore onto a read-only note is refused by the same deliberate backend
 * rule that refuses a save over one, and it has to say so. "Failed to restore
 * the historical version" names neither the reason nor the fact that nothing
 * was touched, and invites a retry the protected file will refuse every time.
 */
describe('a restore refused because the file is read-only', () => {
  const RO = '/vault/ro.md'
  const REFUSAL =
    `${READ_ONLY_PREFIX}could not replace ${RO}: the file is read-only (mode 0444), ` +
    'so it was left untouched; clear the read-only permission to save over it, or ' +
    'save it under a different name'

  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('names the reason and keeps the text that was there', async () => {
    readMock.mockResolvedValue('abc')
    restoreHistoryMock.mockRejectedValue(REFUSAL)
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab(RO)
    const tab = s.tabs[0]

    const result = await s.restoreHistoryToActive(tab.id, 'v1')

    expect(result).toBeNull()
    expect(notifyErrorMock).toHaveBeenCalledWith(t('tabs.restoreBlockedReadOnly', { path: RO }))
    expect(notifyErrorMock).not.toHaveBeenCalledWith(t('tabs.restoreHistoryFailed'))
    // A refusal writes nothing, so the tab keeps exactly what it had.
    expect(tab.content).toBe('abc')
    expect(tab.savedContent).toBe('abc')
    expect(tab.dirty).toBe(false)
  })

  it('an ordinary restore failure still reads as a failure', async () => {
    readMock.mockResolvedValue('abc')
    restoreHistoryMock.mockRejectedValue(new Error('history is gone'))
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab(RO)

    await s.restoreHistoryToActive(s.tabs[0].id, 'v1')

    expect(notifyErrorMock).toHaveBeenCalledWith(t('tabs.restoreHistoryFailed'))
    expect(notifyErrorMock).not.toHaveBeenCalledWith(
      t('tabs.restoreBlockedReadOnly', { path: RO }),
    )
  })

  it('leaves the window closable: the refusal dirties nothing to flush', async () => {
    readMock.mockResolvedValue('abc')
    restoreHistoryMock.mockRejectedValue(REFUSAL)
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab(RO)

    await s.restoreHistoryToActive(s.tabs[0].id, 'v1')

    // `app-lifecycle` only blocks the close while `flushDirty()` has work it
    // cannot finish. A refused restore creates none, so the X keeps working —
    // and if the note was already dirty for another reason, the save path's own
    // copy route is what unblocks it.
    expect(s.hasUnsavedWork()).toBe(false)
    await expect(s.flushDirty()).resolves.toBe(true)
  })
})

describe('checkCrashRecovery', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('returns the newest history entry when it is newer than the file', async () => {
    readMock.mockResolvedValue('abc')
    listHistoryMock.mockResolvedValue([{ id: 'snap-1', size: 3, mtime: 200 }])
    statMock.mockResolvedValue({ size: 3, mtime: 100 })
    // A crash snapshot that genuinely differs from the disk content.
    readHistoryMock.mockResolvedValue('abcd')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    const entry = await s.checkCrashRecovery(tab.id)
    expect(entry).toEqual({ id: 'snap-1', size: 3, mtime: 200 })
  })

  it('returns null when the newest snapshot matches the disk content', async () => {
    // An interrupted atomic write leaves a newest snapshot that is
    // byte-identical to the file — "recovering" it is a no-op and must not
    // surface a prompt.
    readMock.mockResolvedValue('abc')
    listHistoryMock.mockResolvedValue([{ id: 'snap-1', size: 3, mtime: 200 }])
    statMock.mockResolvedValue({ size: 3, mtime: 100 })
    readHistoryMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    expect(await s.checkCrashRecovery(tab.id)).toBeNull()
  })

  it('returns null when the file is at least as new as the newest history', async () => {
    readMock.mockResolvedValue('abc')
    listHistoryMock.mockResolvedValue([{ id: 'snap-1', size: 3, mtime: 100 }])
    statMock.mockResolvedValue({ size: 3, mtime: 200 })
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    expect(await s.checkCrashRecovery(tab.id)).toBeNull()
  })
})

describe('openTab crash-recovery prompt', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('surfaces a recovery prompt and restoring rewrites the tab from history', async () => {
    readMock.mockResolvedValue('abc')
    listHistoryMock.mockResolvedValue([{ id: 'snap-1', size: 3, mtime: 500 }])
    statMock.mockResolvedValue({ size: 3, mtime: 200 })
    readHistoryMock.mockResolvedValue('unsaved snapshot content')
    restoreHistoryMock.mockResolvedValue('recovered')

    const prompts: RecoveryPrompt[] = []
    const offRecovery = onRecovery((p) => prompts.push(p))
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    const prompt = prompts[0]
    expect(prompt.message).toContain('未保存的更改')
    expect(prompt.message).toContain('恢复最近版本')
    prompt.onRestore()
    await vi.waitFor(() => expect(s.tabs[0].content).toBe('recovered'))
    expect(restoreHistoryMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'snap-1')
    expect(s.tabs[0].dirty).toBe(false)
    offRecovery()
  })
})
