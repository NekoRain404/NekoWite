/** Dedicated Web Worker for force-directed graph layout. Offloading the layout
 *  (and its O(n²) pairwise repulsion) to a worker keeps large vault graphs from
 *  blocking the main thread. See {@link computeGraphLayout} for the client that
 *  spins this up and falls back to the chunked main-thread path. */
import { computeLayoutChunked } from './linkGraph'
import type { LayoutPoint, LayoutOptions } from './linkGraph'

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
  const points: LayoutPoint[] = await computeLayoutChunked(nodes, edges, width, height, options)
  post({ id, points })
}
