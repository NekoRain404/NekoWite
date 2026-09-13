import { MAX_IMAGES_PER_MESSAGE } from '../../../stores/chatSession'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { fileToBase64 } from './attachment-library'
import {
  applyAttachmentLimits,
  attachmentSessionCount,
  classifyAttachmentFiles,
  collectClipboardImages,
  formatAttachmentBytes,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_BATCH,
  MAX_ATTACHMENTS_PER_BATCH_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_SESSION,
  MAX_ATTACHMENTS_PER_VAULT_BYTES,
  MIN_ATTACHMENT_FREE_DISK_BYTES,
  planAttachmentImport,
  resetAttachmentSession,
  shouldStreamImport,
  STREAM_IMPORT_BACKEND_COMMAND,
  STREAM_IMPORT_MIN_BYTES,
} from './attachment-import'

function fileFrom(name: string, type: string): File {
  return new File(['x'], name, { type })
}

function dataTransfer(items: Partial<DataTransferItem>[], files: File[] = []): DataTransfer {
  return {
    items: items as unknown as DataTransferItemList,
    files: files as unknown as FileList,
  } as unknown as DataTransfer
}

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

describe('the chat attachment limit', () => {
  it('never lets the composer hold more images than the session can keep', () => {
    // Two constants used to disagree (6 vs 4): the composer accepted six, the
    // store persisted four, and the two extra vanished from the conversation at
    // send time without telling the user which ones they were.
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(MAX_IMAGES_PER_MESSAGE)
  })
})
