import { describe, expect, it, vi, afterEach } from 'vitest'

import {
  attachmentMonthDir,
  attachmentRelativePath,
  escapeMarkdownAlt,
  extensionFromFileName,
  extensionFromMime,
  isImageFile,
  isPathWithinVault,
  isUnsupportedImagePath,
  markdownImageBlock,
  mimeFromExtension,
  noteDirectory,
  relativePathFromNote,
  relativePathFromNoteVault,
  resolveRelativePath,
  suggestedPasteFileName,
  vaultRelativeFromNote,
  vaultRelativeFromNoteVault,
} from './attachment-paths'

function fileFrom(name: string, type: string): File {
  return new File(['x'], name, { type })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('mime ↔ extension mapping', () => {
  it('maps the eight supported image formats', () => {
    expect(extensionFromMime('image/png')).toBe('png')
    expect(extensionFromMime('image/jpeg')).toBe('jpg')
    expect(extensionFromMime('IMAGE/JPG')).toBe('jpg')
    expect(extensionFromMime('image/gif')).toBe('gif')
    expect(extensionFromMime('image/webp')).toBe('webp')
    expect(extensionFromMime('image/bmp')).toBe('bmp')
    expect(extensionFromMime('image/x-ms-bmp')).toBe('bmp')
    expect(extensionFromMime('image/avif')).toBe('avif')
    expect(extensionFromMime('image/svg+xml')).toBe('svg')
    expect(extensionFromMime('text/plain')).toBeNull()
  })

  it('maps extensions back to mime types', () => {
    expect(mimeFromExtension('png')).toBe('image/png')
    expect(mimeFromExtension('JPEG')).toBe('image/jpeg')
    expect(mimeFromExtension('svg')).toBe('image/svg+xml')
    expect(mimeFromExtension('docx')).toBe('application/octet-stream')
  })

  it('detects image files by mime or extension', () => {
    expect(isImageFile(fileFrom('x.png', 'image/png'))).toBe(true)
    expect(isImageFile(fileFrom('photo', 'image/jpeg'))).toBe(true)
    expect(isImageFile(fileFrom('x.webp', ''))).toBe(true)
    expect(isImageFile(fileFrom('x.txt', 'text/plain'))).toBe(false)
    expect(extensionFromFileName('a.jpeg')).toBe('jpeg')
    expect(extensionFromFileName('noext')).toBeNull()
  })

  it('tells an image this build cannot read from one it can, and from everything else', () => {
    // The three the vault's importer takes and this build's reader list does not
    // (`attachment_store.rs`'s `IMPORT_IMAGE_EXTENSIONS`): routing one of them to the text reader
    // is what had the app call a file it imported itself "unreadable". The predicate is by
    // extension alone, in any case, and answers false for both of the things it is not about —
    // a supported image, and a file that is not an image at all.
    expect(isUnsupportedImagePath('attachments/scan.tiff')).toBe(true)
    expect(isUnsupportedImagePath('scan.TIF')).toBe(true)
    expect(isUnsupportedImagePath('C:\\pics\\icon.ico')).toBe(true)
    expect(isUnsupportedImagePath('shot.png')).toBe(false)
    expect(isUnsupportedImagePath('a.tifx')).toBe(false)
    expect(isUnsupportedImagePath('notes/welcome.md')).toBe(false)
    expect(isUnsupportedImagePath('noext')).toBe(false)
  })
})

describe('suggestedPasteFileName', () => {
  it('turns generic clipboard names into paste-YYYYMMDD-HHmmss.png', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 3, 7, 5, 9))
    const now = new Date()
    expect(suggestedPasteFileName(fileFrom('image.png', 'image/png'), now)).toBe(
      'paste-20260903-070509.png',
    )
    expect(suggestedPasteFileName(fileFrom('screenshot 2.png', 'image/png'), now)).toBe(
      'paste-20260903-070509.png',
    )
    expect(suggestedPasteFileName(fileFrom('blob', ''), now)).toBe('paste-20260903-070509.png')
  })

  it('keeps real names (sanitized) and respects the mime extension', () => {
    expect(suggestedPasteFileName(fileFrom('My Photo.JPEG', 'image/jpeg'))).toBe('My-Photo.jpg')
    expect(suggestedPasteFileName(fileFrom('chart', 'image/svg+xml'))).toBe('chart.svg')
  })

  it('falls back to png when neither mime nor name hints the format', () => {
    expect(suggestedPasteFileName(fileFrom('blob', ''))).toMatch(/\.png$/)
  })
})

describe('markdown helpers', () => {
  it('escapes brackets in alt text', () => {
    expect(escapeMarkdownAlt('a [b] c')).toBe('a b c')
    expect(escapeMarkdownAlt('   ')).toBe('image')
  })

  it('pads the image block with blank lines', () => {
    expect(markdownImageBlock('pic', '../attachments/2026-09/a.png')).toBe(
      '\n\n![pic](../attachments/2026-09/a.png)\n\n',
    )
  })

  it('computes the month dir and vault-relative attachment path', () => {
    expect(attachmentMonthDir(new Date(2026, 8, 3))).toBe('2026-09')
    expect(attachmentRelativePath('a.png', new Date(2026, 8, 3))).toBe(
      'attachments/2026-09/a.png',
    )
  })
})

describe('isPathWithinVault', () => {
  it('accepts paths at or under the vault and rejects outside paths', () => {
    expect(isPathWithinVault('/home/u/vault/export.html', '/home/u/vault')).toBe(true)
    expect(isPathWithinVault('/home/u/vault/notes/a.md', '/home/u/vault')).toBe(true)
    expect(isPathWithinVault('/home/u/vault', '/home/u/vault')).toBe(true)
    expect(isPathWithinVault('/home/u/Desktop/export.html', '/home/u/vault')).toBe(false)
    expect(isPathWithinVault('/home/u/vaulted/export.html', '/home/u/vault')).toBe(false)
  })

  it('normalises trailing separators and Windows backslashes', () => {
    expect(isPathWithinVault('/home/u/vault/sub/..', '/home/u/vault/')).toBe(true)
    expect(isPathWithinVault('C:\\vault\\export.html', 'C:\\vault')).toBe(true)
    expect(isPathWithinVault('C:\\vault\\export.html', 'C:\\other')).toBe(false)
    expect(isPathWithinVault('', '/home/u/vault')).toBe(false)
    expect(isPathWithinVault('/path/to/x', '')).toBe(false)
  })
})

describe('note/attachment path juggling', () => {
  it('splits the note directory off a note path', () => {
    expect(noteDirectory('notes/sub/a.md')).toBe('notes/sub')
    expect(noteDirectory('a.md')).toBe('')
  })

  it('references attachments relatively from nested notes', () => {
    expect(relativePathFromNote('notes/a.md', 'attachments/2026-09/a.png')).toBe(
      '../attachments/2026-09/a.png',
    )
    expect(relativePathFromNote('notes/sub/a.md', 'attachments/2026-09/a.png')).toBe(
      '../../attachments/2026-09/a.png',
    )
  })

  it('degenerates to the vault-relative path for root-level notes', () => {
    expect(relativePathFromNote('a.md', 'attachments/2026-09/a.png')).toBe(
      'attachments/2026-09/a.png',
    )
    expect(relativePathFromNote('', 'attachments/2026-09/a.png')).toBe(
      'attachments/2026-09/a.png',
    )
  })

  it('keeps shared prefixes minimal', () => {
    expect(relativePathFromNote('notes/a.md', 'notes/attachments/a.png')).toBe(
      'attachments/a.png',
    )
  })

  it('passes through absolute and scheme-ful targets', () => {
    expect(relativePathFromNote('notes/a.md', 'https://x.dev/a.png')).toBe('https://x.dev/a.png')
    expect(relativePathFromNote('notes/a.md', '/abs/a.png')).toBe('/abs/a.png')
  })

  it('resolves relative srcs back to vault-relative paths', () => {
    expect(vaultRelativeFromNote('notes/a.md', '../attachments/2026-09/a.png')).toBe(
      'attachments/2026-09/a.png',
    )
    expect(vaultRelativeFromNote('a.md', 'attachments/2026-09/a.png')).toBe(
      'attachments/2026-09/a.png',
    )
    // A src that already points at the vault-level attachments dir is kept.
    expect(vaultRelativeFromNote('notes/a.md', 'attachments/2026-09/a.png')).toBe(
      'attachments/2026-09/a.png',
    )
    expect(vaultRelativeFromNote('notes/a.md', 'data:image/png;base64,AA')).toBe(
      'data:image/png;base64,AA',
    )
  })

  it('resolves dotted segments with clamping at the root', () => {
    expect(resolveRelativePath('a/b', '../c.png')).toBe('a/c.png')
    expect(resolveRelativePath('a/b', '../../c.png')).toBe('c.png')
    expect(resolveRelativePath('a/b', '../../../../c.png')).toBe('c.png')
    expect(resolveRelativePath('', 'x/y.png')).toBe('x/y.png')
  })
})

describe('vault-aware relative paths', () => {
  it('rebases an absolute note path onto the vault before computing', () => {
    expect(relativePathFromNoteVault('/home/u/vault/docs/note.md', '/home/u/vault', 'attachments/2026-09/a.png')).toBe(
      '../attachments/2026-09/a.png',
    )
    expect(relativePathFromNoteVault('/home/u/vault/note.md', '/home/u/vault', 'attachments/2026-09/a.png')).toBe(
      'attachments/2026-09/a.png',
    )
    expect(relativePathFromNoteVault('/home/u/vault/docs/sub/note.md', '/home/u/vault', 'attachments/2026-09/a.png')).toBe(
      '../../attachments/2026-09/a.png',
    )
  })

  it('keeps vault-relative note paths working (back-compat)', () => {
    expect(relativePathFromNoteVault('docs/note.md', '/home/u/vault', 'attachments/2026-09/a.png')).toBe(
      '../attachments/2026-09/a.png',
    )
  })

  it('returns scheme/non-jailed targets unchanged', () => {
    expect(relativePathFromNoteVault('a.md', '/v', 'https://x.dev/a.png')).toBe('https://x.dev/a.png')
    expect(relativePathFromNoteVault('a.md', '/v', '/abs/a.png')).toBe('/abs/a.png')
  })

  it('rebases a Windows note path onto the vault (backslashes)', () => {
    // Native Windows spelling: a `/`-only vault test never matched, so the
    // whole absolute path was treated as the note's own directory.
    expect(
      relativePathFromNoteVault(
        'C:\\Users\\me\\vault\\notes\\a.md',
        'C:\\Users\\me\\vault',
        'notes/a_assets/pic.png',
      ),
    ).toBe('a_assets/pic.png')
    expect(
      relativePathFromNoteVault(
        'C:\\Users\\me\\vault\\a.md',
        'C:\\Users\\me\\vault',
        'notes/a_assets/pic.png',
      ),
    ).toBe('notes/a_assets/pic.png')
  })

  it('rebases an absolute vault destination instead of keeping it absolute', () => {
    // That is the `to` the old assets-dir helper produced on Windows; writing
    // it into the note produced machine-specific Markdown.
    expect(
      relativePathFromNoteVault(
        'C:\\vault\\notes\\a.md',
        'C:\\vault',
        'C:\\vault\\notes\\a_assets/pic.png',
      ),
    ).toBe('a_assets/pic.png')
  })

  it('still passes an absolute path outside the vault through', () => {
    expect(relativePathFromNoteVault('C:\\vault\\a.md', 'C:\\vault', 'D:\\pics\\a.png')).toBe(
      'D:\\pics\\a.png',
    )
  })

  it('vaultRelativeFromNoteVault resolves ../ back against the note dir', () => {
    expect(vaultRelativeFromNoteVault('/home/u/vault/docs/note.md', '/home/u/vault', '../attachments/2026-09/a.png')).toBe(
      'attachments/2026-09/a.png',
    )
    expect(vaultRelativeFromNoteVault('/home/u/vault/docs/note.md', '/home/u/vault', '../../x/a.png')).toBe('x/a.png')
  })

  it('resolves a Windows note path against its own directory for the display resolver', () => {
    expect(
      vaultRelativeFromNoteVault('C:\\vault\\notes\\a.md', 'C:\\vault', '../attachments/2026-09/a.png'),
    ).toBe('attachments/2026-09/a.png')
    expect(vaultRelativeFromNoteVault('C:\\vault\\notes\\a.md', 'C:\\vault', 'a_assets/pic.png')).toBe(
      'notes/a_assets/pic.png',
    )
  })
})
