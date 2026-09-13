import { describe, expect, it, vi } from 'vitest'
import { createMemoryFsGateway } from '../../../platform/gateways/memory'
import type { FileEntry, FsGateway } from '../../../platform/gateways/contracts'
import { MAX_ATTACHMENT_BYTES } from './attachment-import'
import {
  createImageSrcResolver,
  deleteAttachment,
  fileToBase64,
  formatBytes,
  formatRelativeTime,
  loadAttachmentLibrary,
  LOW_COPY_ENCODE_MIN_BYTES,
} from './attachment-library'

const DAY = 24 * 60 * 60 * 1000

function seedVault(): Record<string, string> {
  return {
    'notes/idea.md': '# idea',
    'welcome.md': '# welcome',
  }
}

interface FakeDir {
  entries: FileEntry[]
  stats?: Record<string, { size: number; mtime: number }>
}

/** Hand-rolled two-method gateway so structural rules (hidden dirs, image
 * filtering, recursion) can be asserted independently of the memory vault. */
function fakeFs(dirs: Record<string, FakeDir>): FsGateway {
  return {
    list: vi.fn(async (_vault: string, dir: string) => {
      const d = dirs[dir]
      if (!d) throw new Error(`no such dir: ${dir}`)
      return d.entries
    }),
    stat: vi.fn(async (_vault: string, path: string) => {
      for (const d of Object.values(dirs)) {
        const hit = d.stats?.[path]
        if (hit) return hit
      }
      throw new Error(`no stat for ${path}`)
    }),
  } as unknown as FsGateway
}

function entry(name: string, path: string, isDir: boolean): FileEntry {
  return { name, path, is_dir: isDir, is_mdx: false }
}

describe('loadAttachmentLibrary', () => {
  it('recursively collects image files with name/size/mtime', async () => {
    const fs = fakeFs({
      attachments: {
        entries: [
          entry('2026-01', 'attachments/2026-01', true),
          entry('notes.txt', 'attachments/notes.txt', false),
        ],
        stats: { 'attachments/notes.txt': { size: 9, mtime: 500 } },
      },
      'attachments/2026-01': {
        entries: [
          entry('b.png', 'attachments/2026-01/b.png', false),
          entry('sub', 'attachments/2026-01/sub', true),
          entry('.draft.png', 'attachments/2026-01/.draft.png', false),
        ],
        stats: { 'attachments/2026-01/b.png': { size: 10, mtime: 300 } },
      },
      'attachments/2026-01/sub': {
        entries: [entry('c.webp', 'attachments/2026-01/sub/c.webp', false)],
        stats: { 'attachments/2026-01/sub/c.webp': { size: 20, mtime: 900 } },
      },
    })
    const items = await loadAttachmentLibrary('vault', fs)
    expect(items).toEqual([
      { path: 'attachments/2026-01/sub/c.webp', name: 'c.webp', size: 20, mtime: 900 },
      { path: 'attachments/2026-01/b.png', name: 'b.png', size: 10, mtime: 300 },
    ])
  })

  it('sorts newest first and breaks mtime ties by path', async () => {
    const fs = fakeFs({
      attachments: {
        entries: [
          entry('a.png', 'attachments/a.png', false),
          entry('b.jpg', 'attachments/b.jpg', false),
          entry('c.gif', 'attachments/c.gif', false),
        ],
        stats: {
          'attachments/a.png': { size: 1, mtime: 700 },
          'attachments/b.jpg': { size: 2, mtime: 900 },
          'attachments/c.gif': { size: 3, mtime: 700 },
        },
      },
    })
    const items = await loadAttachmentLibrary('vault', fs)
    expect(items.map((i) => i.name)).toEqual(['b.jpg', 'a.png', 'c.gif'])
  })

  it('skips hidden directories', async () => {
    const fs = fakeFs({
      attachments: {
        entries: [entry('.trash', 'attachments/.trash', true)],
        stats: {},
      },
    })
    const items = await loadAttachmentLibrary('vault', fs)
    expect(items).toEqual([])
    expect(fs.list).not.toHaveBeenCalledWith('vault', 'attachments/.trash')
  })

  it('tolerates a failing attachments dir and vanishing files', async () => {
    const boom = {
      list: vi.fn(async () => {
        throw new Error('boom')
      }),
    } as unknown as FsGateway
    await expect(loadAttachmentLibrary('vault', boom)).resolves.toEqual([])

    const fs = fakeFs({
      attachments: {
        entries: [entry('gone.png', 'attachments/gone.png', false)],
        stats: {},
      },
    })
    await expect(loadAttachmentLibrary('vault', fs)).resolves.toEqual([])
  })

  it('works against the memory gateway vault layout', async () => {
    const seed = seedVault()
    seed['attachments/2026-01/b.png'] = '12345'
    seed['attachments/a.png'] = '123'
    seed['attachments/2026-02/deep/c.webp'] = '1234'
    seed['notes/photo.jpg'] = 'outside attachments'
    const fs = createMemoryFsGateway(seed)
    const items = await loadAttachmentLibrary('vault', fs)
    expect(items.map((i) => i.name).sort()).toEqual(['a.png', 'b.png', 'c.webp'])
    const a = items.find((i) => i.name === 'a.png')!
    expect(a.path).toBe('attachments/a.png')
    expect(a.size).toBe(3)
  })

  it('returns empty for a vault without an attachments dir', async () => {
    const fs = createMemoryFsGateway(seedVault())
    await expect(loadAttachmentLibrary('vault', fs)).resolves.toEqual([])
  })
})

describe('deleteAttachment', () => {
  it('moves the file into the gateway trash', async () => {
    const seed = seedVault()
    seed['attachments/a.png'] = 'x'
    const fs = createMemoryFsGateway(seed)
    await deleteAttachment('vault', 'attachments/a.png', fs)
    await expect(fs.read('vault', 'attachments/a.png')).rejects.toThrow()
    const trash = await fs.listTrash('vault')
    expect(trash.some((t) => t.original_path === 'attachments/a.png')).toBe(true)
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

describe('formatBytes', () => {
  it('formats bytes, KB, MB and GB compactly', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(832)).toBe('832 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(9 * 1024 + 512)).toBe('9.5 KB')
    expect(formatBytes(42 * 1024)).toBe('42 KB')
    expect(formatBytes(1.2 * 1024 * 1024)).toBe('1.2 MB')
    expect(formatBytes(3.4 * 1024 * 1024 * 1024)).toBe('3.4 GB')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-09-03T12:00:00Z')

  it('renders just-now / minutes / hours / days buckets', () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe('刚刚')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe('3 小时前')
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2 天前')
  })

  it('falls back to a date beyond a week and handles invalid mtimes', () => {
    expect(formatRelativeTime(now - 30 * DAY, now)).toBe('2026-08-04')
    expect(formatRelativeTime(0, now)).toBe('未知时间')
    expect(formatRelativeTime(Number.NaN, now)).toBe('未知时间')
  })
})
