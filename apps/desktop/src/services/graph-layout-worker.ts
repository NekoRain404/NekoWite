/** Dedicated Web Worker for force-directed graph layout. Offloading the layout
 *  (and its O(n²) pairwise repulsion) to a worker keeps large vault graphs from
 *  blocking the main thread. See {@link computeGraphLayout} for the client that
 *  spins this up and falls back to the chunked main-thread path. */
import type { LayoutPoint, LayoutOptions } from './feature-layout-math'

export interface GraphLayoutRequest {
  id: number
  nodes: Array<{ id: string }>
  edges: Array<{ from: string; to: string }>
  width: number
  height: number
  options: LayoutOptions
}

const post = (message: unknown): void =>
  (self as unknown as { postMessage: (message: unknown) => void }).postMessage(message)

self.onmessage = async (event: MessageEvent<GraphLayoutRequest>): Promise<void> => {
  const { id, nodes, edges, width, height, options } = event.data
  // The heavy numeric simulation is only loaded when the worker actually runs a
  // layout, via a dynamic import (the worker is emitted as an ES module, so this
  // becomes a separate on-demand chunk). The worker entry itself only
  // orchestrates, keeping its first parse tiny.
  const { computeLayoutChunked } = await import('./feature-layout-math')
  const points: LayoutPoint[] = await computeLayoutChunked(nodes, edges, width, height, options)
  post({ id, points })
}
