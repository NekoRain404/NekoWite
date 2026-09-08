import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  assetsDirForNote,
  moveAttachments,
  rewireTempRefsInContent,
  suggestRename,
  validateRenameName,
} from './renameAsset'

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
})
