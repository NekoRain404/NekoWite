import { describe, expect, it, vi } from 'vitest'
import { loadPlugin } from './loader'

const importMock = vi.hoisted(() => vi.fn())

describe('loadPlugin', () => {
  it('loads a plugin and returns its definition', async () => {
    const def = { name: 'Demo', components: { X: {} } }
    importMock.mockResolvedValue({ default: def })
    const out = await loadPlugin({ id: 'demo', name: 'Demo', version: '1.0.0', main: './index.ts' }, importMock)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.definition.components?.['X']).toBeDefined()
  })

  it('returns error instead of throwing on bad plugin', async () => {
    importMock.mockRejectedValue(new Error('boom'))
    const out = await loadPlugin({ id: 'bad', name: 'Bad', version: '1', main: './x.ts' }, importMock)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('boom')
  })
})
