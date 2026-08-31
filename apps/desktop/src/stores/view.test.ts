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
