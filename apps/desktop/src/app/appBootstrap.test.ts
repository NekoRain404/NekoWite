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
    },
    dialogs: { openFolderDialog: vi.fn(), saveFileDialog: vi.fn() },
    events: { on: vi.fn(), emit: vi.fn() },
    ai: { complete: vi.fn(), cancel: vi.fn(), listModels: vi.fn() },
    keys: { storeAiKey: vi.fn(), loadAiKey: vi.fn() },
  }
  const tabsMock = {
    flushDirty: vi.fn(),
    untitledDirtyTabs: vi.fn(),
    saveTab: vi.fn(),
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
    vaultFileIndex: { get: vi.fn() },
    tmpRecovery: { scan: vi.fn(), gc: vi.fn(), cancel: vi.fn(), isCancelled: vi.fn() },
    createTmpRecovery: vi.fn(),
    windowTracking: { restore: vi.fn(), start: vi.fn(), flush: vi.fn(), dispose: vi.fn() },
    requestUntitledVaultSwitch: vi.fn(),
    setActiveEditor: vi.fn(),
    editorBridgeSetEditor: vi.fn(),
    editorSessionManager: { destroyAll: vi.fn(), destroySession: vi.fn() },
    notifyError: vi.fn(),
    notifyRecovery: vi.fn(),
  }
})

vi.mock('../platform/runtime/gatewayRuntime', () => ({
  getSharedGateways: () => h.gateways,
  initSharedGateways: vi.fn(),
  resetSharedGateways: vi.fn(),
}))

vi.mock('./windowState', () => ({
  setupWindowTracking: () => h.windowTracking,
}))

vi.mock('./recoveryClosedLoop', () => ({
  createTmpRecovery: h.createTmpRecovery,
  requestUntitledVaultSwitch: h.requestUntitledVaultSwitch,
}))

vi.mock('../services/vaultFiles', () => ({
  vaultFileIndex: h.vaultFileIndex,
}))

vi.mock('../services/plugins', () => ({
  loadVaultPlugins: h.loadVaultPlugins,
  deactivateVaultPlugins: h.deactivateVaultPlugins,
}))

vi.mock('../services/editorBridge', () => ({
  editorBridge: {
    setEditor: h.editorBridgeSetEditor,
    getEditor: vi.fn(),
    getView: vi.fn(),
    onEditorChange: vi.fn(),
  },
}))

vi.mock('@nekowite/plugin-host', () => ({
  setActiveEditor: h.setActiveEditor,
}))

vi.mock('../features/editor/sessionManager', () => ({
  editorSessionManager: h.editorSessionManager,
}))

vi.mock('../stores/tabs', () => ({ useTabsStore: () => h.tabsMock }))
vi.mock('../stores/settings', () => ({ useSettingsStore: () => h.settingsMock }))
vi.mock('../stores/vaultSession', () => ({ useVaultSessionStore: () => h.vaultSessionMock }))
vi.mock('../stores/refs', () => ({ useRefsStore: () => h.refsMock }))

vi.mock('../services/errors', () => ({
  notifyError: h.notifyError,
  notifyRecovery: h.notifyRecovery,
}))

vi.mock('../i18n', () => ({
  t: (key: string): string => key,
}))

import { createDesktopRuntime } from './appBootstrap'

const VAULT_LS_KEY = 'nekowite.vault'

describe('createDesktopRuntime', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.removeItem(VAULT_LS_KEY)
    // Default store behaviors.
    h.tabsMock.flushDirty.mockResolvedValue(true)
    h.tabsMock.untitledDirtyTabs.mockReturnValue([])
    h.tabsMock.saveTab.mockResolvedValue(true)
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

      resolveFlush()
      await vi.waitFor(() => expect(h.tabsMock.restoreSession).toHaveBeenCalled())

      expect(h.tabsMock.setVault).toHaveBeenCalledWith('/vault')
      expect(h.gateways.fs.watch).toHaveBeenCalledWith('/vault')
      expect(runtime.vaultPath.value).toBe('/vault')
      expect(h.windowTracking.start).toHaveBeenCalled()
    })

    it('does not apply a vault when none was saved, but still restores the session', async () => {
      const runtime = createDesktopRuntime()
      runtime.start()
      await vi.waitFor(() => expect(h.tabsMock.restoreSession).toHaveBeenCalled())
      expect(h.gateways.fs.registerVault).not.toHaveBeenCalled()
      expect(runtime.vaultPath.value).toBeNull()
      expect(h.windowTracking.start).toHaveBeenCalled()
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

    it('blocks the switch when a dirty save fails', async () => {
      h.tabsMock.flushDirty.mockResolvedValue(false)
      const runtime = createDesktopRuntime()
      await runtime.applyVault('/vault')

      expect(runtime.vaultPath.value).toBeNull()
      expect(h.tabsMock.setVault).not.toHaveBeenCalled()
      expect(h.notifyError).toHaveBeenCalled()
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
        getReferencedTmp: () => Promise<Set<string>>
      }
      // The mocked controller never calls the provider, so drive it directly:
      // the union must include the image owned by the note whose tab is CLOSED
      // (the regression this fixes), not just the open-tab reference.
      expect(await deps.getReferencedTmp()).toEqual(
        new Set(['.tmp/open-tab.png', '.tmp/closed-note.png']),
      )
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
        getReferencedTmp: () => Promise<Set<string>>
      }
      const indexCalls = h.vaultFileIndex.get.mock.calls.length

      // Teardown makes the switch stale: the provider must not spend reads on a
      // vault-wide scan the runtime no longer owns.
      runtime.dispose()
      expect(await deps.getReferencedTmp()).toEqual(new Set(['.tmp/open-tab.png']))
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
