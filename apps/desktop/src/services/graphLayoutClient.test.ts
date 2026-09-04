import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeGraphLayout } from './graphLayoutClient'
import { computeLayoutChunked } from './linkGraph'
import type { LayoutOptions, LayoutPoint } from './linkGraph'

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

/** Minimal stand-in for the module Web Worker: records the job it is posted and
 *  answers on the same message channel the real worker uses (`{ id, points }`).
 *  It runs the SAME layout math as {@link graphLayoutWorker.ts}, but tags the
 *  result with a small sentinel shift so a test can prove the client applied
 *  the worker's reply rather than silently returning a main-thread fallback. */
class FakeWorker {
  static instances: FakeWorker[] = []
  /** Set before construction to make the worker crash on its first job. */
  static shouldFail = false

  url: URL | string
  options: unknown
  posted: Array<{
    id: number
    nodes: Array<{ id: string }>
    edges: Array<{ from: string; to: string }>
    width: number
    height: number
    options: LayoutOptions
  }> = []
  terminated = false
  private fail: boolean
  private listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(url: URL | string, options?: unknown) {
    this.url = url
    this.options = options
    this.fail = FakeWorker.shouldFail
    FakeWorker.instances.push(this)
  }

  addEventListener(type: string, cb: (event: unknown) => void): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(cb)
  }

  removeEventListener(type: string, cb: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(cb)
  }

  postMessage(message: unknown): void {
    const job = message as (typeof FakeWorker.prototype)['posted'][number]
    this.posted.push(job)
    if (this.fail) {
      queueMicrotask(() => this.dispatch('error', new Error('simulated worker crash')))
      return
    }
    void computeLayoutChunked(job.nodes, job.edges, job.width, job.height, job.options).then(
      (points) => {
        const moved: LayoutPoint[] = points.map((p) => ({ ...p, x: p.x + 10 }))
        this.dispatch('message', { data: { id: job.id, points: moved } })
      },
    )
  }

  terminate(): void {
    this.terminated = true
  }

  private dispatch(type: string, event: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(event)
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  FakeWorker.instances = []
  FakeWorker.shouldFail = false
})

describe('computeGraphLayout — Web Worker path', () => {
  it('sends the job to the Worker and returns the points it posted back', async () => {
    // The test environment normally short-circuits to the chunked path; flip
    // MODE (and provide a Worker global) so the client takes the Worker path.
    vi.stubEnv('MODE', 'production')
    vi.stubGlobal('Worker', FakeWorker)

    const points = await computeGraphLayout(nodes, edges, 800, 600, { seed: 7 })

    expect(FakeWorker.instances).toHaveLength(1)
    const worker = FakeWorker.instances[0]!
    expect(String(worker.url)).toContain('graphLayoutWorker.ts')
    expect(worker.options).toEqual({ type: 'module' })
    expect(worker.posted).toHaveLength(1)
    const job = worker.posted[0]!
    expect(job).toMatchObject({ nodes, edges, width: 800, height: 600, options: { seed: 7 } })
    expect(job.id).toBeTypeOf('number')

    // The fake posts the chunked layout shifted by +10 on x: the client result
    // must carry that shift, otherwise it just fell back to the chunked math.
    const workerReply = (await computeLayoutChunked(nodes, edges, 800, 600, { seed: 7 })).map(
      (p) => ({ ...p, x: p.x + 10 }),
    )
    expect(points).toEqual(workerReply)
    // The client owns the worker lifetime: it terminates it once the job lands.
    expect(worker.terminated).toBe(true)
  })

  it('falls back to the chunked layout when the worker errors', async () => {
    vi.stubEnv('MODE', 'production')
    vi.stubGlobal('Worker', FakeWorker)
    FakeWorker.shouldFail = true

    const points = await computeGraphLayout(nodes, edges, 800, 600, { seed: 7 })

    const chunked = await computeLayoutChunked(nodes, edges, 800, 600, { seed: 7 })
    expect(points).toEqual(chunked)
    // A worker was still attempted (and terminated) before the fallback.
    const worker = FakeWorker.instances.at(-1)!
    expect(worker.posted).toHaveLength(1)
    expect(worker.terminated).toBe(true)
  })
})
