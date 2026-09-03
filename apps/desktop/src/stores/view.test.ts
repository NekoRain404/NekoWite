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
  it('clamps split ratio into [0.25, 0.75]', () => {
    const s = useViewStore()
    expect(s.splitRatio).toBe(0.5)
    s.setSplitRatio(0.1)
    expect(s.splitRatio).toBe(0.25)
    s.setSplitRatio(0.9)
    expect(s.splitRatio).toBe(0.75)
    s.setSplitRatio(0.6249)
    expect(s.splitRatio).toBe(0.625)
    s.setSplitRatio(Number.NaN)
    expect(s.splitRatio).toBe(0.5)
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
