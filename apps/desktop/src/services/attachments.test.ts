import { describe, expect, it, vi, afterEach } from 'vitest'

import {
  attachmentMonthDir,
  attachmentRelativePath,
  collectClipboardImages,
  createImageSrcResolver,
  escapeMarkdownAlt,
  extensionFromFileName,
  extensionFromMime,
  fileToBase64,
  isImageFile,
  markdownImageBlock,
  mimeFromExtension,
  noteDirectory,
  relativePathFromNote,
  resolveRelativePath,
  suggestedPasteFileName,
  vaultRelativeFromNote,
} from './attachments'

function fileFrom(name: string, type: string): File {
  return new File(['x'], name, { type })
}

function dataTransfer(items: Partial<DataTransferItem>[], files: File[] = []): DataTransfer {
  return {
    items: items as unknown as DataTransferItemList,
    files: files as unknown as FileList,
  } as unknown as DataTransfer
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

describe('fileToBase64', () => {
  it('encodes file bytes as base64', async () => {
    const file = new File([new Uint8Array([104, 105])], 'x.png', { type: 'image/png' })
    await expect(fileToBase64(file)).resolves.toBe(btoa('hi'))
  })
})

describe('collectClipboardImages', () => {
  it('collects image files from dataTransfer items', () => {
    const png = fileFrom('a.png', 'image/png')
    const txt = fileFrom('b.txt', 'text/plain')
    const items = [
      { kind: 'file', type: 'image/png', getAsFile: () => png },
      { kind: 'file', type: 'text/plain', getAsFile: () => txt },
    ]
    expect(collectClipboardImages(dataTransfer(items))).toEqual([png])
  })

  it('falls back to dataTransfer.files and dedupes', () => {
    const png = fileFrom('a.png', 'image/png')
    const dt = dataTransfer([], [png, png])
    expect(collectClipboardImages(dt)).toEqual([png])
  })

  it('returns nothing without a dataTransfer', () => {
    expect(collectClipboardImages(null)).toEqual([])
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

describe('createImageSrcResolver', () => {
  it('delegates to fs.resolveMediaPath with the vault-relative path', async () => {
    const resolveMediaPath = vi.fn(async (_v: string, rel: string) => `data:image/png;base64,${rel}`)
    const resolve = createImageSrcResolver({ resolveMediaPath }, {
      getVault: () => 'vault',
      getNotePath: () => 'notes/a.md',
    })
    await expect(resolve('../attachments/2026-09/a.png')).resolves.toBe(
      'data:image/png;base64,attachments/2026-09/a.png',
    )
    expect(resolveMediaPath).toHaveBeenCalledWith('vault', 'attachments/2026-09/a.png')
  })

  it('returns the raw src when no vault is open or resolution fails', async () => {
    const resolve = createImageSrcResolver(
      { resolveMediaPath: async () => 'x' },
      { getVault: () => null, getNotePath: () => null },
    )
    await expect(resolve('attachments/a.png')).resolves.toBe('attachments/a.png')

    const failing = createImageSrcResolver(
      { resolveMediaPath: async () => { throw new Error('nope') } },
      { getVault: () => 'vault', getNotePath: () => 'a.md' },
    )
    await expect(failing('attachments/a.png')).resolves.toBe('attachments/a.png')
  })
})
