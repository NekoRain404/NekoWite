import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { onRecovery } from '../services/errors'
import type { RecoveryPrompt } from '../services/errors'
import { useTabsStore } from './tabs'

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
