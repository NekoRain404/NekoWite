/**
 * Canvas painting for the note graph.
 *
 * One pass over the scene: edges, the dashed stubs of unresolved links, then the
 * nodes themselves (size and marking by degree and hover). Everything it needs
 * arrives in the scene - the layout points, the view transform and the color
 * tokens - so the canvas element, the pointer state and the observers stay with
 * `useGraphCanvas`, which owns them.
 */

import type { BrokenLink, LayoutPoint } from '../../../services/linkGraph'
import { nodeRadius } from './graph-geometry'

// Canvas 无法使用 CSS 变量，颜色经 getComputedStyle 读取 --app-* token；
// token 缺失时（如测试环境）退化为中性灰，正常主题下不会用到。
export const FALLBACK_COLOR = 'rgb(136, 136, 136)'

export interface ThemeColors {
  accent: string
  muted: string
  border: string
}

export function themeColors(): ThemeColors {
  const style = getComputedStyle(document.documentElement)
  const pick = (name: string): string => style.getPropertyValue(name).trim() || FALLBACK_COLOR
  return {
    accent: pick('--app-accent'),
    muted: pick('--app-muted'),
    border: pick('--app-border'),
  }
}

/** The canvas backing store and the CSS size it is displayed at. */
export interface GraphSurface {
  width: number
  height: number
  dpr: number
}

/** Everything one paint needs. `edges` are the visible (filtered) edges; a
 *  `broken` stub may still hang off a node whose target is filtered away, which
 *  is why the two lists are not derived from each other here. */
export interface GraphScene {
  points: LayoutPoint[]
  edges: Array<{ from: string; to: string }>
  broken: BrokenLink[]
  /** Nodes that a broken link points away from, drawn with a marked border. */
  brokenSources: Set<string>
  degreeOf: (id: string) => number
  hoverId: string | null
  showBroken: boolean
  scale: number
  offsetX: number
  offsetY: number
}

/** Paint the scene, or wipe the canvas when there is nothing to draw. The
 *  early return still clears first: a stale graph must never stay on screen
 *  after the vault switched or the read failed. */
export function drawGraph(
  ctx: CanvasRenderingContext2D,
  surface: GraphSurface,
  scene: GraphScene | null,
): void {
  const { width, height, dpr } = surface
  const colors = themeColors()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  if (!scene) return

  const { points, edges, broken, brokenSources, degreeOf, scale, offsetX, offsetY } = scene
  const hoverId = scene.hoverId
  const showBroken = scene.showBroken
  const byId = new Map(points.map((p) => [p.id, p]))

  ctx.save()
  ctx.translate(offsetX, offsetY)
  ctx.scale(scale, scale)

  ctx.lineWidth = 1 / scale
  ctx.strokeStyle = colors.border
  ctx.globalAlpha = 0.4
  ctx.beginPath()
  for (const edge of edges) {
    const a = byId.get(edge.from)
    const b = byId.get(edge.to)
    if (!a || !b) continue
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
  }
  ctx.stroke()
  ctx.globalAlpha = 1

  // Broken links (targets with no node) are drawn as short dashed stubs from the
  // source node, so an unresolved link is visible rather than silently dropped.
  if (showBroken && broken.length > 0) {
    ctx.save()
    ctx.setLineDash([4 / scale, 4 / scale])
    ctx.strokeStyle = colors.muted
    ctx.globalAlpha = 0.6
    ctx.lineWidth = 1 / scale
    let i = 0
    for (const b of broken) {
      const a = byId.get(b.from)
      if (!a) continue
      const angle = (i * 2.399963) % (Math.PI * 2)
      const len = 16
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(a.x + Math.cos(angle) * len, a.y + Math.sin(angle) * len)
      ctx.stroke()
      i += 1
    }
    ctx.restore()
    ctx.globalAlpha = 1
  }

  for (const point of points) {
    const degree = degreeOf(point.id)
    const radius = nodeRadius(degree)
    const hovered = point.id === hoverId
    const isBrokenSource = showBroken && brokenSources.has(point.id)
    ctx.beginPath()
    ctx.arc(point.x, point.y, hovered ? radius + 2 : radius, 0, Math.PI * 2)
    ctx.fillStyle = degree > 0 ? colors.accent : colors.muted
    ctx.fill()
    if (isBrokenSource) {
      ctx.lineWidth = 1.5 / scale
      ctx.strokeStyle = colors.accent
      ctx.setLineDash([2 / scale, 2 / scale])
      ctx.stroke()
      ctx.setLineDash([])
    } else if (hovered) {
      ctx.lineWidth = 1.5 / scale
      ctx.strokeStyle = colors.accent
      ctx.stroke()
    }
  }
  ctx.restore()
}
