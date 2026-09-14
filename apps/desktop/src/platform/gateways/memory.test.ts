import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryEventAdapter, createMemoryFsGateway } from './memory'
import type { FsChangeEvent } from './contracts'
import { getSharedGateways, resetSharedGateways } from '../runtime/gateway-runtime'
import { startChatCompletion } from '../../features/ai'

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

  it('clearTrash removes every entry and reports the count and failures', async () => {
    const fs = createMemoryFsGateway({ 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' })
    await fs.deleteFile('memoir://demo', 'a.md')
    await fs.deleteFile('memoir://demo', 'b.md')
    expect(await fs.listTrash('memoir://demo')).toHaveLength(2)
    expect(await fs.clearTrash('memoir://demo')).toEqual({ removed: 2, failed: [] })
    expect(await fs.listTrash('memoir://demo')).toHaveLength(0)
    // Clearing an already-empty trash is a no-op.
    expect(await fs.clearTrash('memoir://demo')).toEqual({ removed: 0, failed: [] })
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

  it('saveAttachment stores into a custom vault-relative dir when one is given', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 3))
    const fs = createMemoryFsGateway()
    const path = await fs.saveAttachment('memoir://demo', 'pic.png', 'QUJD', 'notes/a_assets')
    expect(path).toBe('notes/a_assets/pic.png')
    await expect(fs.resolveMediaPath('memoir://demo', path)).resolves.toBe(
      'data:image/png;base64,QUJD',
    )
    vi.useRealTimers()
  })

  it('saveAttachment stages into .tmp and dedupes within it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 3))
    const fs = createMemoryFsGateway()
    const first = await fs.saveAttachment('memoir://demo', 'pic.png', 'AAA', '.tmp')
    const second = await fs.saveAttachment('memoir://demo', 'pic.png', 'BBB', '.tmp')
    expect(first).toBe('.tmp/pic.png')
    expect(second).toBe('.tmp/pic-1.png')
    await expect(fs.resolveMediaPath('memoir://demo', second)).resolves.toBe(
      'data:image/png;base64,BBB',
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

describe('memoryFsGateway controllable failures', () => {
  it('simulates a failing fs command via an injected failure', async () => {
    const fs = createMemoryFsGateway({ 'a.md': 'x' }, { fail: { read: new Error('disk failure') } })
    await expect(fs.read('memoir://demo', 'a.md')).rejects.toThrow('disk failure')
  })

  it('supports an error factory for a fresh error per call', async () => {
    const fs = createMemoryFsGateway({ 'a.md': 'x' }, { fail: { stat: () => new Error('EIO') } })
    await expect(fs.stat('memoir://demo', 'a.md')).rejects.toThrow('EIO')
    await expect(fs.stat('memoir://demo', 'a.md')).rejects.toThrow('EIO')
  })

  it('simulates a slow backend / timeout with delayMs', async () => {
    vi.useFakeTimers()
    const fs = createMemoryFsGateway({ 'a.md': 'x' }, { delayMs: 500 })
    let result: string | null = null
    const pending = fs.read('memoir://demo', 'a.md').then((r) => {
      result = r
    })
    expect(result).toBeNull()
    await vi.advanceTimersByTimeAsync(500)
    await pending
    expect(result).toBe('x')
    vi.useRealTimers()
  })
})

describe('memoryFsGateway event simulation', () => {
  it('delivers simulated fs-change events to onFsChange subscribers', async () => {
    const events = createMemoryEventAdapter()
    const fs = createMemoryFsGateway({}, { events })
    const received: FsChangeEvent[] = []
    await fs.onFsChange((e) => received.push(e))
    await events.emit('fs-change', { path: 'a.md', kind: 'created' })
    await events.emit('fs-change', { path: 'b.md', kind: 'removed' })
    expect(received).toEqual([
      { path: 'a.md', kind: 'created' },
      { path: 'b.md', kind: 'removed' },
    ])
  })

  it('cancels an fs-change subscription via the returned unsubscribe', async () => {
    const events = createMemoryEventAdapter()
    const fs = createMemoryFsGateway({}, { events })
    let count = 0
    const off = await fs.onFsChange(() => {
      count++
    })
    await events.emit('fs-change', { path: 'a.md', kind: 'created' })
    off()
    await events.emit('fs-change', { path: 'b.md', kind: 'removed' })
    expect(count).toBe(1)
  })
})

describe('memoryGateways drive an AI stream', () => {
  beforeEach(() => resetSharedGateways())
  afterEach(() => resetSharedGateways())

  it('accumulates AI lifecycle events and cancels cleanly', async () => {
    const gw = getSharedGateways()
    const onChunk = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()
    // The frontend chooses the request id before the request goes out (see
    // features/ai/services/ai-chat.ts), so the test drives the events under that same id.
    const completeSpy = vi.spyOn(gw.ai, 'complete')
    const stream = await startChatCompletion(
      { provider: 'local', model: 'm' },
      'look',
      [],
      { onChunk, onDone, onError },
    )
    const id = completeSpy.mock.calls[0]?.[3] as string
    expect(id).toBeTruthy()
    await gw.events.emit('ai-chunk', { id, text: 'Hello' })
    await gw.events.emit('ai-chunk', { id, text: ' world' })
    expect(onChunk).toHaveBeenCalledWith('Hello world')

    // Cancel mid-stream: later events for the cancelled id must be ignored.
    stream.cancel()
    await gw.events.emit('ai-chunk', { id, text: ' ghost' })
    await gw.events.emit('ai-done', { id, full: 'Hello world ghost' })
    expect(onDone).not.toHaveBeenCalled()
    expect(onChunk).toHaveBeenCalledTimes(2)
  })
})
