import { describe, expect, it, vi } from 'vitest'
import { createExternalDocSync } from './external-doc-sync'
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
  /** Paths the APP is renaming right now (see `beginMove`). */
  pendingMove?: string[]
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
    isPendingMove: (p) => (overrides.pendingMove ?? []).some((from) => p === from || p.startsWith(`${from}\\`)),
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

  it('does not detach a tab whose file the APP is renaming right now', async () => {
    // Renaming a note from the file tree makes the watcher report its PARENT
    // folder while the tab still points at the old name, and the old name stops
    // existing the moment the rename lands - `renamePathInTabs` runs after the
    // disk work. Reading it here found nothing, so the app announced that the
    // user's own rename had happened "outside the app", detached the tab (it
    // became "Untitled") and made the next Ctrl+S open a native save-as instead
    // of saving to the note that had just been renamed.
    const h = harness({
      openTabs: [{ id: 'tab-1', path: 'C:\\vault\\docs\\note.md' }],
      unreadable: ['C:\\vault\\docs\\note.md'],
      pendingMove: ['C:\\vault\\docs\\note.md'],
    })
    await h.sync.start()
    h.emit({ path: 'C:\\vault\\docs', kind: 'modified' })
    await h.flush()
    expect(h.onMissing).not.toHaveBeenCalled()
  })

  it('does not detach tabs inside a folder the APP is renaming', async () => {
    // A folder rename carries its notes: every tab under the old folder name is
    // missing on disk until the move finishes AND retargets them.
    const h = harness({
      openTabs: [{ id: 'tab-1', path: 'C:\\vault\\docs\\inside.md' }],
      unreadable: ['C:\\vault\\docs\\inside.md'],
      pendingMove: ['C:\\vault\\docs'],
    })
    await h.sync.start()
    h.emit({ path: 'C:\\vault', kind: 'modified' })
    await h.flush()
    expect(h.onMissing).not.toHaveBeenCalled()
  })

  it('detaches again once the move is over and the file is really gone', async () => {
    // The guard must be a window, not a permanent exemption: a file that stays
    // missing after the app's move finished is exactly the case the detach
    // exists for.
    const h = harness({
      openTabs: [{ id: 'tab-1', path: 'C:\\vault\\docs\\note.md' }],
      unreadable: ['C:\\vault\\docs\\note.md'],
      pendingMove: ['C:\\vault\\docs\\other.md'],
    })
    await h.sync.start()
    h.emit({ path: 'C:\\vault\\docs', kind: 'modified' })
    await h.flush()
    expect(h.onMissing).toHaveBeenCalledWith('tab-1', 'C:\\vault\\docs\\note.md')
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

describe('watcher resync', () => {
  it('re-checks every open tab when the watcher reports it lost events', async () => {
    // `resync` is not a change to one path: it means events may have been
    // dropped entirely. Waiting for per-path events that will never arrive
    // leaves the editor showing stale text, and the next save then overwrites
    // the newer file with it.
    const h = harness({
      disk: 'newer text from another program',
      savedContent: 'old text',
      openTabs: [
        { id: 'tab-1', path: 'C:\\vault\\a.md' },
        { id: 'tab-2', path: 'C:\\vault\\b.md' },
      ],
    })
    await h.sync.start()

    h.emit({ path: 'C:\\vault', kind: 'resync' })
    await h.flush()

    expect(h.read).toHaveBeenCalledWith('C:\\vault', 'C:\\vault\\a.md')
    expect(h.read).toHaveBeenCalledWith('C:\\vault', 'C:\\vault\\b.md')
    expect(h.reload).toHaveBeenCalledWith('tab-1')
  })

  it('detaches a tab whose file is gone', async () => {
    const h = harness({
      unreadable: ['C:\\vault\\gone.md'],
      path: 'C:\\vault\\gone.md',
      openTabs: [{ id: 'tab-1', path: 'C:\\vault\\gone.md' }],
    })
    await h.sync.start()

    h.emit({ path: 'C:\\vault', kind: 'resync' })
    await h.flush()

    expect(h.onMissing).toHaveBeenCalledWith('tab-1', 'C:\\vault\\gone.md')
  })

  it('leaves a tab alone when its bytes still match', async () => {
    const h = harness({ disk: 'same text', savedContent: 'same text' })
    await h.sync.start()

    h.emit({ path: 'C:\\vault', kind: 'resync' })
    await h.flush()

    expect(h.reload).not.toHaveBeenCalled()
    expect(h.onConflict).not.toHaveBeenCalled()
  })
})

/**
 * The subscription's own lifetime.
 *
 * `onFsChange` here books a registration **per call**, the way the Tauri adapter
 * does — `listen()` installs its own wrapper and backend id, so two
 * registrations are genuinely independent and unlistening one leaves the other
 * live. A stub that keys by callback identity would fold them together and hide
 * both defects below, which is exactly what the renderer's memory adapter used
 * to do.
 */
function subscriptionHarness({ defer = false }: { defer?: boolean } = {}) {
  const live = new Set<symbol>()
  const resolvers: Array<() => void> = []
  const sync = createExternalDocSync({
    read: async () => 'disk',
    onFsChange: () => {
      const id = Symbol('registration')
      const unsubscribe = () => live.delete(id)
      // `defer` is for the races: two starts must be able to be in flight at
      // once, which needs a registration nobody has resolved yet. The default
      // resolves at once so an ordinary `await start()` cannot deadlock on a
      // settle that is only scheduled after it returns.
      if (!defer) {
        live.add(id)
        return Promise.resolve(unsubscribe)
      }
      return new Promise<() => void>((resolve) => {
        resolvers.push(() => {
          live.add(id)
          resolve(unsubscribe)
        })
      })
    },
    getVault: () => 'C:\\vault',
    getActiveTab: () => null,
    isSelfWrite: () => false,
    reload: async () => undefined,
    onConflict: () => undefined,
    onChange: () => undefined,
    onMissing: () => undefined,
    getOpenTabs: () => [],
  })
  return {
    sync,
    liveCount: () => live.size,
    /** Let every pending `onFsChange` resolve, without awaiting in test order. */
    async settle(): Promise<void> {
      const pending = resolvers.splice(0, resolvers.length)
      for (const r of pending) r()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe('the fs-change subscription is not leaked', () => {
  it('two starts in flight leave exactly one live registration', async () => {
    const h = subscriptionHarness({ defer: true })
    const first = h.sync.start()
    const second = h.sync.start()
    await h.settle()
    await Promise.all([first, second])

    // Before the fix both registrations were stored, the second overwriting the
    // first — and nothing held the first's unsubscribe, so it stayed live for
    // the rest of the session.
    expect(h.liveCount()).toBe(1)

    h.sync.stop()
    expect(h.liveCount()).toBe(0)
  })

  it('a stop during start leaves nothing live', async () => {
    const h = subscriptionHarness({ defer: true })
    const starting = h.sync.start()
    h.sync.stop()
    await h.settle()
    await starting

    // Before the fix the registration landed after `stop()` had nulled the
    // field, so it was never stored and never unlistened: a live listener on an
    // object the caller believes is stopped.
    expect(h.liveCount()).toBe(0)
  })

  it('start/stop/start leaves exactly one live registration', async () => {
    const h = subscriptionHarness()
    await h.sync.start()
    await h.settle()
    h.sync.stop()
    expect(h.liveCount()).toBe(0)
    await h.sync.start()
    await h.settle()
    expect(h.liveCount()).toBe(1)
    h.sync.stop()
    expect(h.liveCount()).toBe(0)
  })

  it('a second start after a first succeeded is a no-op', async () => {
    const h = subscriptionHarness()
    await h.sync.start()
    await h.settle()
    await h.sync.start()
    await h.settle()
    expect(h.liveCount()).toBe(1)
    h.sync.stop()
  })
})
