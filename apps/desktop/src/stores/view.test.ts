import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useViewStore } from './view'

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
