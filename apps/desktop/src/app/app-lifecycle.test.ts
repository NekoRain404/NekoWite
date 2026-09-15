import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const windowMock = { onCloseRequested: vi.fn(), close: vi.fn(), destroy: vi.fn() }
  const tabsMock = {
    activeTab: null as { id: string; dirty: boolean } | null,
    /** The open tabs, as the store exposes them: the close path reads this to
     *  find the tabs a refused flush could not put on disk. */
    tabs: [] as Array<{ id: string; path: string | null; dirty: boolean }>,
    hasUnsavedWork: vi.fn(),
    flushDirty: vi.fn(),
    reconcilePlaceholders: vi.fn(),
    untitledDirtyTabs: vi.fn(),
    saveTab: vi.fn(),
    /** The gate the close asks instead of `saveTab`: one landed write is not a
     *  saved tab (`tab-settle.ts`). */
    saveUntilSettled: vi.fn(),
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

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

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
    // The gate's answer, modelled as the gate defines it: `true` is "this tab
    // holds nothing that is not on disk" (`tab-settle.ts`), so the fixture tab it
    // answers for stops being dirty. The close reads both halves of that — it
    // settles the tabs the answer above was overtaken by, and a stub that says
    // true while the tab stays dirty is a tab no close can ever finish with.
    h.tabsMock.saveUntilSettled.mockImplementation(async (id: string) => {
      const tab = h.tabsMock.tabs.find((t) => t.id === id)
      if (tab) tab.dirty = false
      return true
    })
    h.tabsMock.removeTab.mockImplementation(() => {})
    h.tabsMock.saveActive.mockResolvedValue(undefined)
    h.tabsMock.captureSession.mockImplementation(() => {})
    h.tabsMock.activeTab = null
    h.tabsMock.tabs = []
    h.requestUntitledVaultSwitch.mockResolvedValue('save')
    // The close path's rescue question: by default the user says no, so a test
    // that is not about the rescue never has to answer it.
    h.notifyRecovery.mockImplementation((p: { onDismiss: () => void }) => p.onDismiss())
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

  it('close-requested keeps the window open when a save fails and the copy is declined', async () => {
    h.tabsMock.hasUnsavedWork.mockReturnValue(true)
    h.tabsMock.flushDirty.mockResolvedValue(false)
    h.tabsMock.tabs = [{ id: 'tab-ro', path: '/vault/ro.md', dirty: true }]
    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()

    const preventDefault = vi.fn()
    await registeredCloseHandler()({ preventDefault })

    expect(preventDefault).toHaveBeenCalled()
    // The user was offered the way out (the prompt is raised by the default
    // mock, which dismisses it) and chose to stay, so nothing was written and
    // the window stays open with their text in the editor.
    expect(h.notifyRecovery).toHaveBeenCalled()
    expect(h.tabsMock.saveTab).not.toHaveBeenCalled()
    expect(h.notifyError).toHaveBeenCalledWith('tabs.unsavedWorkBlockerClose')
    expect(h.windowMock.close).not.toHaveBeenCalled()
  })

  // The trap this exists for: a save refused because the file is read-only keeps
  // `flushDirty()` false forever, so the X used to do nothing at all — Ctrl+S
  // refused, the X refused, and the user could not leave the app without losing
  // the text or leaving it to chmod the file from outside.
  it('close-requested offers a copy of a refused save, and closes once it is taken', async () => {
    h.tabsMock.hasUnsavedWork.mockReturnValue(true)
    h.tabsMock.flushDirty.mockResolvedValue(false)
    h.tabsMock.tabs = [
      { id: 'tab-ro', path: '/vault/ro.md', dirty: true },
      // A clean tab is not the close's business and must not be dragged into
      // the rescue's Save-As dialogs.
      { id: 'tab-clean', path: '/vault/clean.md', dirty: false },
    ]
    h.notifyRecovery.mockImplementation((p: { onRestore: () => void }) => p.onRestore())
    h.tabsMock.saveTab.mockResolvedValue(true)
    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()

    const preventDefault = vi.fn()
    await registeredCloseHandler()({ preventDefault })

    expect(h.tabsMock.saveTab).toHaveBeenCalledWith('tab-ro', { offerCopy: true })
    expect(h.tabsMock.saveTab).toHaveBeenCalledTimes(1)
    // The copy is the first attempt, not the whole answer: the text is settled
    // where the copy put it before this route lets the window go.
    expect(h.tabsMock.saveUntilSettled).toHaveBeenCalledWith('tab-ro')
    expect(h.windowMock.close).toHaveBeenCalled()
  })

  it('close-requested stays open when the copy itself fails', async () => {
    h.tabsMock.hasUnsavedWork.mockReturnValue(true)
    h.tabsMock.flushDirty.mockResolvedValue(false)
    h.tabsMock.tabs = [{ id: 'tab-ro', path: '/vault/ro.md', dirty: true }]
    h.notifyRecovery.mockImplementation((p: { onRestore: () => void }) => p.onRestore())
    h.tabsMock.saveTab.mockResolvedValue(false)
    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()

    const preventDefault = vi.fn()
    await registeredCloseHandler()({ preventDefault })

    expect(h.tabsMock.saveTab).toHaveBeenCalledWith('tab-ro', { offerCopy: true })
    expect(h.windowMock.close).not.toHaveBeenCalled()
    expect(h.notifyError).toHaveBeenCalledWith('tabs.unsavedWorkBlockerClose')
  })

  it('close-requested closes when the refused tab was rescued on an earlier save', async () => {
    // The same chain a user walks: the refusal, then the copy, then the X.
    h.tabsMock.hasUnsavedWork.mockReturnValue(true)
    h.tabsMock.flushDirty.mockResolvedValue(true)
    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()

    const preventDefault = vi.fn()
    await registeredCloseHandler()({ preventDefault })

    expect(h.notifyRecovery).not.toHaveBeenCalled()
    expect(h.windowMock.close).toHaveBeenCalled()
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
    // Through the gate, not `saveTab`: this IS the close, so the autosave timer
    // a keystroke armed is cancelled by it and the write has to carry the newer
    // text itself (`tab-settle.ts`).
    expect(h.tabsMock.saveUntilSettled).toHaveBeenCalledWith('tab-untitled')
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
    expect(h.tabsMock.saveUntilSettled).not.toHaveBeenCalled()
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

  it('releases a close-requested registration that lands after the app unmounted', async () => {
    // `onCloseRequested` resolves after an await, and a teardown can overtake
    // it. The registration that lands afterwards is unreachable from unmount(),
    // so the continuation that owns it has to release it.
    let settleRegistration: (off: () => void) => void = () => {}
    h.windowMock.onCloseRequested.mockReturnValue(
      new Promise<() => void>((resolve) => {
        settleRegistration = resolve
      }),
    )
    const off = vi.fn()
    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    lifecycle.mount()

    lifecycle.unmount()
    settleRegistration(off)
    await flush()

    expect(off).toHaveBeenCalled()
  })

  it('keeps the close-requested registration unmount() owns', async () => {
    const off = vi.fn()
    h.windowMock.onCloseRequested.mockResolvedValue(off)
    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    lifecycle.mount()
    await flush()

    lifecycle.unmount()

    expect(off).toHaveBeenCalled()
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
