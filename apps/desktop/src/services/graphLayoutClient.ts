/** Client for the graph-layout Web Worker.
 *
 *  For large graphs the force-directed layout (O(n²) pairwise repulsion) is
 *  moved off the main thread into a Web Worker. When Workers are unavailable
 *  (older runtimes, test environment) the client falls back to the existing
 *  chunked main-thread path — which yields to the event loop and produces the
 *  identical coordinates, so the UI always gets a layout.
 */

import { computeLayoutChunked } from './linkGraph'
import type { LayoutPoint, LayoutOptions } from './linkGraph'

interface LayoutRequest {
  id: number
  nodes: Array<{ id: string }>
  edges: Array<{ from: string; to: string }>
  width: number
  height: number
  options: LayoutOptions
}

/** Run the layout, preferring the Web Worker path and falling back to the
 *  chunked (event-yielding) main-thread path. `options.seed` is preserved so
 *  the two paths return identical coordinates for identical inputs. */
export async function computeGraphLayout(
  nodes: Array<{ id: string }>,
  edges: Array<{ from: string; to: string }>,
  width: number,
  height: number,
  options: LayoutOptions = {},
): Promise<LayoutPoint[]> {
  const worker = createWorker()
  if (!worker) return computeLayoutChunked(nodes, edges, width, height, options)
  try {
    return await runInWorker(worker, {
      nodes,
      edges,
      width,
      height,
      options,
    })
  } catch {
    return computeLayoutChunked(nodes, edges, width, height, options)
  }
}

function createWorker(): Worker | null {
  // Workers are not available in the test environment (and instantiating a real
  // module worker there is flaky), so skip straight to the chunked fallback.
  if (import.meta.env.MODE === 'test') return null
  if (typeof Worker === 'undefined') return null
  try {
    return new Worker(new URL('./graphLayoutWorker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
}

let seq = 0
const FALLBACK_TIMEOUT_MS = 5000

function runInWorker(
  worker: Worker,
  request: Omit<LayoutRequest, 'id'>,
): Promise<LayoutPoint[]> {
  const id = ++seq
  return new Promise<LayoutPoint[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      worker.terminate()
      reject(new Error('graph layout worker timed out'))
    }, FALLBACK_TIMEOUT_MS)

    const onMessage = (event: MessageEvent<{ id: number; points: LayoutPoint[] }>): void => {
      if (event.data.id !== id) return
      cleanup()
      worker.terminate()
      resolve(event.data.points)
    }
    const onError = (): void => {
      cleanup()
      worker.terminate()
      reject(new Error('graph layout worker failed'))
    }
    const cleanup = (): void => {
      clearTimeout(timeout)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
    }

    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.postMessage({ ...request, id })
  })
}
