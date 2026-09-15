import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const gateways = {
    fs: {
      registerVault: vi.fn(),
      read: vi.fn(),
      write: vi.fn(),
      list: vi.fn(),
      stat: vi.fn(),
      deleteFile: vi.fn(),
      renameEntry: vi.fn(),
      listHistory: vi.fn(),
      readHistory: vi.fn(),
      restoreHistory: vi.fn(),
      saveFileDialog: vi.fn(),
      watch: vi.fn(),
      // The runtime subscribes to reference-file changes: the port is required
      // by the contract, and a mock without it made every switch throw.
      onFsChange: vi.fn(async () => () => {}),
    },
    dialogs: { openFolderDialog: vi.fn(), saveFileDialog: vi.fn() },
    events: { on: vi.fn(), emit: vi.fn() },
    ai: { complete: vi.fn(), cancel: vi.fn(), listModels: vi.fn() },
    keys: { storeAiKey: vi.fn(), loadAiKey: vi.fn() },
  }
  const tabsMock = {
    openTab: vi.fn(),
    flushDirty: vi.fn(),
    reconcilePlaceholders: vi.fn(),
    untitledDirtyTabs: vi.fn(),
    saveTab: vi.fn(),
    /** The gate the switch asks for a tab with no path yet: the Save-As write's
     *  `true` says one write landed, and `removeAllTabs()` follows immediately
     *  (`tab-settle.ts`). */
    saveUntilSettled: vi.fn(),
    removeTab: vi.fn(),
    removeAllTabs: vi.fn(),
    setVault: vi.fn(),
    restoreSession: vi.fn(),
    captureSession: vi.fn(),
    referencedTmpPaths: vi.fn(),
  }
  const settingsMock = { loadKey: vi.fn() }
  const vaultSessionMock = { indexVault: vi.fn(), detachVault: vi.fn(), cancelSearchIndexBuild: vi.fn() }
  const refsMock = { loadVault: vi.fn(), clear: vi.fn() }
  return {
    gateways,
    tabsMock,
    settingsMock,
    vaultSessionMock,
    refsMock,
    loadVaultPlugins: vi.fn(),
    deactivateVaultPlugins: vi.fn(),
    vaultFileIndex: {
      get: vi.fn(),
      isTruncated: vi.fn(() => false),
      isIncomplete: vi.fn(() => false),
    },
    tmpRecovery: { scan: vi.fn(), gc: vi.fn(), cancel: vi.fn(), isCancelled: vi.fn() },
    createTmpRecovery: vi.fn(),
    windowTracking: { restore: vi.fn(), start: vi.fn(), flush: vi.fn(), dispose: vi.fn() },
    requestUntitledVaultSwitch: vi.fn(),
    setActiveEditor: vi.fn(),
    editorBridgeSetEditor: vi.fn(),
    editorSessionManager: { destroyAll: vi.fn(), destroySession: vi.fn() },
    notifyError: vi.fn(),
    notifyRecovery: vi.fn(),
    takePendingOpen: vi.fn(),
    onOpenFileRequest: vi.fn(),
  }
})

vi.mock('../platform/runtime/gateway-runtime', () => ({
  getSharedGateways: () => h.gateways,
  initSharedGateways: vi.fn(),
  resetSharedGateways: vi.fn(),
}))

vi.mock('./window-state', () => ({
  setupWindowTracking: () => h.windowTracking,
}))

vi.mock('./recovery-closed-loop', () => ({
  createTmpRecovery: h.createTmpRecovery,
  requestUntitledVaultSwitch: h.requestUntitledVaultSwitch,
}))

vi.mock('../services/vault-files', () => ({
  vaultFileIndex: h.vaultFileIndex,
}))

vi.mock('../services/plugins', () => ({
  loadVaultPlugins: h.loadVaultPlugins,
  deactivateVaultPlugins: h.deactivateVaultPlugins,
}))

vi.mock('../services/editor-bridge', () => ({
  editorBridge: {
    setEditor: h.editorBridgeSetEditor,
    getEditor: vi.fn(),
    getView: vi.fn(),
    onEditorChange: vi.fn(),
  },
}))

vi.mock('@nekowite/plugin-host', () => ({
  setActiveEditor: h.setActiveEditor,
  // The bootstrap reaches the editor feature's entry point, which loads the
  // callout plugin: it defines itself through this factory at module scope, so
  // the mock has to carry it even though nothing in this file calls it.
  definePlugin: (def: unknown) => def,
}))

vi.mock('../features/editor/session-manager', () => ({
  editorSessionManager: h.editorSessionManager,
}))

vi.mock('../platform/open-request', () => ({
  takePendingOpen: h.takePendingOpen,
  onOpenFileRequest: h.onOpenFileRequest,
  OPEN_FILE_EVENT: 'open-file-request',
}))

vi.mock('../stores/tabs', () => ({ useTabsStore: () => h.tabsMock }))
vi.mock('../stores/settings', () => ({ useSettingsStore: () => h.settingsMock }))
vi.mock('../stores/vault-session', () => ({ useVaultSessionStore: () => h.vaultSessionMock }))
vi.mock('../stores/refs', () => ({ useRefsStore: () => h.refsMock }))

vi.mock('../services/errors', () => ({
  notifyError: h.notifyError,
  notifyRecovery: h.notifyRecovery,
}))

vi.mock('../i18n', () => ({
  t: (key: string): string => key,
}))

import { createDesktopRuntime } from './app-bootstrap'

const VAULT_LS_KEY = 'nekowite.vault'

describe('createDesktopRuntime', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.removeItem(VAULT_LS_KEY)
    // Default store behaviors.
    h.tabsMock.flushDirty.mockResolvedValue(true)
    h.tabsMock.untitledDirtyTabs.mockReturnValue([])
    h.tabsMock.saveTab.mockResolvedValue(true)
    h.tabsMock.saveUntilSettled.mockResolvedValue(true)
    h.tabsMock.removeTab.mockImplementation(() => {})
    h.tabsMock.removeAllTabs.mockImplementation(() => {})
    h.tabsMock.setVault.mockImplementation(() => {})
    h.tabsMock.restoreSession.mockResolvedValue(undefined)
    h.tabsMock.captureSession.mockImplementation(() => {})
    h.tabsMock.referencedTmpPaths.mockReturnValue(new Set())
    h.settingsMock.loadKey.mockResolvedValue(undefined)
    h.vaultSessionMock.indexVault.mockResolvedValue(undefined)
    h.vaultSessionMock.detachVault.mockImplementation(() => {})
    h.vaultSessionMock.cancelSearchIndexBuild.mockImplementation(() => {})
    h.refsMock.loadVault.mockResolvedValue(undefined)
    h.refsMock.clear.mockImplementation(() => {})
    h.loadVaultPlugins.mockResolvedValue(undefined)
    h.deactivateVaultPlugins.mockImplementation(() => {})
    h.gateways.fs.registerVault.mockResolvedValue(undefined)
    h.gateways.fs.watch.mockResolvedValue(undefined)
    h.windowTracking.restore.mockResolvedValue(undefined)
    h.windowTracking.start.mockResolvedValue(undefined)
    h.requestUntitledVaultSwitch.mockResolvedValue('save')
    h.editorSessionManager.destroyAll.mockImplementation(() => {})
    h.createTmpRecovery.mockReturnValue(h.tmpRecovery)
    h.vaultFileIndex.get.mockResolvedValue([])
    // The ordinary launch names no file; a test that wants one says so.
    h.takePendingOpen.mockResolvedValue(null)
    h.onOpenFileRequest.mockResolvedValue(() => {})
  })

  describe('start (startup ordering)', () => {
    it('awaits applyVault before restoreSession (never restores into the wrong vault)', async () => {
      let resolveFlush: () => void = () => {}
      h.tabsMock.flushDirty.mockImplementationOnce(
        () => new Promise<boolean>((r) => { resolveFlush = () => r(true) }),
      )
      h.tabsMock.flushDirty.mockResolvedValue(true)
      localStorage.setItem(VAULT_LS_KEY, '/vault')

      const runtime = createDesktopRuntime()
      runtime.start()

      // While the vault switch is still pending, restoreSession must NOT run.
      expect(h.tabsMock.restoreSession).not.toHaveBeenCalled()

      // The switch reaches its flush a step in (the placeholder reconciliation
      // runs first), so resolve it only once it is actually parked there — and
      // check again that nothing has been restored meanwhile.
      await vi.waitFor(() => expect(h.tabsMock.flushDirty).toHaveBeenCalled())
      expect(h.tabsMock.restoreSession).not.toHaveBeenCalled()
      resolveFlush()
      await vi.waitFor(() => expect(h.tabsMock.restoreSession).toHaveBeenCalled())

      expect(h.tabsMock.setVault).toHaveBeenCalledWith('/vault')
      expect(h.gateways.fs.watch).toHaveBeenCalledWith('/vault')
      expect(runtime.vaultPath.value).toBe('/vault')
      expect(h.windowTracking.start).toHaveBeenCalled()
    })

    it('starts and opens a vault even when every storage access throws', async () => {
      // C3: a webview with storage disabled throws on the localStorage GETTER, so
      // startup used to fail before the first render (white screen) and a vault
      // switch aborted after the root was registered and the tabs were closed.
      const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
      if (!original) throw new Error('the test setup did not install a localStorage')
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new Error('storage disabled')
        },
      })
      try {
        const runtime = createDesktopRuntime()
        expect(() => runtime.start()).not.toThrow()
        await vi.waitFor(() => expect(h.tabsMock.restoreSession).toHaveBeenCalled())

        await expect(runtime.applyVault('/next')).resolves.toBeUndefined()
        expect(runtime.vaultPath.value).toBe('/next')
        expect(h.vaultSessionMock.indexVault).toHaveBeenCalledWith('/next')
      } finally {
        Object.defineProperty(window, 'localStorage', original)
      }
    })

    it('does not apply a vault when none was saved, but still restores the session', async () => {
      const runtime = createDesktopRuntime()
      runtime.start()
      // Window tracking is armed in `runStartup`'s `finally`, i.e. after the
      // session restore AND after the launch request has been drained — so it is
      // the end of startup, and the thing to wait for.
      await vi.waitFor(() => expect(h.windowTracking.start).toHaveBeenCalled())
      expect(h.tabsMock.restoreSession).toHaveBeenCalled()
      expect(h.gateways.fs.registerVault).not.toHaveBeenCalled()
      expect(runtime.vaultPath.value).toBeNull()
    })
  })

  describe('the file the OS launched the app with', () => {
    const INSIDE = {
      kind: 'open' as const,
      path: '/vault/notes/a.md',
      root: '/vault',
      same_vault: true,
    }
    const OUTSIDE = {
      kind: 'open' as const,
      path: '/elsewhere/b.md',
      root: '/elsewhere',
      same_vault: false,
    }

    it('opens it once the vault startup restores is in place', async () => {
      h.takePendingOpen.mockResolvedValue(INSIDE)
      localStorage.setItem(VAULT_LS_KEY, '/vault')

      const runtime = createDesktopRuntime()
      runtime.start()

      await vi.waitFor(() => expect(h.tabsMock.openTab).toHaveBeenCalledWith('/vault/notes/a.md'))
      // The request meets a fully-started app: the remembered vault is open and
      // the last session is back, so the file joins that session instead of
      // replacing it.
      expect(h.gateways.fs.registerVault).toHaveBeenCalledWith('/vault')
      expect(h.tabsMock.restoreSession).toHaveBeenCalled()
    })

    it('moves the vault when the file lives in another folder, and opens it there', async () => {
      h.takePendingOpen.mockResolvedValue(OUTSIDE)
      localStorage.setItem(VAULT_LS_KEY, '/vault')

      const runtime = createDesktopRuntime()
      runtime.start()

      await vi.waitFor(() => expect(h.tabsMock.openTab).toHaveBeenCalledWith('/elsewhere/b.md'))
      // Through the ordinary switch: the same one the sidebar and the settings
      // panel use, which is what flushes dirty tabs and re-arms the index.
      expect(h.gateways.fs.registerVault).toHaveBeenCalledWith('/elsewhere')
      expect(runtime.vaultPath.value).toBe('/elsewhere')
      expect(h.tabsMock.setVault).toHaveBeenLastCalledWith('/elsewhere')
      // The restored tabs belong to the vault we left.
      expect(h.tabsMock.removeAllTabs).toHaveBeenCalled()
    })

    it('serves an outside file without repointing the vault the next launch opens on', async () => {
      // The defect, end to end. Opening a file outside every vault went through
      // the ordinary switch, which records the root: one double-click on
      // `~/Downloads/report.md` made that folder the vault from then on, and the
      // session keyed to the real vault could not be restored — the next launch
      // never came back to it. The document still opens; the workspace does not
      // move.
      h.takePendingOpen.mockResolvedValue(OUTSIDE)
      localStorage.setItem(VAULT_LS_KEY, '/vault')

      const runtime = createDesktopRuntime()
      runtime.start()

      await vi.waitFor(() => expect(h.tabsMock.openTab).toHaveBeenCalledWith('/elsewhere/b.md'))
      // The file is served from a root the backend vouched for for it...
      expect(h.gateways.fs.registerVault).toHaveBeenCalledWith('/elsewhere')
      expect(runtime.vaultPath.value).toBe('/elsewhere')
      // ...and the record still names the vault the user was working in, so the
      // launch after this one comes back to it — and to its session.
      expect(localStorage.getItem(VAULT_LS_KEY)).toBe('/vault')
    })

    it('does not open the file when the switch is blocked by unsaved work', async () => {
      // The one refusal this brief allows: a dirty tab that will not save stops
      // the switch, `applyVault` says so in its own words, and the file must not
      // open — under the vault we are still on its path is outside the root.
      h.takePendingOpen.mockResolvedValue(OUTSIDE)
      h.tabsMock.flushDirty.mockResolvedValue(false)

      const runtime = createDesktopRuntime()
      runtime.start()

      await vi.waitFor(() => expect(h.notifyError).toHaveBeenCalled())
      expect(h.tabsMock.openTab).not.toHaveBeenCalled()
      expect(runtime.vaultPath.value).toBeNull()
    })

    it('opens a file that arrives while the app is running', async () => {
      // The second entry point: `nekowite other.md` with a window already open,
      // or a double-click. The backend rings; nothing was waiting at startup.
      const runtime = createDesktopRuntime()
      runtime.start()
      await vi.waitFor(() => expect(h.onOpenFileRequest).toHaveBeenCalled())
      h.takePendingOpen.mockResolvedValue(INSIDE)
      await runtime.applyVault('/vault')

      const doorbell = h.onOpenFileRequest.mock.calls[0][0] as () => void
      doorbell()

      await vi.waitFor(() => expect(h.tabsMock.openTab).toHaveBeenCalledWith('/vault/notes/a.md'))
    })

    it('carries out a request that arrives while startup is still running, once', async () => {
      // A double-click during startup rings the doorbell before the startup pull
      // has happened. Both triggers go through the same `takePendingOpen`, which
      // empties the backend's slot (faithfully doubled here), so the file opens
      // once rather than once per trigger.
      let waiting: typeof INSIDE | null = INSIDE
      h.takePendingOpen.mockImplementation(async () => {
        const request = waiting
        waiting = null
        return request
      })

      const runtime = createDesktopRuntime()
      runtime.start()
      await vi.waitFor(() => expect(h.onOpenFileRequest).toHaveBeenCalled())
      const doorbell = h.onOpenFileRequest.mock.calls[0][0] as () => void
      doorbell()

      await vi.waitFor(() => expect(h.tabsMock.openTab).toHaveBeenCalledWith('/vault/notes/a.md'))
      await vi.waitFor(() => expect(h.tabsMock.restoreSession).toHaveBeenCalled())
      expect(h.tabsMock.openTab).toHaveBeenCalledTimes(1)
    })

    it('holds a request that arrives mid-startup out of the way of the restore', async () => {
      // The defect (c), at the level where it did its damage. `start()` arms the
      // launch listener BEFORE the startup pull, so a double-click while startup
      // was still switching ran its own `applyVault` concurrently with the one
      // restoring the user's vault. The switch is latest-wins, so the startup one
      // was aborted where it stood: the restored tab set was never reopened, and
      // the new root committed while the restore loop was still reading the old
      // vault's paths.
      let resolveFlush: () => void = () => {}
      h.tabsMock.flushDirty.mockImplementationOnce(
        () => new Promise<boolean>((r) => { resolveFlush = () => r(true) }),
      )
      h.tabsMock.flushDirty.mockResolvedValue(true)
      localStorage.setItem(VAULT_LS_KEY, '/vault')
      h.takePendingOpen.mockResolvedValue(OUTSIDE)

      const runtime = createDesktopRuntime()
      runtime.start()
      await vi.waitFor(() => expect(h.tabsMock.flushDirty).toHaveBeenCalled())
      const doorbell = h.onOpenFileRequest.mock.calls[0][0] as () => void

      // The double-click lands while the startup switch is parked on its flush.
      doorbell()
      await new Promise((resolve) => setTimeout(resolve, 0))

      // Nothing about the new file yet: no second switch, no vault moved, and
      // the startup's own switch is still the one in flight.
      expect(runtime.vaultPath.value).toBeNull()
      expect(h.tabsMock.openTab).not.toHaveBeenCalled()
      expect(h.gateways.fs.registerVault).not.toHaveBeenCalled()

      // Once startup settles, the request is carried out — from the session the
      // restore just put in place, which is the order the startup drain has
      // always used for the first launch's file.
      resolveFlush()
      await vi.waitFor(() => expect(h.tabsMock.openTab).toHaveBeenCalledWith('/elsewhere/b.md'))
      expect(h.tabsMock.restoreSession).toHaveBeenCalled()
    })

    it('releases the launch listener on teardown', async () => {
      const off = vi.fn()
      h.onOpenFileRequest.mockResolvedValue(off)
      const runtime = createDesktopRuntime()
      runtime.start()
      await vi.waitFor(() => expect(h.onOpenFileRequest).toHaveBeenCalled())

      runtime.dispose()

      expect(off).toHaveBeenCalled()
    })
  })

  describe('applyVault', () => {
    it('flushes, registers the root, commits, and disposes the prior vault', async () => {
      const runtime = createDesktopRuntime()
      await runtime.applyVault('/vault')

      expect(h.tabsMock.flushDirty).toHaveBeenCalled()
      expect(h.gateways.fs.registerVault).toHaveBeenCalledWith('/vault')
      expect(runtime.vaultPath.value).toBe('/vault')
      expect(h.tabsMock.removeAllTabs).toHaveBeenCalled()
      expect(h.tabsMock.setVault).toHaveBeenCalledWith('/vault')
      // The watcher is armed by the runtime, not by a panel: external edits must
      // be noticed even when only the Notes panel is mounted.
      expect(h.gateways.fs.watch).toHaveBeenCalledWith('/vault')
      expect(h.vaultSessionMock.detachVault).toHaveBeenCalled()
      expect(h.deactivateVaultPlugins).toHaveBeenCalled()
      expect(h.vaultSessionMock.indexVault).toHaveBeenCalledWith('/vault')
      expect(h.loadVaultPlugins).toHaveBeenCalledWith('/vault')
      expect(h.refsMock.loadVault).toHaveBeenCalledWith('/vault', expect.anything())
      // The fresh `.tmp` recovery controller is armed and its scan/GC fired.
      expect(h.tmpRecovery.gc).toHaveBeenCalledWith('/vault')
      expect(h.tmpRecovery.scan).toHaveBeenCalledWith('/vault')
    })

    it('reconciles the still-loading tabs before the flush and before the untitled prompt', async () => {
      // The order the placeholder step depends on, and the same order the two
      // closes run it in (`tab-close.ts`, `app-lifecycle.ts`): the tabs this
      // creates are untitled and dirty, so the prompt below the flush is what
      // offers them back to the user before `removeAllTabs()` — and the flush
      // must never be asked about a placeholder, which nothing can write.
      const runtime = createDesktopRuntime()
      await runtime.applyVault('/vault')

      const reconciled = h.tabsMock.reconcilePlaceholders.mock.invocationCallOrder[0]
      const flushed = h.tabsMock.flushDirty.mock.invocationCallOrder[0]
      const asked = h.tabsMock.untitledDirtyTabs.mock.invocationCallOrder[0]
      expect(reconciled).toBeLessThan(flushed)
      expect(flushed).toBeLessThan(asked)
    })

    it('blocks the switch when a dirty save fails', async () => {
      h.tabsMock.flushDirty.mockResolvedValue(false)
      const runtime = createDesktopRuntime()
      await runtime.applyVault('/vault')

      expect(runtime.vaultPath.value).toBeNull()
      expect(h.tabsMock.setVault).not.toHaveBeenCalled()
      expect(h.notifyError).toHaveBeenCalled()
    })

    it('saves an untitled tab through the settle gate, not a single write', async () => {
      // An untitled tab never reaches `flushDirty` (it would need a Save-As
      // dialog a bulk flush must not open), so the prompt's own loop saves it —
      // and the gate is what that loop asks, because `removeAllTabs()` follows
      // immediately and a keystroke during the Save-As write would go with it.
      h.tabsMock.untitledDirtyTabs.mockReturnValue([{ id: 'tab-untitled', path: null }])
      h.requestUntitledVaultSwitch.mockResolvedValue('save')
      const runtime = createDesktopRuntime()
      await runtime.applyVault('/vault')

      expect(h.tabsMock.saveUntilSettled).toHaveBeenCalledWith('tab-untitled')
      expect(h.tabsMock.saveTab).not.toHaveBeenCalled()
      expect(h.tabsMock.setVault).toHaveBeenCalledWith('/vault')
    })

    it('blocks the switch when an untitled tab cannot be settled', async () => {
      h.tabsMock.untitledDirtyTabs.mockReturnValue([{ id: 'tab-untitled', path: null }])
      h.requestUntitledVaultSwitch.mockResolvedValue('save')
      h.tabsMock.saveUntilSettled.mockResolvedValue(false)
      const runtime = createDesktopRuntime()
      await runtime.applyVault('/vault')

      expect(h.notifyError).toHaveBeenCalledWith('tabs.unsavedWorkBlocker')
      expect(h.tabsMock.setVault).not.toHaveBeenCalled()
      expect(runtime.vaultPath.value).toBeNull()
    })

    it('does not switch when the vault root fails to register; stays on the current vault and surfaces an error', async () => {
      // Commit a first (valid) vault so there is a "current" vault to stay on.
      const runtime = createDesktopRuntime()
      await runtime.applyVault('/current')
      expect(runtime.vaultPath.value).toBe('/current')
      const registrationsAfterFirst = h.gateways.fs.registerVault.mock.calls.length

      // The next open has a stale/deleted vault (missing or permission lost).
      h.gateways.fs.registerVault.mockRejectedValueOnce(new Error('permission denied'))
      await runtime.applyVault('/bad')

      // No switch is committed: the previous vault stays active and not a single
      // vault-scoped start (index / plugins / refs / tmp-recovery) was kicked off.
      expect(runtime.vaultPath.value).toBe('/current')
      expect(h.gateways.fs.registerVault.mock.calls.length).toBe(registrationsAfterFirst + 1)
      expect(h.tabsMock.setVault).toHaveBeenLastCalledWith('/current')
      expect(h.tabsMock.removeAllTabs).toHaveBeenCalledTimes(1)
      expect(h.vaultSessionMock.indexVault).toHaveBeenCalledTimes(1)
      expect(h.vaultSessionMock.indexVault).toHaveBeenCalledWith('/current')
      expect(h.loadVaultPlugins).toHaveBeenCalledTimes(1)
      expect(h.refsMock.loadVault).toHaveBeenCalledTimes(1)
      expect(h.tmpRecovery.gc).toHaveBeenCalledTimes(1)
      expect(h.tmpRecovery.scan).toHaveBeenCalledTimes(1)

      // The watcher was never armed for the rejected vault.
      expect(h.gateways.fs.watch).toHaveBeenCalledTimes(1)
      expect(h.gateways.fs.watch).toHaveBeenCalledWith('/current')

      // A clear, recoverable error is surfaced, and the bad path is NOT persisted.
      expect(h.notifyError).toHaveBeenCalledWith('could not open the vault (missing/permission): /bad')
      expect(localStorage.getItem(VAULT_LS_KEY)).toBe('/current')
    })
  })

  describe('vault-wide tmp references (closed notes included)', () => {
    it('unions the open-tab set with references from ALL notes on disk', async () => {
      h.tabsMock.referencedTmpPaths.mockReturnValue(new Set(['.tmp/open-tab.png']))
      h.vaultFileIndex.get.mockResolvedValue(['notes/closed.md', 'notes/unrelated.md'])
      h.gateways.fs.read.mockImplementation(async (_vault: string, path: string) =>
        path === 'notes/closed.md' ? '![p](.tmp/closed-note.png)' : 'nothing staged',
      )

      const runtime = createDesktopRuntime()
      await runtime.applyVault('/vault')

      const deps = h.createTmpRecovery.mock.calls[0]![0] as {
        getReferencedTmp: () => Promise<{ paths: Set<string>; complete: boolean }>
      }
      // The mocked controller never calls the provider, so drive it directly:
      // the union must include the image owned by the note whose tab is CLOSED
      // (the regression this fixes), not just the open-tab reference.
      expect(await deps.getReferencedTmp()).toEqual({
        paths: new Set(['.tmp/open-tab.png', '.tmp/closed-note.png']),
        complete: true,
      })
      expect(h.vaultFileIndex.get).toHaveBeenCalledWith('/vault')
      expect(h.gateways.fs.read).toHaveBeenCalledWith('/vault', 'notes/closed.md')
    })

    it('skips the vault-wide scan once the switch is stale, falling back to open tabs', async () => {
      h.tabsMock.referencedTmpPaths.mockReturnValue(new Set(['.tmp/open-tab.png']))
      h.vaultFileIndex.get.mockResolvedValue(['notes/closed.md'])
      h.gateways.fs.read.mockResolvedValue('![p](.tmp/closed-note.png)')

      const runtime = createDesktopRuntime()
      await runtime.applyVault('/vault')
      const deps = h.createTmpRecovery.mock.calls[0]![0] as {
        getReferencedTmp: () => Promise<{ paths: Set<string>; complete: boolean }>
      }
      const indexCalls = h.vaultFileIndex.get.mock.calls.length

      // Teardown makes the switch stale: the provider must not spend reads on a
      // vault-wide scan the runtime no longer owns, and it must REPORT that the
      // answer is partial — the recovery loop treats an incomplete set as
      // "possibly referenced" and leaves every `.tmp` file alone.
      runtime.dispose()
      expect(await deps.getReferencedTmp()).toEqual({
        paths: new Set(['.tmp/open-tab.png']),
        complete: false,
      })
      expect(h.vaultFileIndex.get.mock.calls.length).toBe(indexCalls)
    })
  })

  describe('vault-switch latest-wins', () => {
    it('a superseded switch never wins: the newer vault stays current even when the older resolves late', async () => {
      // Vault A's flushDirty stays pending so switch A is still in-flight when B starts.
      let resolveA: () => void = () => {}
      h.tabsMock.flushDirty.mockImplementationOnce(
        () => new Promise<boolean>((r) => { resolveA = () => r(true) }),
      )
      h.tabsMock.flushDirty.mockResolvedValue(true)

      const runtime = createDesktopRuntime()
      const pA = runtime.applyVault('/vaultA')
      const pB = runtime.applyVault('/vaultB')
      await pB

      // B wins immediately: it is the latest switch.
      expect(runtime.vaultPath.value).toBe('/vaultB')
      expect(h.tabsMock.setVault).toHaveBeenLastCalledWith('/vaultB')
      expect(h.vaultSessionMock.indexVault).toHaveBeenCalledTimes(1)
      expect(h.vaultSessionMock.indexVault).toHaveBeenCalledWith('/vaultB')

      // A's deffered flush resolves late — it must be stale and never commit.
      resolveA()
      await pA
      expect(runtime.vaultPath.value).toBe('/vaultB')
      expect(h.tabsMock.setVault).toHaveBeenLastCalledWith('/vaultB')
      expect(h.vaultSessionMock.indexVault).toHaveBeenCalledTimes(1)
    })

    it('a superseded plugin load lands late and is discarded, re-running the current vault only', async () => {
      let resolvePluginsA: () => void = () => {}
      h.loadVaultPlugins.mockImplementationOnce(
        () => new Promise<void>((r) => { resolvePluginsA = () => r() }),
      )
      h.loadVaultPlugins.mockResolvedValue(undefined)

      const runtime = createDesktopRuntime()
      const pA = runtime.applyVault('/vaultA')
      await pA
      expect(runtime.vaultPath.value).toBe('/vaultA')

      const pB = runtime.applyVault('/vaultB')
      await pB
      expect(runtime.vaultPath.value).toBe('/vaultB')

      // B's switch cancelled A's `.tmp` recovery controller before A could run late.
      expect(h.tmpRecovery.cancel).toHaveBeenCalled()

      const deactivationsBefore = h.deactivateVaultPlugins.mock.calls.length
      resolvePluginsA()
      await vi.waitFor(() =>
        expect(h.deactivateVaultPlugins.mock.calls.length).toBe(deactivationsBefore + 1),
      )

      // The stale cleanup discarded A and re-ran the CURRENT vault's plugin load.
      expect(runtime.vaultPath.value).toBe('/vaultB')
      expect(h.loadVaultPlugins).toHaveBeenLastCalledWith('/vaultB')
    })
  })

  describe('dispose', () => {
    it('cancels an in-flight vault switch and tears down every owned resource', async () => {
      const runtime = createDesktopRuntime()
      // Commit a first vault so a `.tmp` recovery controller and session exist to
      // be torn down by dispose.
      await runtime.applyVault('/vault1')
      expect(runtime.vaultPath.value).toBe('/vault1')

      // Start a second vault switch that is still in-flight (pending on flushDirty).
      let resolveFlush: () => void = () => {}
      h.tabsMock.flushDirty.mockImplementationOnce(
        () => new Promise<boolean>((r) => { resolveFlush = () => r(true) }),
      )
      h.tabsMock.flushDirty.mockResolvedValue(true)
      const p = runtime.applyVault('/vault2')
      // Park it ON the flush before tearing down: the switch reaches its flush a
      // step in (the placeholder reconciliation runs first), and the assertion
      // below is about a switch that is genuinely in flight.
      await vi.waitFor(() => expect(h.tabsMock.flushDirty).toHaveBeenCalled())
      runtime.dispose()

      // Every runtime-owned resource is torn down.
      expect(h.tmpRecovery.cancel).toHaveBeenCalled()
      expect(h.vaultSessionMock.detachVault).toHaveBeenCalled()
      expect(h.vaultSessionMock.cancelSearchIndexBuild).toHaveBeenCalled()
      expect(h.deactivateVaultPlugins).toHaveBeenCalled()
      expect(h.refsMock.clear).toHaveBeenCalled()
      expect(h.setActiveEditor).toHaveBeenCalledWith(null)
      expect(h.editorBridgeSetEditor).toHaveBeenCalledWith(null)
      // Every live editor session is destroyed on teardown.
      expect(h.editorSessionManager.destroyAll).toHaveBeenCalled()
      expect(h.windowTracking.dispose).toHaveBeenCalled()

      // The in-flight switch is aborted: even when the pending flush resolves, it
      // must bail and never commit to the newer vault.
      resolveFlush()
      await p
      expect(runtime.vaultPath.value).toBe('/vault1')
      expect(h.tabsMock.setVault).toHaveBeenLastCalledWith('/vault1')
    })

    it('does not re-run plugins after teardown when a stale plugin load settles late', async () => {
      let resolvePlugins: () => void = () => {}
      h.loadVaultPlugins.mockImplementationOnce(
        () => new Promise<void>((r) => { resolvePlugins = () => r() }),
      )
      h.loadVaultPlugins.mockResolvedValue(undefined)

      const runtime = createDesktopRuntime()
      await runtime.applyVault('/vault')

      runtime.dispose()
      const callsAfterDispose = h.loadVaultPlugins.mock.calls.length

      resolvePlugins()
      await vi.waitFor(() => expect(h.deactivateVaultPlugins).toHaveBeenCalled())

      // The stale completion only deactivated — it did not re-launch plugins.
      expect(h.loadVaultPlugins.mock.calls.length).toBe(callsAfterDispose)
    })
  })
})
