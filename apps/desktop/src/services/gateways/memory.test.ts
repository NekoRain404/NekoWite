import { describe, expect, it, vi } from 'vitest'
import { createMemoryFsGateway } from './memory'

describe('memoryFsGateway', () => {
  it('reads and writes to an in-memory map', async () => {
    const fs = createMemoryFsGateway({ 'welcome.md': '# hi' })
    expect(await fs.read('memoir://demo', 'welcome.md')).toBe('# hi')
    await fs.write('memoir://demo', 'new.md', 'x')
    expect(await fs.read('memoir://demo', 'new.md')).toBe('x')
  })

  it('rejects reading a missing file', async () => {
    const fs = createMemoryFsGateway()
    await expect(fs.read('memoir://demo', 'nope.md')).rejects.toThrow(
      'No such file in demo vault: nope.md',
    )
  })

  it('lists a virtual directory tree', async () => {
    const fs = createMemoryFsGateway({
      'welcome.md': '# hi',
      'docs/a.md': 'a',
      'docs/sub/b.md': 'b',
    })
    const root = await fs.list('memoir://demo', '.')
    const names = root.map((e) => e.name)
    expect(names).toContain('welcome.md')
    expect(names).toContain('docs')
    const docs = await fs.list('memoir://demo', 'docs')
    expect(docs.map((e) => e.name)).toEqual(['sub', 'a.md'])
  })

  it('treats the vault root path as the root dir', async () => {
    const fs = createMemoryFsGateway({ 'welcome.md': '# hi' })
    const root = await fs.list('memoir://demo', 'memoir://demo')
    expect(root.map((e) => e.name)).toContain('welcome.md')
  })

  it('openFolderDialog returns the demo root', async () => {
    const fs = createMemoryFsGateway()
    expect(await fs.openFolderDialog()).toBe('memoir://demo')
  })

  it('seeds welcome.md by default', async () => {
    const fs = createMemoryFsGateway()
    expect(await fs.read('memoir://demo', 'welcome.md')).toContain(
      '# Welcome to NekoWite (demo)',
    )
  })

  it('deleteFile moves content to trash and read rejects afterwards', async () => {
    const fs = createMemoryFsGateway({ 'a.md': 'content' })
    const trashPath = await fs.deleteFile('memoir://demo', 'a.md')
    expect(typeof trashPath).toBe('string')
    const trash = await fs.listTrash('memoir://demo')
    expect(trash).toHaveLength(1)
    expect(trash[0].name).toBe(trashPath)
    expect(trash[0].original_path).toBe('a.md')
    await expect(fs.read('memoir://demo', 'a.md')).rejects.toThrow()
  })

  it('restoreFromTrash restores original content to original path', async () => {
    const fs = createMemoryFsGateway({ 'a.md': 'hello' })
    const trashPath = await fs.deleteFile('memoir://demo', 'a.md')
    const restored = await fs.restoreFromTrash('memoir://demo', trashPath)
    expect(restored).toBe('a.md')
    expect(await fs.read('memoir://demo', 'a.md')).toBe('hello')
    expect(await fs.listTrash('memoir://demo')).toHaveLength(0)
  })

  it('prunes history to maxHistory keeping the newest snapshots first', async () => {
    const fs = createMemoryFsGateway({ 'a.md': 'v0' })
    await fs.write('memoir://demo', 'a.md', 'v1', 2)
    await fs.write('memoir://demo', 'a.md', 'v2', 2)
    await fs.write('memoir://demo', 'a.md', 'v3', 2)
    const h = await fs.listHistory('memoir://demo', 'a.md')
    expect(h).toHaveLength(2)
    expect(h[0].id).not.toBe(h[1].id)
    expect(await fs.readHistory('memoir://demo', 'a.md', h[0].id)).toBe('v2')
    expect(await fs.readHistory('memoir://demo', 'a.md', h[1].id)).toBe('v1')
  })

  it('stat returns size and mtime recorded by the latest write', async () => {
    const fs = createMemoryFsGateway({ 'a.md': 'hello' })
    await fs.write('memoir://demo', 'a.md', 'hello world')
    const st = await fs.stat('memoir://demo', 'a.md')
    expect(st.size).toBe(11)
    expect(st.mtime).toBeGreaterThan(0)
  })

  it('stat throws for a missing file', async () => {
    const fs = createMemoryFsGateway()
    await expect(fs.stat('memoir://demo', 'nope.md')).rejects.toThrow(
      'No such file in demo vault: nope.md',
    )
  })

  it('does not snapshot history when writing a new file', async () => {
    const fs = createMemoryFsGateway()
    await fs.write('memoir://demo', 'new.md', 'first')
    const h = await fs.listHistory('memoir://demo', 'new.md')
    expect(h).toEqual([])
  })

  it('readHistory returns snapshot content and restoreHistory rewrites the file', async () => {
    const fs = createMemoryFsGateway({ 'a.md': 'v0' })
    await fs.write('memoir://demo', 'a.md', 'v1')
    const h = await fs.listHistory('memoir://demo', 'a.md')
    expect(h).toHaveLength(1)
    expect(await fs.readHistory('memoir://demo', 'a.md', h[0].id)).toBe('v0')
    const restored = await fs.restoreHistory('memoir://demo', 'a.md', h[0].id)
    expect(restored).toBe('v0')
    expect(await fs.read('memoir://demo', 'a.md')).toBe('v0')
  })

  it('saveAttachment stores bytes under attachments/YYYY-MM and returns the path', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 3))
    const fs = createMemoryFsGateway()
    const path = await fs.saveAttachment('memoir://demo', 'paste-x.png', 'QUJD')
    expect(path).toBe('attachments/2026-09/paste-x.png')
    // Resolves to a data: URL usable as <img src>.
    await expect(fs.resolveMediaPath('memoir://demo', path)).resolves.toBe(
      'data:image/png;base64,QUJD',
    )
    vi.useRealTimers()
  })

  it('saveAttachment dedupes with a -1 suffix on name clashes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 3))
    const fs = createMemoryFsGateway()
    const first = await fs.saveAttachment('memoir://demo', 'paste-x.png', 'AAA')
    const second = await fs.saveAttachment('memoir://demo', 'paste-x.png', 'BBB')
    expect(second).toBe('attachments/2026-09/paste-x-1.png')
    await expect(fs.resolveMediaPath('memoir://demo', first)).resolves.toBe(
      'data:image/png;base64,AAA',
    )
    await expect(fs.resolveMediaPath('memoir://demo', second)).resolves.toBe(
      'data:image/png;base64,BBB',
    )
    vi.useRealTimers()
  })

  it('resolveMediaPath picks the mime from the extension and rejects unknown paths', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 3))
    const fs = createMemoryFsGateway()
    const jpeg = await fs.saveAttachment('memoir://demo', 'a.jpg', 'AAA')
    await expect(fs.resolveMediaPath('memoir://demo', jpeg)).resolves.toBe(
      'data:image/jpeg;base64,AAA',
    )
    await expect(fs.resolveMediaPath('memoir://demo', 'attachments/2026-09/nope.png')).rejects.toThrow(
      'No such attachment in demo vault',
    )
    vi.useRealTimers()
  })

  it('saved attachments surface through the virtual directory listing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 3))
    const fs = createMemoryFsGateway()
    await fs.saveAttachment('memoir://demo', 'a.png', 'AAA')
    const root = await fs.list('memoir://demo', '.')
    const attachments = root.find((e) => e.name === 'attachments')
    expect(attachments?.is_dir).toBe(true)
    const month = await fs.list('memoir://demo', 'attachments')
    expect(month.map((e) => e.name)).toContain('2026-09')
    const dir = await fs.list('memoir://demo', 'attachments/2026-09')
    expect(dir.map((e) => e.name)).toContain('a.png')
    vi.useRealTimers()
  })
})
