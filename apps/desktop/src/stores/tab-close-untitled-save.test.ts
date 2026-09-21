/**
 * Closing a dirty untitled tab is a save the user asked for.
 *
 * `closeTab` is one of the callers allowed to let `saveTab` put a file dialog in
 * front of the user (`tab-save.ts`'s `mayNameNewFile`): they pressed the X on a
 * document that exists nowhere but memory, and "where should this go?" is the
 * question the save they mean has to ask. Ctrl+S already has this latitude, and
 * the untitled-tab rescue gets it from the answer the user gave its prompt.
 *
 * With the licence withheld the close would not be safer, it would be broken: a
 * path-less tab would write nothing, `saveUntilSettled` would answer false and
 * the X would leave the tab open with no dialog and no sentence — the inert X
 * this path already had once, for the placeholder. So both halves are asserted
 * here: the dialog is raised, and cancelling it keeps the text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
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

describe('closeTab on a dirty untitled tab', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('asks where the text should go, writes it there, and closes', async () => {
    writeMock.mockResolvedValue(null)
    saveFileDialogMock.mockResolvedValue('/vault/named.md')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab(null, 'typed and never named')
    const tab = s.tabs[0]
    s.markDirty(tab.id)

    await s.closeTab(tab.id)

    expect(saveFileDialogMock).toHaveBeenCalledWith('untitled.md', '/vault')
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/named.md', 'typed and never named', 10)
    expect(s.tabs).toHaveLength(0)
  })

  it('keeps the tab, and its text, when the user cancels the dialog', async () => {
    saveFileDialogMock.mockResolvedValue(null)
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab(null, 'typed and never named')
    const tab = s.tabs[0]
    s.markDirty(tab.id)

    await s.closeTab(tab.id)

    expect(writeMock).not.toHaveBeenCalled()
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].dirty).toBe(true)
    expect(s.tabs[0].content).toBe('typed and never named')
  })
})
