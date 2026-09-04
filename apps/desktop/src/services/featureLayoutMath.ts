/**
 * Pure force-directed layout math (Fruchterman-Reingold) shared by the
 * graph-layout Web Worker and the main-thread chunked fallback.
 *
 * This module holds ONLY the numeric simulation — the O(iterations * n²)
 * pairwise-repulsion loop and the small helpers that seed and finalize it. It
 * has no dependency on the graph-building code, the file system, or the editor
 * core, so the Worker can dynamically `import()` it as a separate on-demand
 * chunk instead of pulling the whole link-graph module into its entry.
 */

export interface LayoutPoint {
  id: string
  x: number
  y: number
}

export interface LayoutOptions {
  seed?: number
  iterations?: number
}

/** mulberry32: tiny deterministic PRNG so a seed reproduces a layout. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 0xffffffff
  }
}

/**
 * Layout iteration budget. The pairwise repulsion is O(n²) per pass, so a
 * fixed 300-iteration run on a 200-node graph is ~6M node-pair computations
 * that would block the main thread. Scale the budget down with node count to
 * keep total work bounded, while small graphs still converge with the full
 * budget.
 */
const MIN_ITERATIONS = 40
const MAX_ITERATIONS = 300
const PAIR_BUDGET = 1_500_000
const DEFAULT_SEED = 20240903

function adaptiveIterationCount(count: number): number {
  const pairs = Math.max(1, (count * (count - 1)) / 2)
  return Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, Math.floor(PAIR_BUDGET / pairs)))
}

interface LayoutState {
  ids: string[]
  px: Float64Array
  py: Float64Array
  total: number
  neighbors: number[][]
  ideal: number
  iterations: number
  temp: number
  cooling: number
  gravity: number
  centerX: number
  centerY: number
  margin: number
  width: number
  height: number
  random: () => number
}

/** Prepare the initial simulation state shared by the synchronous and chunked
 * layout paths. Yields null when there is nothing to lay out. */
function prepareLayout(
  nodes: Array<{ id: string }>,
  edges: Array<{ from: string; to: string }>,
  width: number,
  height: number,
  options: LayoutOptions,
): LayoutState | null {
  const count = nodes.length
  if (count === 0 || width <= 0 || height <= 0) return null
  const margin = Math.min(24, width / 4, height / 4)
  const innerW = Math.max(1, width - margin * 2)
  const innerH = Math.max(1, height - margin * 2)
  const centerX = width / 2
  const centerY = height / 2
  const random = mulberry32(options.seed ?? DEFAULT_SEED)

  const index = new Map<string, number>()
  const ids: string[] = []
  for (const node of nodes) {
    if (index.has(node.id)) continue
    index.set(node.id, ids.length)
    ids.push(node.id)
  }
  const total = ids.length
  const px = new Float64Array(total)
  const py = new Float64Array(total)
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < total; i++) {
    const radius = (Math.sqrt((i + 0.5) / total) * Math.min(innerW, innerH)) / 2
    const angle = i * golden + (random() - 0.5) * 0.6
    px[i] = centerX + Math.cos(angle) * radius + (random() - 0.5) * 2
    py[i] = centerY + Math.sin(angle) * radius + (random() - 0.5) * 2
  }

  const neighbors: number[][] = Array.from({ length: total }, () => [])
  for (const edge of edges) {
    const a = index.get(edge.from)
    const b = index.get(edge.to)
    if (a === undefined || b === undefined || a === b) continue
    neighbors[a].push(b)
    neighbors[b].push(a)
  }

  const ideal = Math.max(24, Math.sqrt((innerW * innerH) / Math.max(total, 1)))
  const iterations =
    options.iterations !== undefined
      ? Math.max(1, Math.floor(options.iterations))
      : adaptiveIterationCount(total)
  const temp = Math.max(innerW, innerH) * 0.12
  const cooling = temp / Math.max(iterations, 1)

  return {
    ids,
    px,
    py,
    total,
    neighbors,
    ideal,
    iterations,
    temp,
    cooling,
    gravity: 0.02,
    centerX,
    centerY,
    margin,
    width,
    height,
    random,
  }
}

/** One Fruchterman-Reingold iteration: pairwise repulsion, spring attraction
 * on edges, a light pull toward the canvas center and linear cooling. Mutates
 * the position buffer in place; shared by the sync and chunked paths so both
 * produce identical coordinates for identical inputs and seed. */
function stepLayout(state: LayoutState): void {
  const { px, py, neighbors, ideal, gravity, centerX, centerY, total, random } = state
  const fx = new Float64Array(total)
  const fy = new Float64Array(total)
  const temp = state.temp

  for (let i = 0; i < total; i++) {
    for (let j = i + 1; j < total; j++) {
      let dx = px[i] - px[j]
      let dy = py[i] - py[j]
      let dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 0.01) {
        dx = (random() - 0.5) * 0.1
        dy = (random() - 0.5) * 0.1
        dist = Math.sqrt(dx * dx + dy * dy)
      }
      const force = (ideal * ideal) / dist
      const ux = (dx / dist) * force
      const uy = (dy / dist) * force
      fx[i] += ux
      fy[i] += uy
      fx[j] -= ux
      fy[j] -= uy
    }
  }

  for (let a = 0; a < total; a++) {
    for (const b of neighbors[a]) {
      if (b <= a) continue
      const dx = px[a] - px[b]
      const dy = py[a] - py[b]
      const dist = Math.max(0.01, Math.sqrt(dx * dx + dy * dy))
      const force = (dist * dist) / ideal
      const ux = (dx / dist) * force
      const uy = (dy / dist) * force
      fx[a] -= ux
      fy[a] -= uy
      fx[b] += ux
      fy[b] += uy
    }
  }

  for (let i = 0; i < total; i++) {
    fx[i] += (centerX - px[i]) * gravity
    fy[i] += (centerY - py[i]) * gravity
    px[i] += Math.max(-temp, Math.min(temp, fx[i]))
    py[i] += Math.max(-temp, Math.min(temp, fy[i]))
  }

  state.temp = Math.max(1, temp - state.cooling)
}

function finalizePoints(state: LayoutState): LayoutPoint[] {
  const { ids, px, py, total, margin, width, height } = state
  const points: LayoutPoint[] = []
  for (let i = 0; i < total; i++) {
    points.push({
      id: ids[i],
      x: Math.min(width - margin, Math.max(margin, px[i])),
      y: Math.min(height - margin, Math.max(margin, py[i])),
    })
  }
  return points
}

/** Cooperative yield to the event loop so a large layout never blocks input
 * for long. Prefers the scheduler API, then requestAnimationFrame, then a
 * macrotask timeout. */
function yieldToMainThread(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (typeof scheduler?.yield === 'function') return scheduler.yield()
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
    } else {
      setTimeout(resolve, 0)
    }
  })
}

/**
 * Simple Fruchterman-Reingold style force-directed layout: pairwise
 * repulsion, spring attraction on edges, a light pull toward the canvas
 * center and linear cooling. Runs synchronously on the calling thread; the
 * iteration count scales with node count and is always capped, so tiny
 * graphs are cheap and large graphs stay time-bounded. The same inputs and
 * seed always yield the same coordinates, clamped to the canvas.
 */
export function computeLayout(
  nodes: Array<{ id: string }>,
  edges: Array<{ from: string; to: string }>,
  width: number,
  height: number,
  options: LayoutOptions = {},
): LayoutPoint[] {
  const state = prepareLayout(nodes, edges, width, height, options)
  if (!state) return []
  for (let step = 0; step < state.iterations; step++) stepLayout(state)
  return finalizePoints(state)
}

/**
 * Chunked variant of {@link computeLayout}: yields to the event loop every few
 * milliseconds so a large graph never blocks input. Produces identical
 * coordinates to `computeLayout` for the same inputs and seed — the only
 * difference is scheduling, not the math. Await it from the UI; pass `seed`
 * in `options` for reproducibility.
 */
export async function computeLayoutChunked(
  nodes: Array<{ id: string }>,
  edges: Array<{ from: string; to: string }>,
  width: number,
  height: number,
  options: LayoutOptions = {},
): Promise<LayoutPoint[]> {
  const state = prepareLayout(nodes, edges, width, height, options)
  if (!state) return []
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  let lastYield = now()
  for (let step = 0; step < state.iterations; step++) {
    stepLayout(state)
    if (step + 1 < state.iterations && now() - lastYield > 8) {
      await yieldToMainThread()
      lastYield = now()
    }
  }
  return finalizePoints(state)
}
