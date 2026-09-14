import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listTrashMock = vi.hoisted(() => vi.fn())

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    listTrash: listTrashMock,
    restoreFromTrash: vi.fn(),
    clearTrash: vi.fn(),
  },
}))

import { useSidebarTrash } from './use-sidebar-trash'
import type { TrashEntry } from '../../../platform/gateways/contracts'

/** A read the test settles by hand, so two of them can settle out of order. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function entry(name: string): TrashEntry {
  return {
    name,
    display_name: name,
    trash_path: `/trash/${name}`,
    original_path: `${name}`,
    is_dir: false,
  }
}

describe('useSidebarTrash vault scoping', () => {
  beforeEach(() => {
    listTrashMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the newer vault’s list when the previous vault’s read resolves after it', async () => {
    // The sidebar is mounted once per vault and `refreshTrash` runs on open,
    // after a restore and after a clear, so two reads overlap on a vault switch.
    // Without the guard the later-RESOLVING one won: vault A's entries rendered
    // under vault B, and Restore then posted a path of the vault that is no
    // longer open.
    const vaultA = deferred<TrashEntry[]>()
    const vaultB = deferred<TrashEntry[]>()
    listTrashMock
      .mockImplementationOnce(() => vaultA.promise)
      .mockImplementationOnce(() => vaultB.promise)

    let vault = '/vault-a'
    const trash = useSidebarTrash({ vault: () => vault })

    const first = trash.refreshTrash()
    vault = '/vault-b'
    const second = trash.refreshTrash()

    vaultB.resolve([entry('b-deleted.md')])
    await second
    expect(trash.trashEntries.value.map((e) => e.name)).toEqual(['b-deleted.md'])

    vaultA.resolve([entry('a-deleted.md')])
    await first

    expect(trash.trashEntries.value.map((e) => e.name)).toEqual(['b-deleted.md'])
  })

  it('keeps the newer list when two reads of the same vault settle out of order', async () => {
    // Refresh, then a restore's own reload: the reload started later, so its
    // list is the one the user is looking at.
    const older = deferred<TrashEntry[]>()
    const newer = deferred<TrashEntry[]>()
    listTrashMock
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)

    const trash = useSidebarTrash({ vault: () => '/vault' })
    const first = trash.refreshTrash()
    const second = trash.refreshTrash()

    newer.resolve([entry('still-there.md')])
    await second
    older.resolve([entry('restored-away.md')])
    await first

    expect(trash.trashEntries.value.map((e) => e.name)).toEqual(['still-there.md'])
  })

  it('does not mark the trash unreadable on the failure of a superseded read', async () => {
    const stale = deferred<TrashEntry[]>()
    const current = deferred<TrashEntry[]>()
    listTrashMock
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => current.promise)

    let vault = '/vault-a'
    const trash = useSidebarTrash({ vault: () => vault })
    const first = trash.refreshTrash()
    vault = '/vault-b'
    const second = trash.refreshTrash()

    current.resolve([entry('b-deleted.md')])
    await second
    stale.reject(new Error('permission denied'))
    await first

    expect(trash.trashUnreadable.value).toBe(false)
    expect(trash.trashEntries.value.map((e) => e.name)).toEqual(['b-deleted.md'])
  })
})
