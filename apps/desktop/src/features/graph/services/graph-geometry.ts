/**
 * The graph's presentation maths: node sizing, canvas hit-testing and the
 * keyboard neighbour scan.
 *
 * Pure functions over the layout points - no DOM, no canvas context, no store -
 * so the picking and navigation rules can be exercised without mounting the
 * panel (§13.3: geometry out of the component; §13.12 does not apply, this is
 * neither generated nor static data).
 */

import type { LayoutPoint } from '../../../services/linkGraph'

/** Node radius from its degree: a hub grows, but stays small enough that its
 *  own links remain visible between neighbours. */
export function nodeRadius(degree: number): number {
  if (degree <= 0) return 2.5
  return Math.min(9, 3.5 + Math.sqrt(degree) * 1.6)
}

/** Nearest node whose pick radius contains a canvas-space point, or null.
 *  A pointer that lands on no node must pick nothing rather than the closest
 *  node anywhere on the canvas. */
export function pickNode(
  points: LayoutPoint[],
  degreeOf: (id: string) => number,
  canvasX: number,
  canvasY: number,
): string | null {
  let best: { id: string; dist: number } | null = null
  for (const point of points) {
    const radius = Math.max(nodeRadius(degreeOf(point.id)) + 4, 8)
    const dist = Math.hypot(point.x - canvasX, point.y - canvasY)
    if (dist <= radius && (best === null || dist < best.dist)) best = { id: point.id, dist }
  }
  return best?.id ?? null
}

/** Nearest node in `direction` from the focused node, by bounding-box scan.
 *  With nothing focused yet (`fromId` null, or a node that the current filter
 *  hides) the first point takes the focus, so the first arrow key always lands
 *  somewhere. */
export function neighborInDirection(
  points: LayoutPoint[],
  fromId: string | null,
  dx: number,
  dy: number,
): string | null {
  if (!points.length) return null
  const from = points.find((p) => p.id === fromId)
  if (!from) return points[0].id
  let best: string | null = null
  let bestDist = Infinity
  for (const p of points) {
    if (p.id === from.id) continue
    const ox = p.x - from.x
    const oy = p.y - from.y
    // Projection onto the requested direction; nodes behind it are ignored.
    const along = ox * dx + oy * dy
    if (along <= 0) continue
    const dist = Math.hypot(ox, oy)
    if (dist < bestDist) {
      bestDist = dist
      best = p.id
    }
  }
  return best
}

/** Directory (parent path) of a node's path, or '' for root.
 *
 *  Separator-agnostic on purpose: node ids are the note paths the vault walk
 *  returned, which are NATIVE (backslash-separated on Windows). Splitting on
 *  `/` alone made every node's directory the empty string there, so the filter
 *  dropdown offered only "root" and no directory could ever be selected. */
export function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i < 0 ? '' : path.slice(0, i)
}

/** Display name of a vault path, for the hover tooltip and the keyboard
 *  announcement of the focused node. */
export function fileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path
}
