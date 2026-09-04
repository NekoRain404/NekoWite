import { describe, expect, it } from 'vitest'
import { computeGraphLayout } from './graphLayoutClient'
import { computeLayoutChunked } from './linkGraph'

const nodes = [
  { id: 'a.md' },
  { id: 'b.md' },
  { id: 'c.md' },
  { id: '孤岛.md' },
]
const edges = [
  { from: 'a.md', to: 'b.md' },
  { from: 'a.md', to: 'c.md' },
  { from: 'b.md', to: 'c.md' },
]

describe('computeGraphLayout', () => {
  it('falls back to the chunked layout when Workers are unavailable (test env)', async () => {
    // In the test environment `computeGraphLayout` must skip the Worker path and
    // return the deterministic chunked result.
    const client = await computeGraphLayout(nodes, edges, 800, 600, { seed: 7 })
    const chunked = await computeLayoutChunked(nodes, edges, 800, 600, { seed: 7 })
    expect(client).toEqual(chunked)
  })

  it('is deterministic for a fixed seed and preserves every node', async () => {
    const first = await computeGraphLayout(nodes, edges, 800, 600, { seed: 11 })
    const second = await computeGraphLayout(nodes, edges, 800, 600, { seed: 11 })
    expect(first).toEqual(second)
    expect(new Set(first.map((p) => p.id))).toEqual(new Set(nodes.map((n) => n.id)))
  })

  it('handles empty and single-node graphs', async () => {
    expect(await computeGraphLayout([], [], 800, 600)).toEqual([])
    expect(await computeGraphLayout([{ id: 'only.md' }], [], 100, 100)).toHaveLength(1)
  })
})
