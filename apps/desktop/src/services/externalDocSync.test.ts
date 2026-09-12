import { describe, expect, it, vi } from 'vitest'
import { createExternalDocSync } from './externalDocSync'
import type { FsChangeEvent } from '../platform/gateways/contracts'

interface Harness {
  emit(e: FsChangeEvent): void
  reload: ReturnType<typeof vi.fn>
  onConflict: ReturnType<typeof vi.fn>
  onChange: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
  sync: ReturnType<typeof createExternalDocSync>
  flush(): Promise<void>
}

function harness(overrides: {
  disk?: string
  dirty?: boolean
  savedContent?: string
  selfWrite?: boolean
  path?: string | null
  /** Extra tabs the sync should check when a folder disappears. */
  openTabs?: Array<{ id: string; path: string | null }>
  /** Paths whose read must fail, modelling a file that is gone. */
  unreadable?: string[]
} = {}): Harness & { onMissing: ReturnType<typeof vi.fn> } {
  let handler: ((e: FsChangeEvent) => void) | null = null
  const reload = vi.fn(async () => undefined)
  const onConflict = vi.fn()
  const onChange = vi.fn()
  const onMissing = vi.fn()
  const read = vi.fn(async (_vault: string, p?: string) => {
    if (p && (overrides.unreadable ?? []).includes(p)) throw new Error('not found')
    return overrides.disk ?? 'disk text'
  })
  const sync = createExternalDocSync({
    read,
    onFsChange: async (cb) => {
      handler = cb
      return () => { handler = null }
    },
    getVault: () => 'C:\\vault',
    getActiveTab: () => ({
      id: 'tab-1',
      path: overrides.path === undefined ? 'C:\\vault\\a.md' : overrides.path,
      dirty: overrides.dirty ?? false,
      savedContent: overrides.savedContent ?? 'old text',
    }),
    isSelfWrite: () => overrides.selfWrite ?? false,
    reload,
    onConflict,
    onChange,
    getOpenTabs: () => overrides.openTabs ?? [],
    onMissing,
  })
  return {
    onMissing,
    emit: (e) => handler?.(e),
    reload,
    onConflict,
    onChange,
    read,
    sync,
    flush: async () => { await new Promise((r) => setTimeout(r, 0)) },
  }
}

const MODIFIED: FsChangeEvent = { path: 'C:\\vault\\a.md', kind: 'modified' }

describe('external document sync', () => {
  it('reloads a clean open document when the bytes on disk differ', async () => {
    const h = harness({ disk: 'changed externally', savedContent: 'old text' })
    await h.sync.start()
    h.emit(MODIFIED)
    await h.flush()
    expect(h.reload).toHaveBeenCalledWith('tab-1')
    h.sync.stop()
  })

  it('does nothing when the bytes are what we last saved', async () => {
    // Our own save echo also arrives through the watcher; reloading there would
    // replace the live model and drop the caret on every save.
    const h = harness({ disk: 'same text', savedContent: 'same text' })
    await h.sync.start()
    h.emit(MODIFIED)
    await h.flush()
    expect(h.reload).not.toHaveBeenCalled()
    h.sync.stop()
  })

  it('asks instead of reloading when the tab has unsaved edits', async () => {
    const h = harness({ disk: 'external', savedContent: 'old', dirty: true })
    await h.sync.start()
    h.emit(MODIFIED)
    await h.flush()
    expect(h.reload).not.toHaveBeenCalled()
    expect(h.onConflict).toHaveBeenCalledWith({ tabId: 'tab-1', path: 'C:\\vault\\a.md' })
    h.sync.stop()
  })

  it('ignores events for other paths and for a document with no path', async () => {
    const h = harness()
    await h.sync.start()
    h.emit({ path: 'C:\\vault\\other.md', kind: 'modified' })
    await h.flush()
    expect(h.reload).not.toHaveBeenCalled()
    h.sync.stop()

    const untitled = harness({ path: null })
    await untitled.sync.start()
    untitled.emit(MODIFIED)
    await untitled.flush()
    expect(untitled.reload).not.toHaveBeenCalled()
    untitled.sync.stop()
  })

  it('skips a path inside our own self-write window', async () => {
    const h = harness({ selfWrite: true, disk: 'different' })
    await h.sync.start()
    h.emit(MODIFIED)
    await h.flush()
    expect(h.reload).not.toHaveBeenCalled()
    h.sync.stop()
  })

  it('still notifies observers for events it does not reload', async () => {
    // The file tree refreshes its rows from this hook, and it must keep working
    // for a change that does not involve the open document.
    const h = harness()
    await h.sync.start()
    const other: FsChangeEvent = { path: 'C:\\vault\\other.md', kind: 'created' }
    h.emit(other)
    await h.flush()
    expect(h.onChange).toHaveBeenCalledWith(other)
    h.sync.stop()
  })

  it('stops listening after stop()', async () => {
    const h = harness({ disk: 'different' })
    await h.sync.start()
    h.sync.stop()
    h.emit(MODIFIED)
    await h.flush()
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('start() is idempotent', async () => {
    const h = harness({ disk: 'different' })
    await h.sync.start()
    await h.sync.start()
    h.emit(MODIFIED)
    await h.flush()
    expect(h.reload).toHaveBeenCalledTimes(1)
    h.sync.stop()
  })

  it('reloads even when the disk read fails, as long as the path matches', async () => {
    // A read failure (permissions, a transient lock) must not silently drop a
    // real external change; the conflict decision still applies.
    const h = harness()
    h.read.mockRejectedValueOnce(new Error('locked'))
    await h.sync.start()
    h.emit(MODIFIED)
    await h.flush()
    expect(h.reload).toHaveBeenCalledWith('tab-1')
    h.sync.stop()
  })
})

describe('folder-level disappearance', () => {
  it('reports a tab whose file vanished with its folder', async () => {
    // The event for a folder rename/delete names the FOLDER only, so a note
    // inside it disappears with no event of its own. Left unnoticed, the next
    // save would silently recreate the old path (the backend makes parents) and
    // the user would end up with two copies of one note.
    const h = harness({
      openTabs: [
        { id: 'tab-1', path: 'C:\\vault\\docs\\inside.md' },
        { id: 'tab-2', path: 'C:\\vault\\elsewhere\\other.md' },
      ],
      unreadable: ['C:\\vault\\docs\\inside.md'],
    })
    await h.sync.start()
    h.emit({ path: 'C:\\vault\\docs', kind: 'removed' })
    await h.flush()
    expect(h.onMissing).toHaveBeenCalledTimes(1)
    expect(h.onMissing).toHaveBeenCalledWith('tab-1', 'C:\\vault\\docs\\inside.md')
  })

  it('leaves tabs outside the vanished folder alone', async () => {
    const h = harness({
      openTabs: [{ id: 'tab-2', path: 'C:\\vault\\elsewhere\\other.md' }],
      unreadable: ['C:\\vault\\elsewhere\\other.md'],
    })
    await h.sync.start()
    h.emit({ path: 'C:\\vault\\docs', kind: 'removed' })
    await h.flush()
    expect(h.onMissing).not.toHaveBeenCalled()
  })

  it('checks a MODIFIED folder too, because that is what a rename reports', async () => {
    // Measured on Windows: renaming a folder emits `modified` for both the old
    // and the new name, not `removed` + `created`. Gating on `removed` meant the
    // common case was never noticed.
    const h = harness({
      openTabs: [{ id: 'tab-1', path: 'C:\\vault\\docs\\inside.md' }],
      unreadable: ['C:\\vault\\docs\\inside.md'],
    })
    await h.sync.start()
    h.emit({ path: 'C:\\vault\\docs', kind: 'modified' })
    await h.flush()
    expect(h.onMissing).toHaveBeenCalledWith('tab-1', 'C:\\vault\\docs\\inside.md')
  })

  it('leaves an unrelated file event alone without reading any tab', async () => {
    const h = harness({
      openTabs: [{ id: 'tab-1', path: 'C:\\vault\\docs\\inside.md' }],
      unreadable: ['C:\\vault\\docs\\inside.md'],
    })
    await h.sync.start()
    h.emit({ path: 'C:\\vault\\attachments\\2026-09\\pic.png', kind: 'created' })
    await h.flush()
    expect(h.onMissing).not.toHaveBeenCalled()
    // A file path is not an ancestor of a note path, so no read was needed.
    expect(h.read).not.toHaveBeenCalled()
  })
})
