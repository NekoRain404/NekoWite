import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const windowMock = { onCloseRequested: vi.fn(), close: vi.fn(), destroy: vi.fn() }
  const tabsMock = {
    activeTab: null as { id: string; dirty: boolean } | null,
    hasUnsavedWork: vi.fn(),
    flushDirty: vi.fn(),
    untitledDirtyTabs: vi.fn(),
    saveTab: vi.fn(),
    removeTab: vi.fn(),
    saveActive: vi.fn(),
    captureSession: vi.fn(),
  }
  const appearanceMock = { autosaveOnBlur: false, touchSystem: vi.fn() }
  const windowTracking = { restore: vi.fn(), start: vi.fn(), flush: vi.fn(), dispose: vi.fn() }
  return {
    windowMock,
    tabsMock,
    appearanceMock,
    windowTracking,
    requestUntitledVaultSwitch: vi.fn(),
    notifyError: vi.fn(),
    notifyRecovery: vi.fn(),
  }
})

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => h.windowMock,
  CloseRequestedEvent: class {},
}))

vi.mock('../stores/tabs', () => ({
  useTabsStore: () => h.tabsMock,
}))

vi.mock('../stores/appearance', () => ({
  useAppearanceStore: () => h.appearanceMock,
}))

vi.mock('./recovery-closed-loop', () => ({
  requestUntitledVaultSwitch: h.requestUntitledVaultSwitch,
}))

vi.mock('../services/errors', () => ({
  notifyError: h.notifyError,
  notifyRecovery: h.notifyRecovery,
}))

vi.mock('../i18n', () => ({
  t: (key: string): string => key,
}))

import { createAppLifecycle } from './app-lifecycle'

type CloseHandler = (e: { preventDefault: () => void }) => Promise<void>

function registeredCloseHandler(): CloseHandler {
  const calls = h.windowMock.onCloseRequested.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0] as CloseHandler
}

describe('createAppLifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // mount() only registers the native close-requested listener under a Tauri
    // runtime; expose the flag so the close paths are exercised in the unit tests.
    ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    Object.assign(h.windowMock, {
      onCloseRequested: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    })
    h.windowMock.onCloseRequested.mockResolvedValue(() => {})
    h.tabsMock.hasUnsavedWork.mockReturnValue(false)
    h.tabsMock.flushDirty.mockResolvedValue(true)
    h.tabsMock.untitledDirtyTabs.mockReturnValue([])
    h.tabsMock.saveTab.mockResolvedValue(true)
    h.tabsMock.removeTab.mockImplementation(() => {})
    h.tabsMock.saveActive.mockResolvedValue(undefined)
    h.tabsMock.captureSession.mockImplementation(() => {})
    h.tabsMock.activeTab = null
    h.requestUntitledVaultSwitch.mockResolvedValue('save')
  })

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('mount registers the Tauri close-requested listener', async () => {
    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()
    expect(h.windowMock.onCloseRequested).toHaveBeenCalled()
    expect(typeof registeredCloseHandler()).toBe('function')
  })

  it('close-requested prevents the close when dirty, flushes, then closes when clean', async () => {
    h.tabsMock.hasUnsavedWork.mockReturnValue(true)
    h.tabsMock.flushDirty.mockResolvedValue(true)
    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()

    const preventDefault = vi.fn()
    await registeredCloseHandler()({ preventDefault })

    expect(preventDefault).toHaveBeenCalled()
    expect(h.tabsMock.flushDirty).toHaveBeenCalled()
    expect(h.tabsMock.captureSession).toHaveBeenCalled()
    expect(h.windowTracking.flush).toHaveBeenCalled()
    expect(h.windowMock.close).toHaveBeenCalled()
  })

  it('close-requested allows the close without preventing when there is no dirty work', async () => {
    h.tabsMock.hasUnsavedWork.mockReturnValue(false)
    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()

    const preventDefault = vi.fn()
    await registeredCloseHandler()({ preventDefault })

    expect(preventDefault).not.toHaveBeenCalled()
    expect(h.tabsMock.flushDirty).not.toHaveBeenCalled()
    expect(h.tabsMock.captureSession).toHaveBeenCalled()
    expect(h.windowMock.close).not.toHaveBeenCalled()
  })

  it('close-requested falls back to destroy when the native close throws', async () => {
    h.tabsMock.hasUnsavedWork.mockReturnValue(true)
    h.tabsMock.flushDirty.mockResolvedValue(true)
    h.windowMock.close.mockRejectedValue(new Error('close blocked'))
    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()

    const preventDefault = vi.fn()
    await registeredCloseHandler()({ preventDefault })

    expect(preventDefault).toHaveBeenCalled()
    expect(h.windowMock.close).toHaveBeenCalled()
    expect(h.windowMock.destroy).toHaveBeenCalled()
  })

  it('close-requested keeps the window open when a save fails', async () => {
    h.tabsMock.hasUnsavedWork.mockReturnValue(true)
    h.tabsMock.flushDirty.mockResolvedValue(false)
    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()

    const preventDefault = vi.fn()
    await registeredCloseHandler()({ preventDefault })

    expect(preventDefault).toHaveBeenCalled()
    expect(h.notifyError).toHaveBeenCalled()
    expect(h.windowMock.close).not.toHaveBeenCalled()
  })

  it('close-requested routes unnamed dirty tabs through the save-as prompt and closes', async () => {
    h.tabsMock.hasUnsavedWork.mockReturnValue(true)
    h.tabsMock.flushDirty.mockResolvedValue(true)
    h.tabsMock.untitledDirtyTabs.mockReturnValue([{ id: 'tab-untitled', path: null }])
    h.requestUntitledVaultSwitch.mockResolvedValue('save')
    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()

    const preventDefault = vi.fn()
    await registeredCloseHandler()({ preventDefault })

    expect(preventDefault).toHaveBeenCalled()
    expect(h.requestUntitledVaultSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1, notify: h.notifyRecovery }),
    )
    expect(h.tabsMock.saveTab).toHaveBeenCalledWith('tab-untitled')
    expect(h.windowMock.close).toHaveBeenCalled()
  })

  it('close-requested discards unnamed dirty tabs when the user chooses discard', async () => {
    h.tabsMock.hasUnsavedWork.mockReturnValue(true)
    h.tabsMock.flushDirty.mockResolvedValue(true)
    h.tabsMock.untitledDirtyTabs.mockReturnValue([{ id: 'tab-untitled', path: null }])
    h.requestUntitledVaultSwitch.mockResolvedValue('discard')
    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()

    const preventDefault = vi.fn()
    await registeredCloseHandler()({ preventDefault })

    expect(preventDefault).toHaveBeenCalled()
    expect(h.tabsMock.removeTab).toHaveBeenCalledWith('tab-untitled')
    expect(h.tabsMock.saveTab).not.toHaveBeenCalled()
    expect(h.windowMock.close).toHaveBeenCalled()
  })

  it('beforeunload fallback still captures and flushes for the browser Demo', () => {
    h.tabsMock.hasUnsavedWork.mockReturnValue(true)
    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    lifecycle.mount()
    window.dispatchEvent(new Event('beforeunload'))
    expect(h.tabsMock.captureSession).toHaveBeenCalled()
    expect(h.windowTracking.flush).toHaveBeenCalled()
  })

  it('unmount flushes, unlistens, and disposes window tracking', async () => {
    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()
    lifecycle.unmount()
    expect(h.tabsMock.captureSession).toHaveBeenCalled()
    expect(h.windowTracking.dispose).toHaveBeenCalled()
  })

  it('unmount disposes the runtime (the composition root) and removes window listeners', async () => {
    const disposeRuntime = vi.fn()
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    try {
      const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking, disposeRuntime })
      await lifecycle.mount()
      lifecycle.unmount()

      // The runtime (vault switch/recovery/index/plugins/editor/window-tracking)
      // is torn down by the lifecycle teardown, and this module's own window
      // listeners are removed.
      expect(disposeRuntime).toHaveBeenCalledTimes(1)
      expect(h.windowTracking.dispose).toHaveBeenCalled()
      expect(removeEventListenerSpy).toHaveBeenCalledWith('blur', expect.any(Function))
      expect(removeEventListenerSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function))
    } finally {
      removeEventListenerSpy.mockRestore()
    }
  })
})
