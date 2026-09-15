import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import { createOpenFileHandler, type OpenFileDeps } from './open-file'
import type { OpenFileRequest } from '../platform/open-request'

const OPEN: OpenFileRequest = {
  kind: 'open',
  path: '/vault/notes/a.md',
  root: '/vault',
  same_vault: true,
}

function harness(overrides: Partial<OpenFileDeps> = {}) {
  const vaultPath: Ref<string | null> = ref<string | null>(null)
  const applyVault = vi.fn(async (path: string) => {
    vaultPath.value = path
  })
  // The signatures are declared rather than inferred from the bodies: a bare
  // `vi.fn(async () => {})` types as taking no arguments, so the tests that
  // drive it with a path (`.mockImplementation(async (path: string) => …)`)
  // are a type error even though the body ignores its own parameter. Vitest
  // strips types, so the tests pass anyway; `vue-tsc` is the only thing that
  // sees it.
  const openTab = vi.fn<(path: string) => Promise<void>>(async () => {})
  const notifyError = vi.fn()
  const takePendingOpen = vi.fn(async (): Promise<OpenFileRequest | null> => null)
  let doorbell: (() => void) | null = null
  const off = vi.fn()
  // Returning `off` means this mock's type is `Promise<typeof off>` — a
  // `Mock<Procedure>` — unless the return is stated, and the teardown test
  // resolves its own promise with a plain `() => void`.
  const onOpenFileRequest = vi.fn(async (cb: () => void): Promise<() => void> => {
    doorbell = cb
    return off
  })
  const deps: OpenFileDeps = {
    vaultPath,
    applyVault,
    openTab,
    notifyError,
    takePendingOpen,
    onOpenFileRequest,
    ...overrides,
  }
  return {
    vaultPath,
    applyVault,
    openTab,
    notifyError,
    takePendingOpen,
    onOpenFileRequest,
    off,
    ring: () => doorbell?.(),
    handler: createOpenFileHandler(deps),
  }
}

describe('createOpenFileHandler', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('a file already inside the open vault', () => {
    it('opens a tab and leaves the vault alone', async () => {
      const h = harness()
      h.vaultPath.value = '/vault'

      await expect(h.handler.handle(OPEN)).resolves.toBe(true)

      // The whole point of the same_vault branch: a file the user is already
      // working next to must not tear the session down and rebuild it.
      expect(h.applyVault).not.toHaveBeenCalled()
      expect(h.openTab).toHaveBeenCalledWith('/vault/notes/a.md')
    })

    it('is still switched when the window has no vault of its own yet', async () => {
      // The backend answers `same_vault` from the vault startup is ABOUT to
      // restore. A request that lands before that happened (or after it failed)
      // would otherwise be opened with no vault at all, and `openTab` refuses
      // exactly that with "open a vault first".
      const h = harness()
      h.vaultPath.value = null

      await h.handler.handle(OPEN)

      // `remember: true` here, because this root IS the user's vault — the one
      // startup is restoring. Recording it is what it was already recorded as.
      expect(h.applyVault).toHaveBeenCalledWith('/vault', { remember: true })
      expect(h.openTab).toHaveBeenCalledWith('/vault/notes/a.md')
    })
  })

  describe('a file outside the vault', () => {
    const OUTSIDE: OpenFileRequest = {
      kind: 'open',
      path: '/elsewhere/b.md',
      root: '/elsewhere',
      same_vault: false,
    }

    it('serves the document without making the folder the workspace', async () => {
      // `same_vault: false` is the backend's answer that this root is NOT one
      // of the user's: it is the file's own folder, adopted by the launch that
      // was handed it. So the switch that serves the file must not record it —
      // `remember: false` — or one double-click on `~/Downloads/report.md` would
      // make `~/Downloads` the vault the next launch starts on, and take the
      // session keyed to the real vault with it.
      const h = harness()
      h.vaultPath.value = '/vault'

      await expect(h.handler.handle(OUTSIDE)).resolves.toBe(true)

      expect(h.applyVault).toHaveBeenCalledWith('/elsewhere', { remember: false })
      expect(h.openTab).toHaveBeenCalledWith('/elsewhere/b.md')
    })

    it('moves the vault through the ordinary switch, then opens the tab', async () => {
      const h = harness()
      const order: string[] = []
      h.applyVault.mockImplementation(async (path: string) => {
        order.push(`switch:${path}`)
        h.vaultPath.value = path
      })
      h.openTab.mockImplementation(async (path: string) => {
        order.push(`open:${path}`)
      })

      await expect(h.handler.handle(OUTSIDE)).resolves.toBe(true)

      // Reusing the switch is what makes the outgoing vault's dirty tabs get
      // flushed and its index/watcher/plugins disposed; a second implementation
      // beside it is the defect this asserts against.
      expect(order).toEqual(['switch:/elsewhere', 'open:/elsewhere/b.md'])
    })

    it('does not open the file when a dirty tab refused to save', async () => {
      // The refusal path: `applyVault` reports the unsaved-work blocker and
      // returns WITHOUT committing, leaving `vaultPath` on the vault we are
      // still on. Opening the file now would open it under that vault, where
      // its path is outside the root.
      const h = harness()
      h.vaultPath.value = '/vault'
      h.applyVault.mockImplementation(async () => {})

      await expect(h.handler.handle(OUTSIDE)).resolves.toBe(false)

      expect(h.openTab).not.toHaveBeenCalled()
      // The blocker is the switch's own message; a second one here would say the
      // same thing twice.
      expect(h.notifyError).not.toHaveBeenCalled()
    })

    it('does not open the file when the vault root could not be registered', async () => {
      const h = harness()
      h.vaultPath.value = '/vault'
      h.applyVault.mockImplementation(async () => {})

      await h.handler.handle(OUTSIDE)

      expect(h.openTab).not.toHaveBeenCalled()
    })
  })

  describe('a refused path', () => {
    it('says why and opens nothing', async () => {
      const h = harness()
      h.vaultPath.value = '/vault'

      await expect(
        h.handler.handle({ kind: 'refused', message: '/root/a.md is not a file' }),
      ).resolves.toBe(false)

      expect(h.notifyError).toHaveBeenCalledWith('/root/a.md is not a file')
      expect(h.applyVault).not.toHaveBeenCalled()
      expect(h.openTab).not.toHaveBeenCalled()
    })
  })

  describe('drain', () => {
    it('does nothing when the backend is holding no request', async () => {
      const h = harness()

      await expect(h.handler.drain()).resolves.toBe(false)

      expect(h.openTab).not.toHaveBeenCalled()
    })

    it('carries out the request the backend is holding', async () => {
      const h = harness()
      h.vaultPath.value = '/vault'
      h.takePendingOpen.mockResolvedValue(OPEN)

      await expect(h.handler.drain()).resolves.toBe(true)

      expect(h.openTab).toHaveBeenCalledWith('/vault/notes/a.md')
    })

    it('opens nothing after teardown', async () => {
      const h = harness()
      h.vaultPath.value = '/vault'
      h.takePendingOpen.mockResolvedValue(OPEN)

      h.handler.dispose()

      await expect(h.handler.drain()).resolves.toBe(false)
      expect(h.openTab).not.toHaveBeenCalled()
    })
  })

  describe('the second-launch doorbell', () => {
    it('collects whatever the backend is holding', async () => {
      const h = harness()
      h.vaultPath.value = '/vault'
      h.takePendingOpen.mockResolvedValue(OPEN)

      h.handler.subscribe()
      h.handler.markReady()
      h.ring()
      await vi.waitFor(() => expect(h.openTab).toHaveBeenCalledWith('/vault/notes/a.md'))
    })

    it('is held until startup has settled, and then acts', async () => {
      // The defect this exists for. `start()` arms the listener BEFORE the
      // startup pull, so a double-click during startup ran a second
      // `applyVault` concurrently with the one restoring the user's vault —
      // and the switch is latest-wins, so the restore lost: either the tab set
      // was never reopened, or the new root committed while the restore loop was
      // still reading the old vault's paths. It is `PendingOpen`'s problem one
      // layer up, and it takes the same answer: the request waits in state
      // until something can act on it.
      const h = harness()
      h.vaultPath.value = '/vault'
      h.takePendingOpen.mockResolvedValue({
        kind: 'open',
        path: '/elsewhere/b.md',
        root: '/elsewhere',
        same_vault: false,
      })

      h.handler.subscribe()
      h.ring()
      // Every microtask the pre-fix handler needed is available here, so an
      // unheld doorbell would have switched the vault by this line.
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(h.applyVault).not.toHaveBeenCalled()

      h.handler.markReady()
      await vi.waitFor(() => expect(h.openTab).toHaveBeenCalledWith('/elsewhere/b.md'))
      expect(h.applyVault).toHaveBeenCalledWith('/elsewhere', { remember: false })
    })

    it('does not hold the startup pull that releases it', async () => {
      // The held doorbell must not be held by a gate only the startup drain can
      // open: `drain` is what startup calls, and a version of it that waited on
      // its own barrier would park the launch request forever.
      const h = harness()
      h.vaultPath.value = '/vault'
      h.takePendingOpen.mockResolvedValue(OPEN)

      h.handler.subscribe()
      h.ring()

      await expect(h.handler.drain()).resolves.toBe(true)
      expect(h.openTab).toHaveBeenCalledWith('/vault/notes/a.md')
    })

    it('opens nothing when the request arrives after teardown', async () => {
      const h = harness()
      h.vaultPath.value = '/vault'
      h.takePendingOpen.mockResolvedValue(OPEN)

      h.handler.subscribe()
      await vi.waitFor(() => expect(h.onOpenFileRequest).toHaveBeenCalled())
      h.handler.dispose()
      h.ring()

      expect(h.openTab).not.toHaveBeenCalled()
      expect(h.off).toHaveBeenCalled()
    })

    it('releases a subscription that lands after teardown', async () => {
      // The registration settles after an await, so a teardown can overtake it;
      // nothing else holds the unsubscriber, so only this continuation can
      // release it.
      const h = harness()
      let settle: (off: () => void) => void = () => {}
      h.onOpenFileRequest.mockImplementation(
        () => new Promise<() => void>((resolve) => { settle = resolve }),
      )

      h.handler.subscribe()
      h.handler.dispose()
      settle(h.off)

      await vi.waitFor(() => expect(h.off).toHaveBeenCalled())
    })
  })
})
