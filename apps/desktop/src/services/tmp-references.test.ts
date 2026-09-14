import { describe, expect, it } from 'vitest'
import {
  findReferencedTmpPaths,
  scanTmpReferences,
  type TmpReferenceScanDeps,
} from './tmp-references'

/** One note fixture: its content, or an Error the reader rejects with. */
type NoteFixture = Record<string, string | Error>

function scanNotes(
  notes: NoteFixture,
  opts: { paths?: string[]; shouldAbort?: () => boolean; vault?: string } = {},
): { result: Promise<Set<string>>; reads: string[] } {
  const reads: string[] = []
  const deps: TmpReferenceScanDeps = {
    // The default mirrors the index: every fixture key is a note path.
    notes: opts.paths ?? Object.keys(notes),
    read: async (_vault, path) => {
      reads.push(path)
      const content = notes[path]
      if (content instanceof Error) throw content
      return content ?? ''
    },
    shouldAbort: opts.shouldAbort,
  }
  return { result: findReferencedTmpPaths(opts.vault ?? '/vault', deps), reads }
}

describe('findReferencedTmpPaths', () => {
  it('finds references in nested notes, ignoring non-notes, directories, and unreferenced notes', async () => {
    const { result, reads } = scanNotes(
      {
        'notes/deep/nested.md': 'Diagram: ![p](.tmp/ok.png)',
        'notes/quiet.mdx': 'Nothing staged here.',
        'assets/logo.png': '![p](.tmp/not-a-note.png)',
      },
      {
        paths: [
          'notes/',
          'notes/deep/',
          // A directory whose name ends in `.md` must not be read as a note.
          'notes/topic.md/',
          'notes/deep/nested.md',
          'notes/quiet.mdx',
          'assets/logo.png',
        ],
      },
    )
    expect(await result).toEqual(new Set(['.tmp/ok.png']))
    // Only the two notes were opened; the image and every directory were not.
    expect(reads.sort()).toEqual(['notes/deep/nested.md', 'notes/quiet.mdx'])
  })

  it('finds every reference in one note and collapses duplicates', async () => {
    const { result } = scanNotes({
      'one.md': '![a](.tmp/a.png) ![b](.tmp/sub/b.png) and ![a](.tmp/a.png) again',
    })
    expect(await result).toEqual(new Set(['.tmp/a.png', '.tmp/sub/b.png']))
  })

  it('keeps scanning when a note cannot be read', async () => {
    const { result } = scanNotes({
      'broken.md': new Error('EACCES: permission denied'),
      'fine.md': '![p](.tmp/kept.png)',
    })
    expect(await result).toEqual(new Set(['.tmp/kept.png']))
  })

  it('normalises every spelling to one vault-relative slash path', async () => {
    const { result } = scanNotes(
      {
        // The same asset referenced relatively, absolutely, and with a
        // Windows-separated tail — all spellings must collapse to one key.
        'relative.md': '![p](.tmp/ok.png)',
        'absolute.md': '![p](/vault/.tmp/ok.png)',
        'mixed.md': '![p](.tmp/march\\ok.png)',
      },
      { vault: '/vault' },
    )
    expect(await result).toEqual(new Set(['.tmp/ok.png', '.tmp/march/ok.png']))
  })

  it('stops issuing reads once shouldAbort says so', async () => {
    const { result, reads } = scanNotes(
      { 'a.md': '![p](.tmp/a.png)' },
      { shouldAbort: () => true },
    )
    expect(await result).toEqual(new Set())
    expect(reads).toEqual([])
  })
})

describe('scanTmpReferences (completeness)', () => {
  const scanRich = (
    notes: NoteFixture,
    opts: { isComplete?: () => boolean } = {},
  ): { result: ReturnType<typeof scanTmpReferences> } => ({
    result: scanTmpReferences('/vault', {
      notes: Object.keys(notes),
      read: async (_vault, path) => {
        const content = notes[path]
        if (content instanceof Error) throw content
        return content ?? ''
      },
      isComplete: opts.isComplete,
    }),
  })

  it('reports a complete scan when every note was read', async () => {
    const { result } = scanRich({ 'a.md': '![p](.tmp/ok.png)', 'b.md': 'nothing' })
    expect(await result).toEqual({ paths: new Set(['.tmp/ok.png']), complete: true })
  })

  it('reports an incomplete scan when a note could not be read', async () => {
    const { result } = scanRich({
      'a.md': '![p](.tmp/ok.png)',
      'locked.md': new Error('EBUSY: the file is locked by another process'),
    })
    const scan = await result
    // The unreadable note is exactly the one that could have referenced a file
    // the caller is about to delete or move, so the answer is not authoritative.
    expect(scan.complete).toBe(false)
    expect(scan.paths).toEqual(new Set(['.tmp/ok.png']))
  })

  it('reports an incomplete scan when the note list itself was truncated', async () => {
    const { result } = scanRich({ 'a.md': 'nothing here' }, { isComplete: () => false })
    expect((await result).complete).toBe(false)
  })
})
