import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const h = vi.hoisted(() => ({
  fakeIndexVault: vi.fn<(_vault: string) => Promise<void>>(() => Promise.resolve()),
  fakeDetach: vi.fn(),
  captured: {} as Record<string, unknown>,
}))

vi.mock('../features/vault/services/indexCoordinatorWiring', () => ({
  createBoundVaultIndexCoordinator: (callbacks: Record<string, unknown>) => {
    h.captured = callbacks
    return {
      indexVault: h.fakeIndexVault,
      detach: h.fakeDetach,
      noteContent: vi.fn(async () => 'content'),
      indexEntryFor: vi.fn(() => null),
      indexCandidatePaths: vi.fn(() => []),
      buildSearchIndex: vi.fn(async () => {}),
      cancelSearchIndexBuild: vi.fn(),
      rebuildIndex: vi.fn(async () => {}),
    }
  },
}))

import { useVaultSessionStore } from './vaultSession'
import { useDocumentListStore } from './documentList'
import { useFileTreeStore } from './fileTree'

describe('useVaultSessionStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.fakeIndexVault.mockClear()
    h.fakeDetach.mockClear()
    h.captured = {}
  })

  it('indexVault resets vault-scoped state and delegates to the coordinator', async () => {
    const session = useVaultSessionStore()
    const doc = useDocumentListStore()
    const tree = useFileTreeStore()
    // Simulate a prior vault's state lingering.
    doc.setListView('graph')
    doc.setFilter('favorites')
    tree.setVaultTruncated(true)
    tree.setAttachmentCount(3)

    const p = session.indexVault('/vault')
    expect(session.vault).toBe('/vault')
    expect(doc.listView).toBe('notes')
    expect(doc.filter).toBe('all')
    expect(doc.notes).toEqual([])
    expect(tree.vaultTruncated).toBe(false)
    expect(tree.attachmentCount).toBe(0)
    expect(h.fakeIndexVault).toHaveBeenCalledWith('/vault')
    await p
  })

  it('switching vault detaches the previous coordinator (cancels prior index tasks)', async () => {
    const session = useVaultSessionStore()
    await session.indexVault('/vaultA') // creates coordinator #1
    expect(h.fakeIndexVault).toHaveBeenCalledWith('/vaultA')
    h.fakeDetach.mockClear()
    await session.indexVault('/vaultB') // must detach coordinator #1
    expect(h.fakeDetach).toHaveBeenCalledTimes(1)
  })

  it('mirrors coordinator callbacks into the document-list / file-tree stores', async () => {
    const session = useVaultSessionStore()
    const doc = useDocumentListStore()
    const tree = useFileTreeStore()
    session.indexVault('/vault')

    const cbs = h.captured as {
      onNotes: (n: unknown[]) => void
      onIndexing: (v: boolean) => void
      onTruncated: (v: boolean) => void
      onAttachmentCount: (n: number) => void
      onNotesPruned: (favs: string[], recents: string[]) => void
      onIndexState: (s: string, p: { done: number; total: number } | null) => void
      getFavorites: () => string[]
      getRecents: () => string[]
    }
    cbs.onNotes([{ path: '/vault/a.md' }] as never[])
    expect(doc.notes).toEqual([{ path: '/vault/a.md' }])
    cbs.onIndexing(true)
    expect(doc.indexing).toBe(true)
    cbs.onTruncated(true)
    expect(tree.vaultTruncated).toBe(true)
    cbs.onAttachmentCount(5)
    expect(tree.attachmentCount).toBe(5)
    cbs.onIndexState('up-to-date', { done: 1, total: 1 })
    expect(doc.indexState).toBe('up-to-date')
    // Pruning flows back through the doc store (and persists).
    doc.setFavoritesRecents(['/vault/a.md'], ['/vault/a.md'])
    cbs.getFavorites()
    cbs.getRecents()
  })

  it('detachVault clears the vault and resets the vault-scoped stores', async () => {
    const session = useVaultSessionStore()
    const doc = useDocumentListStore()
    const tree = useFileTreeStore()
    doc.setNotes([{ path: '/vault/a.md' } as never])
    tree.setVaultTruncated(true)
    await session.indexVault('/vault')
    session.detachVault()
    expect(session.vault).toBeNull()
    expect(doc.notes).toEqual([])
    expect(tree.vaultTruncated).toBe(false)
    expect(h.fakeDetach).toHaveBeenCalled()
  })

  it('exposes read helpers that delegate to the coordinator', async () => {
    const session = useVaultSessionStore()
    await session.indexVault('/vault')
    await expect(session.noteContent('/vault/a.md')).resolves.toBe('content')
    expect(session.indexEntryFor('/vault/a.md')).toBeNull()
    expect(session.indexCandidatePaths('x')).toEqual([])
    await expect(session.rebuildIndex()).resolves.toBeUndefined()
  })
})
