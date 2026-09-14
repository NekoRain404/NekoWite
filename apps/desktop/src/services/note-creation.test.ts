import { beforeEach, describe, expect, it, vi } from 'vitest'

const createNewFileMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/create-new-file', () => ({ createNewFile: createNewFileMock }))

vi.mock('../platform/gateways/fs', () => ({
  fsService: { write: writeMock },
}))

import { MAX_CREATE_ATTEMPTS, createNoteWithFreeName } from './note-creation'

describe('createNoteWithFreeName', () => {
  beforeEach(() => {
    createNewFileMock.mockReset()
    writeMock.mockReset()
    createNewFileMock.mockResolvedValue('created')
    writeMock.mockResolvedValue(undefined)
  })

  it('creates the note under the first free name through the create-only command', async () => {
    const created = await createNoteWithFreeName('/vault', 'meeting', 'body', ['meeting.md'])

    expect(created).toEqual({ path: '/vault/meeting-1.md', fileName: 'meeting-1.md' })
    expect(createNewFileMock).toHaveBeenCalledTimes(1)
    expect(createNewFileMock).toHaveBeenCalledWith('/vault', '/vault/meeting-1.md', 'body')
    // The create-only call IS the write; also going through the replacing write
    // would undo the guarantee the retry exists for.
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('tolerates a trailing slash on the vault root', async () => {
    const created = await createNoteWithFreeName('/vault/', 'meeting', 'body', [])

    expect(created?.path).toBe('/vault/meeting.md')
    expect(createNewFileMock).toHaveBeenCalledWith('/vault/', '/vault/meeting.md', 'body')
  })

  it('takes the next candidate name when another writer claimed the first', async () => {
    // The listing said "meeting.md is free" and a second writer put a file there
    // before the write landed: the old code replaced that file and reported
    // success. Here the collision is an outcome, and the note lands beside it.
    createNewFileMock.mockResolvedValueOnce('exists').mockResolvedValueOnce('created')

    const created = await createNoteWithFreeName('/vault', 'meeting', 'body', [])

    expect(created).toEqual({ path: '/vault/meeting-1.md', fileName: 'meeting-1.md' })
    expect(createNewFileMock.mock.calls.map((call) => call[1])).toEqual([
      '/vault/meeting.md',
      '/vault/meeting-1.md',
    ])
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('keeps counting past names that were already on disk', async () => {
    createNewFileMock.mockResolvedValueOnce('exists').mockResolvedValueOnce('created')

    const created = await createNoteWithFreeName('/vault', 'meeting', 'body', [
      'meeting.md',
      'meeting-1.md',
    ])

    expect(createNewFileMock.mock.calls.map((call) => call[1])).toEqual([
      '/vault/meeting-2.md',
      '/vault/meeting-3.md',
    ])
    expect(created?.fileName).toBe('meeting-3.md')
  })

  it('gives up after a bounded number of collisions without writing over anything', async () => {
    createNewFileMock.mockResolvedValue('exists')

    const created = await createNoteWithFreeName('/vault', 'meeting', 'body', [])

    expect(created).toBeNull()
    expect(createNewFileMock).toHaveBeenCalledTimes(MAX_CREATE_ATTEMPTS)
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('falls back to the replacing write only when the build has no create-only command', async () => {
    createNewFileMock.mockResolvedValue('unsupported')

    const created = await createNoteWithFreeName('/vault', 'meeting', 'body', [])

    expect(created).toEqual({ path: '/vault/meeting.md', fileName: 'meeting.md' })
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/meeting.md', 'body')
  })
})
