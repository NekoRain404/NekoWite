import { describe, expect, it, vi } from 'vitest'
import { createVaultFileActions, validateEntryName } from './vault-file-actions'
import type { VaultFileActionPorts } from './vault-file-actions'

/** Ports whose every call is recorded, with the disk half failing on demand. */
function makePorts(over: Partial<VaultFileActionPorts> = {}) {
  // The parameter lists are declared on the mocks (rather than written on a
  // stub body) so the fake matches the port it stands in for: an untyped
  // `vi.fn(async () => ...)` would infer a zero-argument signature.
  const io = {
    write: vi.fn<(vault: string, path: string, content: string) => Promise<void>>(async () => undefined),
    createDir: vi.fn<(vault: string, path: string) => Promise<void>>(async () => undefined),
    deleteFile: vi.fn<(vault: string, path: string) => Promise<string>>(async () => 'trash-key'),
    exists: vi.fn<(vault: string, path: string) => Promise<boolean>>(async () => false),
  }
  const tabs = {
    tabIdAt: vi.fn<(path: string) => string | null>(() => null),
    deleteTabFile: vi.fn<(tabId: string) => Promise<void>>(async () => undefined),
    forgetTabsUnder: vi.fn<(path: string) => void>(() => undefined),
  }
  const move = vi.fn<
    (vault: string, from: string, to: string, isDir: boolean) => Promise<void>
  >(async () => undefined)
  const ports: VaultFileActionPorts = { io, move, tabs, isDir: () => false, ...over }
  return { ports, io, tabs, move, actions: createVaultFileActions(ports) }
}

describe('validateEntryName', () => {
  it('refuses every name the tree has always refused', () => {
    expect(validateEntryName('')).toBe('name-required')
    expect(validateEntryName('a/b.md')).toBe('name-slash')
    expect(validateEntryName('.hidden')).toBe('name-dot')
  })

  it('accepts a plain name', () => {
    expect(validateEntryName('note.md')).toBeNull()
  })

  it('accepts a backslash, which the tree never refused', () => {
    // `services/noteActions.noteRenameNameError` — the note list's own rule set
    // — rejects this too. The tree does not, and adopting that helper would
    // turn a name the tree accepts (a legal POSIX file name) into a refusal.
    expect(validateEntryName('a\\b.md')).toBeNull()
  })
})

describe('create', () => {
  it('writes an empty note and answers with the path it created', async () => {
    const { actions, io } = makePorts()
    await expect(actions.create('/vault', '/vault/sub', 'new.md', 'file')).resolves.toEqual({
      ok: true,
      path: '/vault/sub/new.md',
    })
    expect(io.write).toHaveBeenCalledWith('/vault', '/vault/sub/new.md', '')
    expect(io.createDir).not.toHaveBeenCalled()
  })

  it('creates a directory instead of a file', async () => {
    const { actions, io } = makePorts()
    await expect(actions.create('/vault', '/vault', 'notes', 'dir')).resolves.toEqual({
      ok: true,
      path: '/vault/notes',
    })
    expect(io.createDir).toHaveBeenCalledWith('/vault', '/vault/notes')
    expect(io.write).not.toHaveBeenCalled()
  })

  it('reports a failed create as a result rather than throwing', async () => {
    const { actions, io } = makePorts()
    io.write.mockRejectedValue(new Error('disk full'))
    const result = await actions.create('/vault', '/vault', 'new.md', 'file')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.kind).toBe('io')
  })
})

describe('rename', () => {
  it('moves the entry inside its own directory and answers with the new path', async () => {
    const { actions, move } = makePorts()
    await expect(actions.rename('/vault', '/vault/sub/a.md', 'b.md', false)).resolves.toEqual({
      ok: true,
      path: '/vault/sub/b.md',
    })
    expect(move).toHaveBeenCalledWith('/vault', '/vault/sub/a.md', '/vault/sub/b.md', false)
  })

  it('leaves a folder a folder when it moves', async () => {
    const { actions, move } = makePorts()
    await actions.rename('/vault', '/vault/sub', 'other', true)
    expect(move).toHaveBeenCalledWith('/vault', '/vault/sub', '/vault/other', true)
  })

  it('does not touch the disk when the name did not change', async () => {
    const { actions, move } = makePorts()
    await expect(actions.rename('/vault', '/vault/a.md', 'a.md', false)).resolves.toEqual({
      ok: true,
      path: '/vault/a.md',
    })
    expect(move).not.toHaveBeenCalled()
  })

  it('reports a failed move as a result rather than throwing', async () => {
    const { actions, move } = makePorts()
    move.mockRejectedValue(new Error('locked'))
    const result = await actions.rename('/vault', '/vault/a.md', 'b.md', false)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.kind).toBe('io')
  })
})

describe('delete', () => {
  it('deletes an open file through the store’s own tab-delete', async () => {
    // The store's flow is the only one that also closes the tab, so a tab open
    // on the exact path must not go through the tree's own branches.
    const { actions, io, tabs } = makePorts()
    tabs.tabIdAt.mockReturnValue('t1')
    await expect(actions.delete('/vault', '/vault/a.md')).resolves.toEqual({
      ok: true,
      assetsFailed: false,
    })
    expect(tabs.deleteTabFile).toHaveBeenCalledWith('t1')
    expect(io.deleteFile).not.toHaveBeenCalled()
  })

  it('deletes a folder and forgets the tabs under it', async () => {
    const { actions, io, tabs } = makePorts({ isDir: () => true })
    await expect(actions.delete('/vault', '/vault/docs')).resolves.toEqual({
      ok: true,
      assetsFailed: false,
    })
    expect(io.deleteFile).toHaveBeenCalledWith('/vault', '/vault/docs')
    expect(tabs.forgetTabsUnder).toHaveBeenCalledWith('/vault/docs')
  })

  it('deletes a note together with its own image folder', async () => {
    const { actions, io, tabs } = makePorts()
    io.exists.mockResolvedValue(true)
    await expect(actions.delete('/vault', '/vault/a.md')).resolves.toEqual({
      ok: true,
      assetsFailed: false,
    })
    expect(io.deleteFile).toHaveBeenNthCalledWith(1, '/vault', '/vault/a.md')
    expect(io.deleteFile).toHaveBeenNthCalledWith(2, '/vault', '/vault/a_assets')
    expect(tabs.forgetTabsUnder).toHaveBeenCalledWith('/vault/a.md')
  })

  it('reports a partial delete when the image folder cannot be moved', async () => {
    // The note is what the user asked to delete; a folder left behind is
    // reported, not turned into "the delete failed".
    const { actions, io } = makePorts()
    io.exists.mockResolvedValue(true)
    io.deleteFile.mockImplementation(async (_v: string, path: string) => {
      if (path.endsWith('_assets')) throw new Error('locked')
      return 'trash-key'
    })
    await expect(actions.delete('/vault', '/vault/a.md')).resolves.toEqual({
      ok: true,
      assetsFailed: true,
    })
  })

  it('reports a failed delete as a result rather than throwing', async () => {
    const { actions, io } = makePorts({ isDir: () => true })
    io.deleteFile.mockRejectedValue(new Error('locked'))
    const result = await actions.delete('/vault', '/vault/docs')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.kind).toBe('io')
  })
})
