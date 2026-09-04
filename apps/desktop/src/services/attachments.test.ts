import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import {
  attachmentMonthDir,
  attachmentRelativePath,
  attachmentSessionCount,
  classifyAttachmentFiles,
  collectClipboardImages,
  createImageSrcResolver,
  escapeMarkdownAlt,
  extensionFromFileName,
  extensionFromMime,
  fileToBase64,
  isImageFile,
  isPathWithinVault,
  LOW_COPY_ENCODE_MIN_BYTES,
  markdownImageBlock,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_BATCH,
  MAX_ATTACHMENTS_PER_SESSION,
  mimeFromExtension,
  noteDirectory,
  relativePathFromNote,
  relativePathFromNoteVault,
  resetAttachmentSession,
  resolveRelativePath,
  suggestedPasteFileName,
  vaultRelativeFromNote,
  vaultRelativeFromNoteVault,
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
  // Give a File a synthetic size without allocating `size` bytes (used to build
  // an oversize image cheaply).
  function fileOfSize(name: string, size: number): File {
    const file = new File(['x'], name, { type: 'image/png' })
    Object.defineProperty(file, 'size', { value: size, configurable: true })
    return file
  }

  it('encodes file bytes as base64', async () => {
    const file = new File([new Uint8Array([104, 105])], 'x.png', { type: 'image/png' })
    await expect(fileToBase64(file)).resolves.toBe(btoa('hi'))
  })

  it('rejects an oversize image BEFORE any encode (never reads bytes)', async () => {
    const big = fileOfSize('big.png', MAX_ATTACHMENT_BYTES + 1)
    // If the encode path read the file, FileReader.readAsDataURL would be called.
    const spy = vi.spyOn(FileReader.prototype, 'readAsDataURL')
    await expect(fileToBase64(big)).rejects.toThrow(/exceeds/)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('uses the native FileReader low-copy path for large-but-allowed images', async () => {
    const file = new File([new Uint8Array([104, 105])], 'x.png', { type: 'image/png' })
    // Override the reported size to route it onto the low-copy (FileReader) path
    // without allocating the bytes; the content itself is still just 'hi'.
    Object.defineProperty(file, 'size', {
      value: LOW_COPY_ENCODE_MIN_BYTES + 1,
      configurable: true,
    })
    const spy = vi.spyOn(FileReader.prototype, 'readAsDataURL')
    await expect(fileToBase64(file)).resolves.toBe(btoa('hi'))
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('keeps small images on the fast arrayBuffer path (no FileReader)', async () => {
    const file = new File([new Uint8Array([104, 105])], 'x.png', { type: 'image/png' })
    const spy = vi.spyOn(FileReader.prototype, 'readAsDataURL')
    await expect(fileToBase64(file)).resolves.toBe(btoa('hi'))
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
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

describe('attachment limits', () => {
  // Give a File a synthetic size without allocating `size` bytes.
  function fileOfSize(name: string, size: number): File {
    const file = new File(['x'], name, { type: 'image/png' })
    Object.defineProperty(file, 'size', { value: size, configurable: true })
    return file
  }

  beforeEach(() => {
    resetAttachmentSession()
  })

  afterEach(() => {
    resetAttachmentSession()
  })

  it('rejects an oversize image before any base64 encode', async () => {
    const big = fileOfSize('big.png', MAX_ATTACHMENT_BYTES + 1)
    const { accepted, rejected } = classifyAttachmentFiles([big])
    expect(accepted).toEqual([])
    expect(rejected).toEqual([{ file: big, reason: 'too-large' }])
    // The encode path itself must refuse it too, before reading bytes.
    await expect(fileToBase64(big)).rejects.toThrow()
  })

  it('caps the number of images in a single paste/drop batch', () => {
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_BATCH + 3 }, (_, i) =>
      fileOfSize(`p${i}.png`, 1),
    )
    const { accepted, rejected } = classifyAttachmentFiles(files)
    expect(accepted).toHaveLength(MAX_ATTACHMENTS_PER_BATCH)
    expect(rejected).toHaveLength(3)
    expect(rejected.every((r) => r.reason === 'too-many')).toBe(true)
  })

  it('caps the running total per session', () => {
    // Fill the session budget one paste/drop at a time — each classify call is a
    // single batch, itself capped at MAX_ATTACHMENTS_PER_BATCH, so we can't reach
    // the session limit with one oversized call.
    const chunks = Math.ceil(MAX_ATTACHMENTS_PER_SESSION / MAX_ATTACHMENTS_PER_BATCH)
    for (let i = 0; i < chunks; i += 1) {
      const chunkSize = Math.min(
        MAX_ATTACHMENTS_PER_BATCH,
        MAX_ATTACHMENTS_PER_SESSION - i * MAX_ATTACHMENTS_PER_BATCH,
      )
      const chunk = Array.from({ length: chunkSize }, (_, j) => fileOfSize(`a${i}-${j}.png`, 1))
      classifyAttachmentFiles(chunk)
    }
    expect(attachmentSessionCount()).toBe(MAX_ATTACHMENTS_PER_SESSION)

    const extra = fileOfSize('extra.png', 1)
    const { accepted, rejected } = classifyAttachmentFiles([extra])
    expect(accepted).toEqual([])
    expect(rejected[0]).toEqual({ file: extra, reason: 'session-full' })
  })

  it('applies limits through collectClipboardImages for a paste', () => {
    const accepted = Array.from({ length: MAX_ATTACHMENTS_PER_BATCH }, (_, i) =>
      fileOfSize(`c${i}.png`, 1),
    )
    const items = accepted.map((f) => ({ kind: 'file', type: 'image/png', getAsFile: () => f }))
    expect(collectClipboardImages(dataTransfer(items as Partial<DataTransferItem>[]))).toHaveLength(
      MAX_ATTACHMENTS_PER_BATCH,
    )
    expect(attachmentSessionCount()).toBe(MAX_ATTACHMENTS_PER_BATCH)
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

  it('vaultRelativeFromNoteVault resolves ../ back against the note dir', () => {
    expect(vaultRelativeFromNoteVault('/home/u/vault/docs/note.md', '/home/u/vault', '../attachments/2026-09/a.png')).toBe(
      'attachments/2026-09/a.png',
    )
    expect(vaultRelativeFromNoteVault('/home/u/vault/docs/note.md', '/home/u/vault', '../../x/a.png')).toBe('x/a.png')
  })
})
