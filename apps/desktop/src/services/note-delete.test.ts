import { describe, expect, it, vi } from 'vitest'
import { deleteNoteWithAssets, siblingAssetsDir, noteAssetDirectoryExists } from './note-delete'

/** The two fs calls this service needs, with the trash recorded. */
function io(opts: { withAssets?: boolean; assetsDeleteFails?: boolean; noteDeleteFails?: boolean } = {}) {
  const trashed: string[] = []
  return {
    trashed,
    deleteFile: vi.fn(async (_vault: string, path: string) => {
      if (opts.noteDeleteFails && path.endsWith('.md')) throw new Error('locked')
      if (opts.assetsDeleteFails && path.endsWith('_assets')) throw new Error('locked')
      trashed.push(path)
      return `.nekowite-trash/${path}`
    }),
    exists: vi.fn(async (_vault: string, path: string) => {
      if (!opts.withAssets) return false
      return path.endsWith('_assets')
    }),
  }
}

describe('siblingAssetsDir', () => {
  it('names the folder that owns the note, in the note\'s own spelling', () => {
    // The backend rejects a mixed-separator path on Windows, so the derived
    // folder has to use the same separator the note arrived with.
    expect(siblingAssetsDir('C:\\vault\\notes\\a.md')).toBe('C:\\vault\\notes\\a_assets')
    expect(siblingAssetsDir('/vault/notes/a.md')).toBe('/vault/notes/a_assets')
  })

  it('keeps dots that are not the extension', () => {
    expect(siblingAssetsDir('/vault/report.2024.md')).toBe('/vault/report.2024_assets')
  })

  it('answers the same way `assetsDirForNote` does for odd names', () => {
    // This deliberately mirrors the attachment path's rule (a leading dot is
    // part of the name, not an extension separator) instead of inventing a
    // second rule: the two have to agree, or a delete would look for an assets
    // folder the image pipeline never created. A path with no directory has no
    // sibling to name.
    expect(siblingAssetsDir('/vault/.md')).toBe('/vault/.md_assets')
    expect(siblingAssetsDir('note')).toBeNull()
  })
})

describe('deleteNoteWithAssets', () => {
  it('moves the note and its own asset folder to the trash', () => {
    // Deleting a note moved only the .md file, so the images stayed behind
    // forever: the Attachments panel only walks the vault-level tree, so
    // nothing could list them and the space was never reclaimed.
    const deps = io({ withAssets: true })
    return deleteNoteWithAssets(deps, '/vault', '/vault/notes/a.md').then((result) => {
      expect(result).toEqual({ assetsMoved: true, assetsFailed: false })
      expect(deps.trashed).toEqual(['/vault/notes/a.md', '/vault/notes/a_assets'])
    })
  })

  it('moves only the note when it has no assets folder', async () => {
    const deps = io({ withAssets: false })
    const result = await deleteNoteWithAssets(deps, '/vault', '/vault/notes/a.md')
    expect(result).toEqual({ assetsMoved: false, assetsFailed: false })
    expect(deps.trashed).toEqual(['/vault/notes/a.md'])
  })

  it('checks for the folder BEFORE trashing the note', async () => {
    // After the note is gone an error from the existence probe is
    // indistinguishable from "no assets", so the order is the only thing that
    // makes the result truthful.
    const deps = io({ withAssets: true })
    const order: string[] = []
    deps.deleteFile.mockImplementation(async (_v: string, path: string) => {
      order.push(`delete:${path}`)
      return 'trash'
    })
    deps.exists.mockImplementation(async (_v: string, path: string) => {
      order.push(`exists:${path}`)
      return true
    })
    await deleteNoteWithAssets(deps, '/vault', '/vault/notes/a.md')
    expect(order[0]).toBe('exists:/vault/notes/a_assets')
  })

  it('reports a partial result when only the assets move failed', async () => {
    // The note is gone - the thing the user asked for. Reporting a plain
    // failure would invite a second attempt and a second trash entry, and
    // hide the images that are still on disk.
    const deps = io({ withAssets: true, assetsDeleteFails: true })
    const result = await deleteNoteWithAssets(deps, '/vault', '/vault/notes/a.md')
    expect(result).toEqual({ assetsMoved: false, assetsFailed: true })
    expect(deps.trashed).toEqual(['/vault/notes/a.md'])
  })

  it('propagates a failed NOTE delete so the caller reports a real failure', async () => {
    const deps = io({ withAssets: true, noteDeleteFails: true })
    await expect(deleteNoteWithAssets(deps, '/vault', '/vault/notes/a.md')).rejects.toThrow('locked')
    expect(deps.trashed).toEqual([])
  })

  it('reports incomplete asset cleanup when its existence probe fails', async () => {
    // A probe that throws must not stop the delete the user asked for.
    const deps = io({ withAssets: true })
    deps.exists.mockRejectedValue(new Error('io'))
    const result = await deleteNoteWithAssets(deps, '/vault', '/vault/notes/a.md')
    expect(result).toEqual({ assetsMoved: false, assetsFailed: true })
    expect(deps.trashed).toEqual(['/vault/notes/a.md'])
  })
})

describe('note asset existence adapter', () => {
  const path = '/vault/a_assets'
  it('returns true after a successful stat', async () => {
    await expect(noteAssetDirectoryExists({ stat: async () => ({}) }, '/vault', path)).resolves.toBe(true)
  })
  it.each([
    `could not stat ${path}: no such file or folder (os error 2)`,
    `could not stat ${path}: no such file or folder`,
    `No such file in demo vault: ${path}`,
  ])('returns false only for a missing target: %s', async (error) => {
    await expect(noteAssetDirectoryExists({ stat: async () => { throw new Error(error) } }, '/vault', path)).resolves.toBe(false)
  })
  it.each([
    'could not stat /vault/no such file or folder: permission denied (os error 13)',
    'could not open the vault root /vault: no such file or folder (os error 2)',
    'input/output error',
  ])('propagates an unknown state: %s', async (error) => {
    await expect(noteAssetDirectoryExists({ stat: async () => { throw error } }, '/vault', path)).rejects.toBe(error)
  })
})
