import { describe, expect, it, vi } from 'vitest'
import { createExternalDocSync, type OpenDocTab } from './external-doc-sync'
import type { FsChangeEvent } from '../platform/gateways/contracts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function harness() {
  const readResult = deferred<string>()
  const tab: OpenDocTab = { id: 'one', path: '/vault/a.md', dirty: false, savedContent: 'old' }
  const state = { vault: '/vault', tabs: [tab], moving: false }
  const handlers: Array<(event: FsChangeEvent) => void> = []
  const onMissing = vi.fn()
  const reload = vi.fn(async () => {})
  const onConflict = vi.fn()
  const read = vi.fn(() => readResult.promise)
  const sync = createExternalDocSync({
    getOpenTabs: () => state.tabs.map((open) => ({ ...open })),
    getVault: () => state.vault,
    read,
    onFsChange: async (handler) => { handlers.push(handler); return () => {} },
    isSelfWrite: () => false,
    isPendingMove: () => state.moving,
    reload,
    onMissing,
    onConflict,
  })
  await sync.start()
  const emit = () => handlers.at(-1)!({ kind: 'modified', path: '/vault/a.md' })
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  return { tab, state, handlers, readResult, onMissing, reload, onConflict, read, sync, emit, flush }
}

const MISSING = 'could not read /vault/a.md: no such file or folder (os error 2)'

describe('external document read identity', () => {
  it.each(['missing', 'changed'] as const)(
    'ignores an older %s result after a newer event confirms the saved bytes',
    async (outcome) => {
      const h = await harness()
      const latest = deferred<string>()
      h.read.mockReturnValueOnce(h.readResult.promise).mockReturnValueOnce(latest.promise)
      h.emit()
      h.emit()
      latest.resolve('old')
      await h.flush()
      if (outcome === 'missing') h.readResult.reject(MISSING)
      else h.readResult.resolve('obsolete contents')
      await h.flush()
      expect(h.onMissing).not.toHaveBeenCalled()
      expect(h.reload).not.toHaveBeenCalled()
      expect(h.onConflict).not.toHaveBeenCalled()
      h.sync.stop()
    },
  )

  it('does not invalidate another tab when a newer event targets a different file', async () => {
    const h = await harness()
    h.state.tabs.push({ ...h.tab, id: 'two', path: '/vault/b.md' })
    const other = deferred<string>()
    h.read.mockReturnValueOnce(h.readResult.promise).mockReturnValueOnce(other.promise)
    h.emit()
    h.handlers[0]({ kind: 'modified', path: '/vault/b.md' })
    other.resolve('external b')
    await h.flush()
    h.readResult.resolve('external a')
    await h.flush()
    expect(h.reload.mock.calls).toEqual([['two'], ['one']])
    h.sync.stop()
  })

  it('does not let a resync queued behind one tab override a newer file event', async () => {
    const h = await harness()
    h.state.tabs.push({ ...h.tab, id: 'two', path: '/vault/b.md' })
    const latest = deferred<string>()
    h.read.mockReturnValueOnce(h.readResult.promise).mockReturnValueOnce(latest.promise)
    h.handlers[0]({ kind: 'resync', path: '/vault' })
    h.handlers[0]({ kind: 'modified', path: '/vault/b.md' })
    latest.resolve('old')
    await h.flush()
    h.readResult.resolve('old')
    await h.flush()
    expect(h.read).toHaveBeenCalledTimes(2)
    h.sync.stop()
  })

  it('ignores callbacks retained from a stopped registration after restart', async () => {
    const h = await harness()
    const oldHandler = h.handlers[0]
    h.sync.stop()
    await h.sync.start()
    oldHandler({ kind: 'modified', path: '/vault/a.md' })
    expect(h.read).not.toHaveBeenCalled()
    h.sync.stop()
  })

  it('does not read the next tab under an obsolete vault after a resync read', async () => {
    const h = await harness()
    h.state.tabs.push({ ...h.tab, id: 'two', path: '/vault/b.md' })
    h.handlers[0]({ kind: 'resync', path: '/vault' })
    h.state.vault = '/other'
    h.readResult.resolve('external')
    await h.flush()
    expect(h.read).toHaveBeenCalledOnce()
    expect(h.reload).not.toHaveBeenCalled()
    h.sync.stop()
  })

  for (const outcome of ['missing', 'changed'] as const) {
    it.each(['rename', 'move', 'close', 'vault', 'stop', 'restart'])(
      `ignores a ${outcome} read after %s invalidates it`,
      async (change) => {
        const h = await harness()
        h.emit()
        expect(h.read).toHaveBeenCalledOnce()
        if (change === 'rename') h.tab.path = '/vault/b.md'
        if (change === 'move') h.state.moving = true
        if (change === 'close') h.state.tabs = []
        if (change === 'vault') h.state.vault = '/other'
        if (change === 'stop' || change === 'restart') h.sync.stop()
        if (change === 'restart') await h.sync.start()
        if (outcome === 'missing') h.readResult.reject(MISSING)
        else h.readResult.resolve('external contents')
        await h.flush()
        expect(h.onMissing).not.toHaveBeenCalled()
        expect(h.reload).not.toHaveBeenCalled()
        expect(h.onConflict).not.toHaveBeenCalled()
        h.sync.stop()
      },
    )
  }

  it.each([
    'could not read /vault/a.md: permission denied (os error 13)',
    'could not read /vault/a.md: input/output error (os error 5)',
    'could not read /vault/a.md: stream did not contain valid UTF-8',
    'could not read /vault/no such file or folder.md: permission denied (os error 13)',
  ])('does not detach on another read failure: %s', async (error) => {
    const h = await harness()
    h.emit()
    h.readResult.reject(error)
    await h.flush()
    expect(h.onMissing).not.toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()
    h.sync.stop()
  })

  it.each([MISSING, new Error('No such file in demo vault: /vault/a.md')])(
    'detaches the still-current path on a genuine missing-file error',
    async (error) => {
      const h = await harness()
      h.emit()
      h.readResult.reject(error)
      await h.flush()
      expect(h.onMissing).toHaveBeenCalledWith('one', '/vault/a.md')
      h.sync.stop()
    },
  )
})
