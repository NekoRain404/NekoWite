import { describe, expect, it, vi } from 'vitest'
import { moveNote } from './noteMove'
import type { NoteMoveIo } from './noteMove'
import { joinPath } from './paths'

interface Entry {
  name: string
  is_dir: boolean
}

interface Harness {
  io: NoteMoveIo
  read: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  rename: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  disk: Map<string, string>
}

/** A tiny in-memory vault: `files` seeds content, `children` seeds the
 *  per-directory listing the service reads to see whether an assets directory
 *  exists, and `rename` moves either kind of entry so a test can assert the
 *  exact sequence the service issues. */
function harness(
  files: Record<string, string>,
  children: Record<string, Entry[]> = {},
): Harness {
  const disk = new Map(Object.entries(files))
  const dirs = new Map(Object.entries(children))
  const read = vi.fn(async (_vault: string, path: string) => {
    const text = disk.get(path)
    if (text === undefined) throw new Error(`not found: ${path}`)
    return text
  })
  const write = vi.fn(async (_vault: string, path: string, content: string) => {
    disk.set(path, content)
  })
  const rename = vi.fn(async (_vault: string, from: string, to: string) => {
    const text = disk.get(from)
    if (text !== undefined) {
      disk.delete(from)
      disk.set(to, text)
    }
    return to
  })
  const list = vi.fn(async (_vault: string, dir: string) => dirs.get(dir) ?? [])
  return { io: { read, write, rename, list }, read, write, rename, list, disk }
}

describe('moveNote', () => {
  it('recomputes a ../attachments/ reference when the note moves one level deeper', async () => {
    const rewritten = '# A\n\n![pic](../../attachments/2026-09/x.png)\n'
    const h = harness(
      { '/vault/notes/a.md': '# A\n\n![pic](../attachments/2026-09/x.png)\n' },
      { '/vault/notes': [{ name: 'a.md', is_dir: false }] },
    )

    const result = await moveNote(h.io, '/vault', '/vault/notes/a.md', '/vault/notes/sub/a.md')

    expect(h.rename.mock.calls).toEqual([
      ['/vault', '/vault/notes/a.md', '/vault/notes/sub/a.md'],
    ])
    expect(h.write).toHaveBeenCalledTimes(1)
    expect(h.write).toHaveBeenCalledWith('/vault', '/vault/notes/sub/a.md', rewritten)
    expect(h.disk.get('/vault/notes/sub/a.md')).toBe(rewritten)
    expect(result).toEqual({ content: rewritten, movedAssets: false })
  })

  it('moves a sibling _assets folder with the note and follows the renamed refs', async () => {
    const h = harness(
      {
        '/vault/notes/a.md': '![p](a_assets/pic.png)\n![q](../attachments/2026-09/q.png)\n',
        '/vault/notes/a_assets/pic.png': 'bytes',
      },
      {
        '/vault/notes': [
          { name: 'a.md', is_dir: false },
          { name: 'a_assets', is_dir: true },
        ],
      },
    )

    const result = await moveNote(h.io, '/vault', '/vault/notes/a.md', '/vault/notes/sub/b.md')

    // The assets folder goes first: a conflict there leaves the note in place.
    expect(h.rename.mock.calls).toEqual([
      ['/vault', joinPath('/vault/notes', 'a_assets'), joinPath('/vault/notes/sub', 'b_assets')],
      ['/vault', '/vault/notes/a.md', '/vault/notes/sub/b.md'],
    ])
    expect(h.write).toHaveBeenCalledWith(
      '/vault',
      '/vault/notes/sub/b.md',
      '![p](b_assets/pic.png)\n![q](../../attachments/2026-09/q.png)\n',
    )
    expect(result.movedAssets).toBe(true)
  })

  it('moves a note whose assets folder does not exist without touching one', async () => {
    const h = harness(
      { '/vault/notes/a.md': '![p](a_assets/pic.png)\n' },
      { '/vault/notes': [{ name: 'a.md', is_dir: false }] },
    )

    const result = await moveNote(h.io, '/vault', '/vault/notes/a.md', '/vault/notes/sub/a.md')

    expect(h.rename).toHaveBeenCalledTimes(1)
    expect(h.rename).toHaveBeenCalledWith('/vault', '/vault/notes/a.md', '/vault/notes/sub/a.md')
    // Same basename, same note-relative spelling: there is nothing to carry
    // and nothing to rewrite, so the document is not written at all.
    expect(h.write).not.toHaveBeenCalled()
    expect(result).toEqual({ content: null, movedAssets: false })
  })

  it('leaves the document untouched when no reference needs rewriting', async () => {
    const h = harness(
      { '/vault/notes/a.md': '# A\n\nPlain text and ![remote](https://example.com/x.png).\n' },
      { '/vault/notes': [{ name: 'a.md', is_dir: false }] },
    )

    const result = await moveNote(h.io, '/vault', '/vault/notes/a.md', '/vault/notes/sub/a.md')

    expect(h.write).not.toHaveBeenCalled()
    expect(result).toEqual({ content: null, movedAssets: false })
  })

  it('rewrites every reference in place and preserves the rest of the file', async () => {
    const body = [
      '---',
      'title: A\t ',
      'tags: [x, y]',
      '---',
      '',
      '![one](../attachments/2026-09/one.png "cover")',
      'A [link](a_assets/doc.pdf) and ![two](a_assets/two.png).',
      '![remote](https://example.com/r.png) ![anchor](#top) ![abs](/vault/notes/a.md)',
      '',
      '```md',
      '![fenced](../attachments/2026-09/fenced.png)',
      '```',
      '',
      '![wrapped](<../attachments/2026-09/wrap.png>)',
      '',
      '![self](a.md)',
      '',
    ].join('\n')
    const expected = [
      '---',
      'title: A\t ',
      'tags: [x, y]',
      '---',
      '',
      '![one](../../attachments/2026-09/one.png "cover")',
      'A [link](b_assets/doc.pdf) and ![two](b_assets/two.png).',
      '![remote](https://example.com/r.png) ![anchor](#top) ![abs](/vault/notes/a.md)',
      '',
      '```md',
      '![fenced](../attachments/2026-09/fenced.png)',
      '```',
      '',
      '![wrapped](<../../attachments/2026-09/wrap.png>)',
      '',
      '![self](b.md)',
      '',
    ].join('\n')
    const h = harness(
      { '/vault/notes/a.md': body },
      {
        '/vault/notes': [
          { name: 'a.md', is_dir: false },
          { name: 'a_assets', is_dir: true },
        ],
      },
    )

    await moveNote(h.io, '/vault', '/vault/notes/a.md', '/vault/notes/sub/b.md')

    // Byte-for-byte: only the destination inside each `](…)` changed — the
    // fenced block, frontmatter, URLs, anchor and absolute link are untouched.
    expect(h.write).toHaveBeenCalledTimes(1)
    expect(h.write).toHaveBeenCalledWith('/vault', '/vault/notes/sub/b.md', expected)
  })

  it('does not move the assets folder into itself', async () => {
    const h = harness(
      { '/vault/notes/a.md': '![p](a_assets/pic.png)\n' },
      {
        '/vault/notes': [
          { name: 'a.md', is_dir: false },
          { name: 'a_assets', is_dir: true },
        ],
      },
    )

    const result = await moveNote(
      h.io,
      '/vault',
      '/vault/notes/a.md',
      '/vault/notes/a_assets/a.md',
    )

    expect(h.rename.mock.calls).toEqual([
      ['/vault', '/vault/notes/a.md', '/vault/notes/a_assets/a.md'],
    ])
    expect(h.write).not.toHaveBeenCalled()
    expect(result.movedAssets).toBe(false)
  })

  it('rolls the folder move back when the rewritten body cannot be written', async () => {
    const body = '![p](a_assets/pic.png)\n'
    const h = harness(
      {
        '/vault/notes/a.md': body,
        '/vault/notes/a_assets/pic.png': 'bytes',
      },
      {
        '/vault/notes': [
          { name: 'a.md', is_dir: false },
          { name: 'a_assets', is_dir: true },
        ],
      },
    )
    h.write.mockRejectedValueOnce(new Error('disk full'))

    await expect(
      moveNote(h.io, '/vault', '/vault/notes/a.md', '/vault/notes/sub/b.md'),
    ).rejects.toThrow('disk full')
    expect(h.rename.mock.calls).toEqual([
      ['/vault', '/vault/notes/a_assets', '/vault/notes/sub/b_assets'],
      ['/vault', '/vault/notes/a.md', '/vault/notes/sub/b.md'],
      ['/vault', '/vault/notes/sub/b.md', '/vault/notes/a.md'],
      ['/vault', '/vault/notes/sub/b_assets', '/vault/notes/a_assets'],
    ])
    expect(h.disk.get('/vault/notes/a.md')).toBe(body)
    expect(h.disk.has('/vault/notes/sub/b.md')).toBe(false)
  })

  it('surfaces a read failure instead of half-moving the note', async () => {
    const h = harness({}, { '/vault/notes': [{ name: 'a.md', is_dir: false }] })
    h.read.mockRejectedValueOnce(new Error('permission denied'))

    await expect(
      moveNote(h.io, '/vault', '/vault/notes/a.md', '/vault/notes/sub/a.md'),
    ).rejects.toThrow('permission denied')
    expect(h.rename).not.toHaveBeenCalled()
    expect(h.write).not.toHaveBeenCalled()
  })

  it('puts the assets folder back when the note rename fails', async () => {
    const h = harness(
      {
        '/vault/notes/a.md': '![p](a_assets/pic.png)\n',
        '/vault/notes/a_assets/pic.png': 'bytes',
      },
      {
        '/vault/notes': [
          { name: 'a.md', is_dir: false },
          { name: 'a_assets', is_dir: true },
        ],
      },
    )
    // The assets move succeeds; the backend refuses the note rename
    // (destination conflict), so the folder must come back.
    h.rename.mockImplementationOnce(async () => undefined)
    h.rename.mockRejectedValueOnce(new Error('target already exists'))

    await expect(
      moveNote(h.io, '/vault', '/vault/notes/a.md', '/vault/notes/sub/b.md'),
    ).rejects.toThrow('target already exists')
    expect(h.rename.mock.calls).toEqual([
      ['/vault', '/vault/notes/a_assets', '/vault/notes/sub/b_assets'],
      ['/vault', '/vault/notes/a.md', '/vault/notes/sub/b.md'],
      ['/vault', '/vault/notes/sub/b_assets', '/vault/notes/a_assets'],
    ])
    expect(h.write).not.toHaveBeenCalled()
  })
})

// The spelling the Rust layer returns for a vault on Windows: a verbatim prefix
// and backslash separators, while every stored reference uses `/`.
const WIN_VAULT = '\\\\?\\C:\\Users\\Lenovo\\Documents\\vault'
const WIN_NOTES = `${WIN_VAULT}\\notes`
const WIN_FROM = `${WIN_NOTES}\\a.md`
const WIN_TO = `${WIN_NOTES}\\sub\\b.md`

describe('moveNote on Windows', () => {
  it('moves a native note and its assets folder without mixing separators', async () => {
    const h = harness(
      { [WIN_FROM]: '![p](../attachments/2026-09/x.png)\n![q](a_assets/q.png)\n' },
      {
        [WIN_NOTES]: [
          { name: 'a.md', is_dir: false },
          { name: 'a_assets', is_dir: true },
        ],
      },
    )

    const result = await moveNote(h.io, WIN_VAULT, WIN_FROM, WIN_TO)

    expect(h.list).toHaveBeenCalledWith(WIN_VAULT, WIN_NOTES)
    expect(h.rename.mock.calls).toEqual([
      [WIN_VAULT, `${WIN_NOTES}\\a_assets`, `${WIN_NOTES}\\sub\\b_assets`],
      [WIN_VAULT, WIN_FROM, WIN_TO],
    ])
    // Both the moved folder and the rewritten refs are derived through
    // `services/paths`, so neither side comes out as a mixed spelling.
    expect(h.write).toHaveBeenCalledWith(
      WIN_VAULT,
      WIN_TO,
      '![p](../../attachments/2026-09/x.png)\n![q](b_assets/q.png)\n',
    )
    expect(result.movedAssets).toBe(true)
  })
})
