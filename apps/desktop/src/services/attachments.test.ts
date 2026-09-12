import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import {
  applyAttachmentLimits,
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
  formatAttachmentBytes,
  isImageFile,
  isPathWithinVault,
  LOW_COPY_ENCODE_MIN_BYTES,
  markdownImageBlock,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_BATCH,
  MAX_ATTACHMENTS_PER_BATCH_BYTES,
  MAX_ATTACHMENTS_PER_SESSION,
  MAX_ATTACHMENTS_PER_VAULT_BYTES,
  MIN_ATTACHMENT_FREE_DISK_BYTES,
  mimeFromExtension,
  noteDirectory,
  planAttachmentImport,
  relativePathFromNote,
  relativePathFromNoteVault,
  resetAttachmentSession,
  resolveRelativePath,
  shouldStreamImport,
  STREAM_IMPORT_BACKEND_COMMAND,
  STREAM_IMPORT_MIN_BYTES,
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

  it('rejects instead of passing the src through when it cannot resolve', async () => {
    // Rejecting (rather than "resolving" to the raw src) is what keeps a
    // transient failure out of the resolution cache: a pass-through looks like
    // a success, so the unloadable document path was memoized and every image
    // stayed broken even after the vault arrived.
    const noVault = createImageSrcResolver(
      { resolveMediaPath: async () => 'x' },
      { getVault: () => null, getNotePath: () => null },
    )
    await expect(noVault('attachments/a.png')).rejects.toThrow(/no vault/i)

    const failing = createImageSrcResolver(
      { resolveMediaPath: async () => { throw new Error('nope') } },
      { getVault: () => 'vault', getNotePath: () => 'a.md' },
    )
    await expect(failing('attachments/a.png')).rejects.toThrow('nope')
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

describe('streaming / file-path import policy (P1.4)', () => {
  // Give a File a synthetic size without allocating `size` bytes.
  function fileOfSize(name: string, size: number, type = 'image/png'): File {
    const file = new File(['x'], name, { type })
    Object.defineProperty(file, 'size', { value: size, configurable: true })
    return file
  }

  it('rejects oversize / over-batch / over-vault-total / low-disk before any write', () => {
    const spy = vi.spyOn(FileReader.prototype, 'readAsDataURL')

    // 1. Per-file size cap.
    const tooLarge = fileOfSize('big.png', MAX_ATTACHMENT_BYTES + 1)
    let plan = planAttachmentImport([tooLarge], { vaultTotalBytes: 0, freeDiskBytes: 10 * 1024 * 1024 })
    expect(plan.accepted).toEqual([])
    expect(plan.rejected).toEqual([{ file: tooLarge, reason: 'too-large' }])

    // 2. Per-batch byte cap (overridden to a small ceiling so a single batch can
    //    trip it without violating the per-file cap).
    const batchFiles = [fileOfSize('a.png', 5 * 1024 * 1024), fileOfSize('b.png', 6 * 1024 * 1024)]
    plan = planAttachmentImport(batchFiles, { vaultTotalBytes: 0, freeDiskBytes: 500 * 1024 * 1024 }, {
      maxBatchBytes: 10 * 1024 * 1024,
    })
    expect(plan.accepted).toEqual([batchFiles[0]])
    expect(plan.rejected).toEqual([{ file: batchFiles[1], reason: 'batch-total' }])

    // 3. Per-vault total cap.
    const vaultFile = fileOfSize('v.png', 5 * 1024 * 1024)
    plan = planAttachmentImport([vaultFile], {
      vaultTotalBytes: MAX_ATTACHMENTS_PER_VAULT_BYTES - 1,
      freeDiskBytes: 500 * 1024 * 1024,
    })
    expect(plan.accepted).toEqual([])
    expect(plan.rejected).toEqual([{ file: vaultFile, reason: 'vault-total' }])

    // 4. Disk-free-space guard: not enough room left after this file.
    const diskFile = fileOfSize('d.png', 5 * 1024 * 1024)
    plan = planAttachmentImport([diskFile], {
      vaultTotalBytes: 0,
      freeDiskBytes: MIN_ATTACHMENT_FREE_DISK_BYTES + 1,
    })
    expect(plan.accepted).toEqual([])
    expect(plan.rejected).toEqual([{ file: diskFile, reason: 'low-disk' }])

    // None of the above read any bytes into base64 (reject-before-Write).
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('routes a large file through the streaming/file-path route (no base64 read for it)', () => {
    const spy = vi.spyOn(FileReader.prototype, 'readAsDataURL')
    const large = fileOfSize('large.png', STREAM_IMPORT_MIN_BYTES + 1)
    const small = fileOfSize('small.png', 1024)
    const plan = planAttachmentImport([large, small], { vaultTotalBytes: 0, freeDiskBytes: 500 * 1024 * 1024 })
    expect(plan.stream).toEqual([large])
    expect(plan.base64).toEqual([small])
    expect(plan.requiresStreaming).toBe(true)
    expect(plan.accepted).toEqual([large, small])
    // The streaming route never base64-encodes the large file.
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('exposes the exact backend command a true streaming import would call (honest gap)', () => {
    expect(STREAM_IMPORT_BACKEND_COMMAND).toContain('import_attachment')
  })

  it('applyAttachmentLimits with a vault context routes through the full policy', () => {
    const large = fileOfSize('large.png', STREAM_IMPORT_MIN_BYTES + 1)
    const accepted = applyAttachmentLimits([large], { vaultTotalBytes: 0, freeDiskBytes: 500 * 1024 * 1024 })
    expect(accepted).toEqual([large])
    // Without a context it reverts to the legacy count-based path (still accepts).
    const legacy = applyAttachmentLimits([large])
    expect(legacy).toEqual([large])
  })

  it('shouldStreamImport splits on the streaming threshold', () => {
    expect(shouldStreamImport(fileOfSize('a.png', STREAM_IMPORT_MIN_BYTES))).toBe(true)
    expect(shouldStreamImport(fileOfSize('a.png', STREAM_IMPORT_MIN_BYTES - 1))).toBe(false)
    expect(formatAttachmentBytes(MAX_ATTACHMENT_BYTES)).toBe(`${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`)
  })
})

describe('classifyAttachmentFiles batch byte budget', () => {
  // The worst batch the count and per-file caps allow is exactly the byte
  // budget (10 x 10 MiB == 100 MiB), so today the byte check never binds. It is
  // enforced anyway so that changing any one of these constants cannot silently
  // turn a "10 images" prompt into a 133 MB base64 spike. This test pins the
  // relationship the check relies on.
  it('permits exactly the worst batch the other caps allow', () => {
    const atLimit = (name: string) =>
      ({ name, size: MAX_ATTACHMENT_BYTES, type: 'image/png', lastModified: 1 }) as File
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_BATCH }, (_v, i) =>
      atLimit(`big-${i}.png`),
    )

    const { accepted, rejected } = classifyAttachmentFiles(files)

    expect(accepted).toHaveLength(MAX_ATTACHMENTS_PER_BATCH)
    expect(rejected).toHaveLength(0)
    expect(MAX_ATTACHMENTS_PER_BATCH * MAX_ATTACHMENT_BYTES).toBeLessThanOrEqual(
      MAX_ATTACHMENTS_PER_BATCH_BYTES,
    )
  })

  it('accepts a normal batch and explains anything it drops', () => {
    const small = (name: string) =>
      ({ name, size: 1024, type: 'image/png', lastModified: 1 }) as File
    const files = Array.from({ length: 3 }, (_v, i) => small(`s-${i}.png`))
    const { accepted, rejected } = classifyAttachmentFiles(files)
    expect(accepted).toHaveLength(3)
    expect(rejected).toHaveLength(0)
  })

  it('rejects an over-size file before anything else', () => {
    const huge = {
      name: 'huge.png',
      size: MAX_ATTACHMENT_BYTES + 1,
      type: 'image/png',
      lastModified: 1,
    } as File
    const { accepted, rejected } = classifyAttachmentFiles([huge])
    expect(accepted).toHaveLength(0)
    expect(rejected[0]?.reason).toBe('too-large')
  })
})
