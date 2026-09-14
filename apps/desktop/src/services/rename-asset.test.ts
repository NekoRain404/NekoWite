import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  assetsDirForNote,
  moveAttachments,
  rewireTempRefsInContent,
  suggestRename,
  validateRenameName,
} from './rename-asset'

afterEach(() => {
  vi.useRealTimers()
})

describe('suggestRename', () => {
  it('prefills a timestamped name for generic clipboard images', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 3, 7, 5, 9))
    expect(suggestRename({ name: 'image.png', type: 'image/png' })).toBe('paste-20260903-070509.png')
  })

  it('keeps real file names (sanitized) with the mime extension', () => {
    expect(suggestRename({ name: 'My Photo.JPEG', type: 'image/jpeg' })).toBe('My-Photo.jpg')
  })
})

describe('validateRenameName', () => {
  it('accepts a plain stem.ext name', () => {
    expect(validateRenameName('hello.png')).toBeNull()
    expect(validateRenameName('my-photo.jpg')).toBeNull()
  })

  it('accepts every extension the backend allowlists, case-insensitively', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg']) {
      expect(validateRenameName(`pic.${ext}`), ext).toBeNull()
      expect(validateRenameName(`pic.${ext.toUpperCase()}`), ext).toBeNull()
    }
  })

  it('rejects an extension the backend would refuse', () => {
    // The paste path stores images; without this the save fails at the IPC
    // boundary with a backend error instead of a clear message.
    for (const name of ['notes.html', 'payload.exe', 'run.ps1', 'archive.zip', 'data.json']) {
      const error = validateRenameName(name)
      expect(error, name).not.toBeNull()
      expect(error).toContain('png')
    }
  })

  it('rejects empty and whitespace-only names', () => {
    expect(validateRenameName('')).not.toBeNull()
    expect(validateRenameName('   ')).not.toBeNull()
  })

  it('rejects path separators and traversal', () => {
    expect(validateRenameName('a/b.png')).not.toBeNull()
    expect(validateRenameName('a\\b.png')).not.toBeNull()
    expect(validateRenameName('../x.png')).not.toBeNull()
  })

  it('rejects names without an extension', () => {
    expect(validateRenameName('juststem')).not.toBeNull()
  })
})

describe('assetsDirForNote', () => {
  it('stages into .tmp when the note is unsaved', () => {
    expect(assetsDirForNote(null, '/vault')).toBe('.tmp')
    expect(assetsDirForNote('', '/vault')).toBe('.tmp')
  })

  it('uses <base>_assets for root-level notes', () => {
    expect(assetsDirForNote('/vault/note.md', '/vault')).toBe('note_assets')
  })

  it('uses <dir>/<base>_assets for notes in subdirectories', () => {
    expect(assetsDirForNote('/vault/notes/foo.md', '/vault')).toBe('notes/foo_assets')
    expect(assetsDirForNote('/vault/docs/sub/deep.md', '/vault')).toBe('docs/sub/deep_assets')
  })

  it('keeps vault-relative note paths working', () => {
    expect(assetsDirForNote('notes/a.md', '/vault')).toBe('notes/a_assets')
    expect(assetsDirForNote('a.md', '/vault')).toBe('a_assets')
  })

  it('rebases an absolute Windows note path onto the vault', () => {
    // The exact spelling the Rust layer hands over on Windows: absolute, with
    // backslashes. The old `/`-only prefix test returned the whole path, and
    // the backend rejects an absolute `dir` ("attachment dir must be
    // vault-relative") — so pasting into a saved note always failed.
    expect(assetsDirForNote('C:\\Users\\me\\vault\\notes\\a.md', 'C:\\Users\\me\\vault')).toBe(
      'notes/a_assets',
    )
    expect(assetsDirForNote('C:\\Users\\me\\vault\\a.md', 'C:\\Users\\me\\vault\\')).toBe('a_assets')
    expect(assetsDirForNote('C:\\vault\\docs\\sub\\deep.md', 'C:\\vault')).toBe('docs/sub/deep_assets')
  })

  it('handles the verbatim Windows spelling', () => {
    expect(assetsDirForNote('\\\\?\\C:\\vault\\notes\\a.md', '\\\\?\\C:\\vault')).toBe('notes/a_assets')
  })
})

describe('moveAttachments', () => {
  it('rebases each staged path into the target assets dir', () => {
    const moves = moveAttachments('.tmp', 'notes/a_assets', ['.tmp/pic.png', '.tmp/photo.jpg'])
    expect(moves).toEqual([
      { from: '.tmp/pic.png', to: 'notes/a_assets/pic.png' },
      { from: '.tmp/photo.jpg', to: 'notes/a_assets/photo.jpg' },
    ])
  })
})

describe('rewireTempRefsInContent', () => {
  it('replaces .tmp refs with note-relative assets refs', () => {
    const content = '![pic](.tmp/pic.png)\n\ntext ![p2](../.tmp/x.png)\n'
    const moves = moveAttachments('.tmp', 'notes/a_assets', ['.tmp/pic.png'])
    const out = rewireTempRefsInContent(content, moves, '/vault/notes/a.md', '/vault')
    expect(out).toContain('![pic](a_assets/pic.png)')
    expect(out).not.toContain('.tmp/pic.png')
  })

  it('writes a vault-relative reference when the note path is a Windows path', () => {
    const moves = moveAttachments('.tmp', 'notes/a_assets', ['.tmp/pic.png'])
    const out = rewireTempRefsInContent('![pic](.tmp/pic.png)\n', moves, 'C:\\vault\\notes\\a.md', 'C:\\vault')
    expect(out).toContain('![pic](a_assets/pic.png)')
    // The note must not record the machine-specific absolute spelling.
    expect(out).not.toContain('C:')
  })

  it('rebases an absolute destination left over from the old assets-dir helper', () => {
    // `assetsDirForNote` used to answer with `C:\vault\notes\a_assets` on
    // Windows: the move itself worked, but the note body got that absolute
    // path written into it.
    const moves = [{ from: '.tmp/pic.png', to: 'C:\\vault\\notes\\a_assets/pic.png' }]
    const out = rewireTempRefsInContent('![pic](.tmp/pic.png)\n', moves, 'C:\\vault\\notes\\a.md', 'C:\\vault')
    expect(out).toBe('![pic](a_assets/pic.png)\n')
  })
})
