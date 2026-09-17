/**
 * Putting an accepted answer into the note, and saying truthfully what happened to it.
 *
 * `AgentEditHost.write` is documented as "Put `text` into the note and save it", and the outcome it
 * answers with is three different facts — in the note and on the file, in the note and not on the
 * file, and nothing to put it into. The tests below are about that difference, because the failure
 * this whole module exists to prevent is the one where all three look alike: the write happens and
 * the user is told nothing.
 *
 * The save goes through the tab store's own transaction rather than a bare `fs.write`, and that is
 * deliberate: a save checks that the file still holds the bytes this tab last read or wrote, so an
 * apply that arrives after some other program rewrote the note is refused and reported rather than
 * quietly replacing it. What that refusal looks like from here is
 * `save-failed` — the text is in the note, the file does not have it, and the user is owed the
 * difference.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from '../../../stores/tabs'
import { writeNoteText } from './agent-note-write'

const readMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())
vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: writeMock,
    list: vi.fn(async () => []),
    watch: vi.fn(async () => () => {}),
    deleteFile: vi.fn(async () => ''),
    stat: vi.fn(async () => ({ size: 0, mtime: 0 })),
    listHistory: vi.fn(async () => []),
    readHistory: vi.fn(async () => ''),
    restoreHistory: vi.fn(async () => ''),
    createDir: vi.fn(async () => ''),
    renameEntry: vi.fn(async () => ''),
    saveFileDialog: vi.fn(async () => null),
  },
}))

const VAULT = '/vault'
const PATH = `${VAULT}/notes/a.md`
const ON_DISK = '# A\n\nas it was'

/** The vault, as bytes: one map answers the tab's read and the read a save takes before it writes. */
const disk = new Map<string, string>([[PATH, ON_DISK]])

beforeEach(() => {
  setActivePinia(createPinia())
  disk.set(PATH, ON_DISK)
  readMock.mockReset()
  writeMock.mockReset()
  readMock.mockImplementation(async (_vault: string, path: string) => {
    const content = disk.get(path)
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  })
  writeMock.mockImplementation(async (_vault: string, path: string, content: string) => {
    disk.set(path, content)
    return null
  })
})

async function openNote(): Promise<void> {
  const tabs = useTabsStore()
  tabs.setVault(VAULT)
  await tabs.openTab(PATH)
}

describe('putting the agent’s text into the note', () => {
  it('lands the text in the note and on the file, and says so', async () => {
    await openNote()
    const tabs = useTabsStore()

    const outcome = await writeNoteText(PATH, '# A\n\nthe agent’s version')

    expect(outcome).toEqual({ status: 'saved' })
    expect(disk.get(PATH)).toBe('# A\n\nthe agent’s version')
    expect(tabs.tabs.find((t) => t.path === PATH)?.content).toBe('# A\n\nthe agent’s version')
  })

  it('has nothing to write into when no tab holds the path', async () => {
    await openNote()

    expect(await writeNoteText(`${VAULT}/notes/gone.md`, 'anything')).toEqual({ status: 'unavailable' })
    // Not one byte written anywhere. A write that opened the file behind the editor's back would
    // be a document the user has never seen holding text they never agreed to.
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('reports a save the tab store refused rather than claiming the file has it', async () => {
    await openNote()
    // Somebody else replaced the file after this tab read it: the save's own precondition refuses,
    // which is the app's existing protection for another program's version — the agent's apply
    // does not get a private road past it.
    disk.set(PATH, '# A\n\nwhat another program wrote')

    const outcome = await writeNoteText(PATH, '# A\n\nthe agent’s version')

    expect(outcome).toEqual({ status: 'save-failed' })
    expect(disk.get(PATH)).toBe('# A\n\nwhat another program wrote')
  })
})
