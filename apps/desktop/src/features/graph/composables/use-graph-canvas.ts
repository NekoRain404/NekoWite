/**
 * The graph canvas: the element, its view transform, the force-directed layout
 * it is showing, and every gesture and key that acts on it.
 *
 * The graph itself is not read here - the caller passes getters for what to lay
 * out and draw - so the canvas can be mounted before the graph exists and stays
 * independent of where the nodes came from (§13.3: the panel only composes).
 * Layout runs on the filtered graph, so a filter change re-lays out instead of
 * silently keeping hidden nodes.
 */

import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { computeGraphLayout } from '../../../services/graph-layout-client'
import {
  graphSignature,
  type BrokenLink,
  type LayoutPoint,
  type LinkGraphEdge,
  type LinkGraphNode,
} from '../../../services/link-graph'
import { announce } from '../../../services/announcer'
import { drawGraph, type GraphScene } from '../services/graph-render'
import { fileName, neighborInDirection, pickNode } from '../services/graph-geometry'

/** Arrow key → unit vector for the node-to-node walk. */
const KB_OFFSETS: Record<string, [number, number]> = {
  ArrowRight: [1, 0],
  ArrowLeft: [-1, 0],
  ArrowDown: [0, 1],
  ArrowUp: [0, -1],
}

export interface UseGraphCanvasOptions {
  /** The panel's template refs: the sized wrapper and the canvas it paints. */
  container: Ref<HTMLDivElement | null>
  canvas: Ref<HTMLCanvasElement | null>
  /** The filtered graph to lay out and draw; null while nothing is loaded. */
  visible: () => { nodes: LinkGraphNode[]; edges: LinkGraphEdge[] } | null
  /** Unresolved link targets, drawn as stubs while the broken toggle is on. */
  broken: () => BrokenLink[]
  /** Nodes a broken link points away from, drawn with a marked border. */
  brokenSources: () => Set<string>
  showBroken: () => boolean
  /** Degree of a node id, for node size and the pick radius. */
  degreeOf: (id: string) => number
  /** Open the note a canvas gesture picked (click or Enter). */
  onOpenNote: (path: string) => void
}

export interface GraphCanvas {
  /** Layout result for the visible graph, in canvas coordinates. */
  layout: Ref<LayoutPoint[]>
  hoverId: Ref<string | null>
  hoverX: Ref<number>
  hoverY: Ref<number>
  /** Node the keyboard walk is on, or null when nothing is focused. */
  kbNodeId: Ref<string | null>
  onCanvasKeydown(e: KeyboardEvent): void
  onPointerDown(e: MouseEvent): void
  onPointerMove(e: MouseEvent): void
  onPointerUp(e: MouseEvent): void
  onPointerLeave(): void
  onWheel(e: WheelEvent): void
  resetView(): void
  relayout(force?: boolean): Promise<void>
  /** Drop the cached layout and repaint blank (vault switch, read failure). */
  clearLayout(): void
  draw(): void
}

export function useGraphCanvas(options: UseGraphCanvasOptions): GraphCanvas {
  const { container, canvas } = options
  const layout = ref<LayoutPoint[]>([])
  const hoverId = ref<string | null>(null)
  const hoverX = ref(0)
  const hoverY = ref(0)

  /**
   * The canvas is the panel's primary surface, but a graph of positioned dots has
   * no keyboard equivalent: the only way to open a note was to hit it with a
   * mouse. The canvas is therefore focusable and walks the nodes with the arrow
   * keys (Enter opens, Escape clears), bounded by a plain bounding-box scan — no
   * spatial index is worth it at these sizes, and the layout is already in memory.
   */
  const kbNodeId = ref<string | null>(null)

  let width = 0
  let height = 0
  let resizeObserver: ResizeObserver | null = null
  let themeObserver: MutationObserver | null = null

  // 布局缓存：图谱结构与画布尺寸都没变时，直接复用上次计算结果，避免
  // resize/主题/视图切换等与内容无关的更新反复重跑昂贵的力导向布局。
  let layoutCache: { sig: string; w: number; h: number; points: LayoutPoint[] } | null = null
  // 并发令牌：新的布局/清空会递增，用于丢弃已被取代的异步布局结果。
  let layoutToken = 0

  // 视图变换：screen = layout * scale + offset
  let scale = 1
  let offsetX = 0
  let offsetY = 0

  let dragging = false
  let dragLastX = 0
  let dragLastY = 0
  let dragMoved = 0

  function focusNode(id: string): void {
    kbNodeId.value = id
    announce(fileName(id))
  }

  function onCanvasKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (kbNodeId.value === null) return
      e.preventDefault()
      kbNodeId.value = null
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      const id = kbNodeId.value
      if (!id) return
      e.preventDefault()
      options.onOpenNote(id)
      return
    }
    const offset = KB_OFFSETS[e.key]
    if (!offset) return
    const next = neighborInDirection(layout.value, kbNodeId.value, offset[0], offset[1])
    if (!next) return
    e.preventDefault()
    focusNode(next)
  }

  function toCanvasCoords(event: MouseEvent): { x: number; y: number } {
    const rect = canvas.value?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: (event.clientX - rect.left - offsetX) / scale,
      y: (event.clientY - rect.top - offsetY) / scale,
    }
  }

  /** The paint state, or null when there is nothing to show. Mirrors the early
   *  return the draw pass used to make inline: an empty layout or an unloaded
   *  graph means a blank canvas, never a stale one. */
  function scene(): GraphScene | null {
    const points = layout.value
    const visible = options.visible()
    if (points.length === 0 || !visible) return null
    return {
      points,
      edges: visible.edges,
      broken: options.broken(),
      brokenSources: options.brokenSources(),
      degreeOf: options.degreeOf,
      hoverId: hoverId.value,
      showBroken: options.showBroken(),
      scale,
      offsetX,
      offsetY,
    }
  }

  function draw(): void {
    const el = canvas.value
    if (!el) return
    const dpr = window.devicePixelRatio || 1
    const backingW = Math.max(1, Math.round(width * dpr))
    const backingH = Math.max(1, Math.round(height * dpr))
    if (el.width !== backingW || el.height !== backingH) {
      el.width = backingW
      el.height = backingH
    }
    const ctx = el.getContext('2d')
    if (!ctx) return
    drawGraph(ctx, { width, height, dpr }, scene())
  }

  async function relayout(force = false): Promise<void> {
    const g = options.visible()
    if (!g || g.nodes.length === 0) {
      layout.value = []
      draw()
      return
    }
    const safeW = Math.max(width, 320)
    const safeH = Math.max(height, 240)
    const sig = graphSignature(g.nodes, g.edges)
    if (
      !force &&
      layoutCache &&
      layoutCache.sig === sig &&
      layoutCache.w === safeW &&
      layoutCache.h === safeH
    ) {
      layout.value = layoutCache.points
      draw()
      return
    }
    const token = ++layoutToken
    const layoutOptions = { seed: Math.floor(Math.random() * 0x7fffffff) }
    // 小图足够快，直接用同步路径（仍带自适应迭代上限）；大图走 Web Worker，
    // 缺失时回退到分块主线程路径（两者产出相同坐标）。这里统一走 computeGraphLayout，
    // 内部自动选择 worker 或分块回退。
    const points = await computeGraphLayout(g.nodes, g.edges, safeW, safeH, layoutOptions)
    if (token !== layoutToken) return
    layoutCache = { sig, w: safeW, h: safeH, points }
    layout.value = points
    draw()
  }

  function clearLayout(): void {
    layoutToken += 1
    layoutCache = null
    layout.value = []
    draw()
  }

  function resetView(): void {
    scale = 1
    offsetX = 0
    offsetY = 0
    draw()
  }

  function onPointerMove(event: MouseEvent): void {
    if (dragging) {
      offsetX += event.clientX - dragLastX
      offsetY += event.clientY - dragLastY
      dragLastX = event.clientX
      dragLastY = event.clientY
      dragMoved += Math.abs(event.movementX ?? 0) + Math.abs(event.movementY ?? 0)
      draw()
      return
    }
    const { x, y } = toCanvasCoords(event)
    const id = pickNode(layout.value, options.degreeOf, x, y)
    if (id !== hoverId.value) {
      hoverId.value = id
      draw()
    }
    if (id) {
      hoverX.value = event.clientX - (canvas.value?.getBoundingClientRect().left ?? 0) + 12
      hoverY.value = event.clientY - (canvas.value?.getBoundingClientRect().top ?? 0) + 12
    }
  }

  function onPointerDown(event: MouseEvent): void {
    dragging = true
    dragMoved = 0
    dragLastX = event.clientX
    dragLastY = event.clientY
  }

  function onPointerUp(event: MouseEvent): void {
    if (!dragging) return
    dragging = false
    // A drag pans the view; only a click that stayed put opens a note.
    if (dragMoved > 6) return
    const { x, y } = toCanvasCoords(event)
    const id = pickNode(layout.value, options.degreeOf, x, y)
    if (id) options.onOpenNote(id)
  }

  function onPointerLeave(): void {
    dragging = false
    if (hoverId.value) {
      hoverId.value = null
      draw()
    }
  }

  function onWheel(event: WheelEvent): void {
    const rect = canvas.value?.getBoundingClientRect()
    if (!rect) return
    event.preventDefault()
    const prev = scale
    const next = Math.min(2, Math.max(0.5, prev * (event.deltaY < 0 ? 1.12 : 1 / 1.12)))
    if (next === prev) return
    const cx = event.clientX - rect.left
    const cy = event.clientY - rect.top
    const factor = next / prev
    offsetX = cx - (cx - offsetX) * factor
    offsetY = cy - (cy - offsetY) * factor
    scale = next
    draw()
  }

  onMounted(() => {
    const el = container.value
    if (el) {
      width = el.clientWidth
      height = Math.max(240, el.clientHeight)
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver((entries) => {
          const rect = entries[0]?.contentRect
          if (!rect) return
          width = rect.width
          height = Math.max(240, rect.height)
          draw()
        })
        resizeObserver.observe(el)
      }
    }
    themeObserver = new MutationObserver(() => draw())
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent'],
    })
  })

  onBeforeUnmount(() => {
    resizeObserver?.disconnect()
    resizeObserver = null
    themeObserver?.disconnect()
    themeObserver = null
  })

  return {
    layout,
    hoverId,
    hoverX,
    hoverY,
    kbNodeId,
    onCanvasKeydown,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerLeave,
    onWheel,
    resetView,
    relayout,
    clearLayout,
    draw,
  }
}
