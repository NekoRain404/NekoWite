import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { registerLifecycleHook } from '@nekowite/plugin-host'
import type { PluginContext } from '@nekowite/plugin-host'
import { useViewStore } from './view'

const ctx = { id: 'test', name: 'Test', insertComponent: () => {} } as PluginContext

describe('useViewStore', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('defaults to rendered mode', () => {
    expect(useViewStore().mode).toBe('rendered')
  })
  it('switches modes', () => {
    const s = useViewStore()
    s.setMode('split')
    expect(s.mode).toBe('split')
    s.setMode('source')
    expect(s.mode).toBe('source')
  })
  it('syncs scroll positions one way', () => {
    const s = useViewStore()
    s.syncScroll('source', 42)
    expect(s.sourceScroll).toBe(42)
    expect(s.renderedScroll).toBe(0)
  })
  it('clamps split ratio into [0.15, 0.85]', () => {
    const s = useViewStore()
    expect(s.splitRatio).toBe(0.5)
    s.setSplitRatio(0.1)
    expect(s.splitRatio).toBe(0.15)
    s.setSplitRatio(0.9)
    expect(s.splitRatio).toBe(0.85)
    s.setSplitRatio(0.6249)
    expect(s.splitRatio).toBe(0.625)
    s.setSplitRatio(Number.NaN)
    expect(s.splitRatio).toBe(0.5)
  })
  it('defaults the document-open mode to rendered', () => {
    expect(useViewStore().defaultMode).toBe('rendered')
  })
  it('persists a chosen default mode and initialises the live mode from it', () => {
    const s = useViewStore()
    s.setDefaultMode('split')
    expect(s.defaultMode).toBe('split')
    expect(localStorage.getItem('nekowite.view.defaultMode')).toBe('split')
    // A fresh store (e.g. new document/session) opens with the stored default.
    setActivePinia(createPinia())
    const fresh = useViewStore()
    expect(fresh.defaultMode).toBe('split')
    expect(fresh.mode).toBe('split')
  })
  it('ignores an invalid default mode and falls back to rendered', () => {
    localStorage.setItem('nekowite.view.defaultMode', 'vaporwave')
    setActivePinia(createPinia())
    expect(useViewStore().defaultMode).toBe('rendered')
    expect(useViewStore().mode).toBe('rendered')
  })
  it('resetToDefault returns the live mode to the configured default', () => {
    const s = useViewStore()
    s.setMode('source')
    expect(s.mode).toBe('source')
    s.resetToDefault()
    expect(s.mode).toBe('rendered')
    s.setDefaultMode('split')
    s.setMode('rendered')
    s.resetToDefault()
    expect(s.mode).toBe('split')
  })
  it('stores and consumes the pending outline target', () => {
    const s = useViewStore()
    expect(s.pendingOutlineTarget).toBeNull()
    s.requestOutlineTarget({ line: 7, index: 3 })
    expect(s.pendingOutlineTarget).toEqual({ line: 7, index: 3 })
    // Re-requesting the same heading replaces the object so watchers fire.
    s.requestOutlineTarget({ line: 7, index: 3 })
    expect(s.pendingOutlineTarget).toEqual({ line: 7, index: 3 })
    s.consumeOutlineTarget()
    expect(s.pendingOutlineTarget).toBeNull()
  })
})

/**
 * Run `body` with `window.localStorage` replaced by `descriptor`, then put the
 * original property back (the suite shares one Storage instance).
 */
function withStorageDescriptor(descriptor: PropertyDescriptor, body: () => void): void {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
  if (!original) throw new Error('the test setup did not install a localStorage')
  Object.defineProperty(window, 'localStorage', descriptor)
  try {
    body()
  } finally {
    Object.defineProperty(window, 'localStorage', original)
  }
}

// C3: these stores are built while the shell mounts, so an unguarded storage
// access is not a cosmetic failure — it aborts the render (white screen).
describe('useViewStore with unavailable storage', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('constructs and still switches the default mode when the getter throws', () => {
    withStorageDescriptor(
      {
        configurable: true,
        get() {
          throw new Error('storage disabled')
        },
      },
      () => {
        const s = useViewStore()
        expect(s.defaultMode).toBe('rendered')
        expect(() => s.setDefaultMode('split')).not.toThrow()
        expect(s.defaultMode).toBe('split')
        expect(s.mode).toBe('rendered')
      },
    )
  })

  it('swallows a quota error from the write', () => {
    const storage = window.localStorage
    const originalSetItem = storage.setItem
    storage.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    try {
      const s = useViewStore()
      expect(() => s.setDefaultMode('split')).not.toThrow()
      expect(s.defaultMode).toBe('split')
    } finally {
      storage.setItem = originalSetItem
    }
  })
})

describe('lifecycle broadcast from view store', () => {
  const unregister: Array<() => void> = []

  beforeEach(() => setActivePinia(createPinia()))

  afterEach(() => {
    for (const un of unregister.splice(0)) un()
  })

  it('setMode broadcasts onViewModeChange with the new mode', () => {
    const spy = vi.fn()
    unregister.push(registerLifecycleHook('test', 'onViewModeChange', spy, ctx))
    const s = useViewStore()
    s.setMode('source')
    expect(spy).toHaveBeenCalledWith(ctx, 'source')
  })
})
