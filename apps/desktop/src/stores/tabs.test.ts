import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from './tabs'

const readMock = vi.hoisted(() => vi.fn())
vi.mock('../services/fs', () => ({ fsService: { read: readMock, write: vi.fn(), list: vi.fn(), watch: vi.fn() } }))

describe('useTabsStore', () => {
  beforeEach(() => { setActivePinia(createPinia()); readMock.mockReset() })

  it('opens a tab and marks dirty on edit', async () => {
    readMock.mockResolvedValue('# hello')
    const s = useTabsStore()
    await s.openTab('a.md')
    expect(s.tabs.length).toBe(1)
    expect(s.activeId).toBe(s.tabs[0].id)
    s.tabs[0].content = '# changed'
    s.markDirty(s.tabs[0].id)
    expect(s.tabs[0].dirty).toBe(true)
  })
})