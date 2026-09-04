<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { buildLinkGraph, computeLayout, type LayoutPoint } from '../services/linkGraph'
import { fsService } from '../services/fs'
import { vaultFileIndex } from '../services/vaultFiles'
import { useTabsStore } from '../stores/tabs'
import { t } from '../i18n'

/**
 * 笔记关系图谱面板：读取当前 vault 的全部笔记，构建链接关系图，
 * 用手写 Canvas 力导向布局渲染（纯 Canvas，不引入图谱库）。
 */

// vaultReady 缺省（undefined）时组件自行以 tabs.vault 是否就绪为准；
// 显式传 false 可暂停加载（例如父容器尚未挂载完 vault）。
const props = withDefaults(defineProps<{ vaultReady?: boolean | undefined }>(), {
  vaultReady: undefined,
})

const tabs = useTabsStore()

const container = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)

const loading = ref(false)
const failed = ref(false)
const truncated = ref(false)
const noteCount = ref(0)
const edgeCount = ref(0)

const canvasAriaLabel = computed(() =>
  t('graph.count', { n: noteCount.value, m: edgeCount.value }),
)

const layout = ref<LayoutPoint[]>([])
const hoverId = ref<string | null>(null)
const hoverX = ref(0)
const hoverY = ref(0)

const MAX_NOTES = 200
const READ_CONCURRENCY = 8

// Canvas 无法使用 CSS 变量，颜色经 getComputedStyle 读取 --app-* token；
// token 缺失时（如测试环境）退化为中性灰，正常主题下不会用到。
const FALLBACK_COLOR = 'rgb(136, 136, 136)'

interface ThemeColors {
  accent: string
  muted: string
  border: string
}

function themeColors(): ThemeColors {
  const style = getComputedStyle(document.documentElement)
  const pick = (name: string): string => style.getPropertyValue(name).trim() || FALLBACK_COLOR
  return {
    accent: pick('--app-accent'),
    muted: pick('--app-muted'),
    border: pick('--app-border'),
  }
}

let width = 0
let height = 0
let graph: ReturnType<typeof buildLinkGraph> | null = null
let degrees = new Map<string, number>()
let resizeObserver: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null
let generation = 0

// 视图变换：screen = layout * scale + offset
let scale = 1
let offsetX = 0
let offsetY = 0

async function readWithConcurrency(
  vault: string,
  paths: string[],
): Promise<Array<{ path: string; content: string }>> {
  const out = new Array<{ path: string; content: string }>(paths.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, async () => {
    while (cursor < paths.length) {
      const path = paths[cursor++]!
      try {
        out.push({ path, content: await fsService.read(vault, path) })
      } catch {
        out.push({ path, content: '' })
      }
    }
  })
  await Promise.all(workers)
  return out.filter(Boolean)
}

async function rebuild(): Promise<void> {
  const vault = tabs.vault
  if (!vault) return
  const thisGeneration = ++generation
  loading.value = true
  failed.value = false
  truncated.value = false
  try {
    const paths = await vaultFileIndex.get(vault)
    if (thisGeneration !== generation) return
    truncated.value = paths.length > MAX_NOTES
    const contents = await readWithConcurrency(vault, paths.slice(0, MAX_NOTES))
    if (thisGeneration !== generation) return
    graph = buildLinkGraph(contents)
    degrees = new Map(graph.nodes.map((node) => [node.id, node.degree]))
    noteCount.value = graph.nodes.length
    edgeCount.value = graph.edges.length
    relayout()
  } catch {
    if (thisGeneration !== generation) return
    graph = null
    layout.value = []
    noteCount.value = 0
    edgeCount.value = 0
    failed.value = true
    draw()
  } finally {
    if (thisGeneration === generation) loading.value = false
  }
}

function relayout(): void {
  if (!graph) return
  const safeW = Math.max(width, 320)
  const safeH = Math.max(height, 240)
  layout.value = computeLayout(graph.nodes, graph.edges, safeW, safeH, {
    seed: Math.floor(Math.random() * 0x7fffffff),
  })
  draw()
}

function resetView(): void {
  scale = 1
  offsetX = 0
  offsetY = 0
  draw()
}

function nodeRadius(degree: number): number {
  if (degree <= 0) return 2.5
  return Math.min(9, 3.5 + Math.sqrt(degree) * 1.6)
}

function pickNode(canvasX: number, canvasY: number): string | null {
  let best: { id: string; dist: number } | null = null
  for (const point of layout.value) {
    const radius = Math.max(nodeRadius(degrees.get(point.id) ?? 0) + 4, 8)
    const dist = Math.hypot(point.x - canvasX, point.y - canvasY)
    if (dist <= radius && (best === null || dist < best.dist)) best = { id: point.id, dist }
  }
  return best?.id ?? null
}

function toCanvasCoords(event: MouseEvent): { x: number; y: number } {
  const rect = canvas.value?.getBoundingClientRect()
  if (!rect) return { x: 0, y: 0 }
  return {
    x: (event.clientX - rect.left - offsetX) / scale,
    y: (event.clientY - rect.top - offsetY) / scale,
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
  const colors = themeColors()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const points = layout.value
  if (points.length === 0) return
  const byId = new Map(points.map((p) => [p.id, p]))

  ctx.save()
  ctx.translate(offsetX, offsetY)
  ctx.scale(scale, scale)

  ctx.lineWidth = 1 / scale
  ctx.strokeStyle = colors.border
  ctx.globalAlpha = 0.4
  ctx.beginPath()
  if (graph) {
    for (const edge of graph.edges) {
      const a = byId.get(edge.from)
      const b = byId.get(edge.to)
      if (!a || !b) continue
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
    }
  }
  ctx.stroke()
  ctx.globalAlpha = 1

  for (const point of points) {
    const degree = degrees.get(point.id) ?? 0
    const radius = nodeRadius(degree)
    const hovered = point.id === hoverId.value
    ctx.beginPath()
    ctx.arc(point.x, point.y, hovered ? radius + 2 : radius, 0, Math.PI * 2)
    ctx.fillStyle = degree > 0 ? colors.accent : colors.muted
    ctx.fill()
    if (hovered) {
      ctx.lineWidth = 1.5 / scale
      ctx.strokeStyle = colors.accent
      ctx.stroke()
    }
  }
  ctx.restore()
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
  const id = pickNode(x, y)
  if (id !== hoverId.value) {
    hoverId.value = id
    draw()
  }
  if (id) {
    hoverX.value = event.clientX - (canvas.value?.getBoundingClientRect().left ?? 0) + 12
    hoverY.value = event.clientY - (canvas.value?.getBoundingClientRect().top ?? 0) + 12
  }
}

let dragging = false
let dragLastX = 0
let dragLastY = 0
let dragMoved = 0

function onPointerDown(event: MouseEvent): void {
  dragging = true
  dragMoved = 0
  dragLastX = event.clientX
  dragLastY = event.clientY
}

function onPointerUp(event: MouseEvent): void {
  if (!dragging) return
  dragging = false
  if (dragMoved > 6) return
  const { x, y } = toCanvasCoords(event)
  const id = pickNode(x, y)
  if (id) void tabs.openTab(id)
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

function fileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path
}

watch(
  () => [tabs.vault, props.vaultReady] as const,
  ([vault]) => {
    if (vault && props.vaultReady !== false) {
      void rebuild()
      return
    }
    generation += 1
    graph = null
    layout.value = []
    noteCount.value = 0
    edgeCount.value = 0
    loading.value = false
    failed.value = false
    draw()
  },
  { immediate: true },
)

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
  generation += 1
  resizeObserver?.disconnect()
  resizeObserver = null
  themeObserver?.disconnect()
  themeObserver = null
})

defineExpose({ rebuild })
</script>

<template>
  <section class="graph-panel">
    <div class="graph-toolbar">
      <span
        class="graph-count"
        :class="{ 'is-loading': loading }"
      >{{ loading ? t('graph.reading') : failed ? t('graph.readFailed') : t('graph.count', { n: noteCount, m: edgeCount }) }}</span>
      <button
        class="graph-btn"
        :disabled="loading || noteCount === 0"
        :title="t('graph.relayoutTitle')"
        @click="relayout"
      >
        {{ t('graph.relayout') }}
      </button>
      <button
        class="graph-btn"
        :disabled="noteCount === 0"
        :title="t('graph.resetViewTitle')"
        @click="resetView"
      >
        {{ t('graph.resetView') }}
      </button>
    </div>
    <div
      ref="container"
      class="graph-canvas-wrap"
    >
      <canvas
        ref="canvas"
        class="graph-canvas"
        role="img"
        :aria-label="canvasAriaLabel"
        @mousedown="onPointerDown"
        @mousemove="onPointerMove"
        @mouseup="onPointerUp"
        @mouseleave="onPointerLeave"
        @wheel="onWheel"
      />
      <div
        v-if="hoverId"
        class="graph-tooltip"
        :style="{ left: `${hoverX}px`, top: `${hoverY}px` }"
      >
        {{ fileName(hoverId) }}
      </div>
      <p
        v-if="!tabs.vault"
        class="graph-empty"
      >
        {{ t('graph.empty') }}
      </p>
      <p
        v-else-if="failed"
        class="graph-empty"
      >
        {{ t('graph.readFailedHint') }}
      </p>
      <p
        v-else-if="!loading && noteCount === 0"
        class="graph-empty"
      >
        {{ t('graph.emptyNotes') }}
      </p>
      <p
        v-if="truncated"
        class="graph-truncated"
      >
        {{ t('graph.truncated', { n: MAX_NOTES }) }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.graph-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  padding: 12px 14px;
  gap: 8px;
}
.graph-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.graph-count {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
  font-variant-numeric: tabular-nums;
}
.graph-count.is-loading {
  color: var(--app-muted);
}
.graph-btn {
  flex: none;
  padding: 3px 9px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 11px;
  line-height: 1.5;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              border-color var(--app-motion-fast) var(--app-ease);
}
.graph-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
  border-color: color-mix(in srgb, var(--app-muted) 55%, var(--app-border));
}
.graph-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.graph-btn:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.graph-canvas-wrap {
  position: relative;
  flex: 1;
  min-height: 240px;
  overflow: hidden;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  background: color-mix(in srgb, var(--app-elevated) 40%, transparent);
}
.graph-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
}
.graph-tooltip {
  position: absolute;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 8px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-xs);
  background: var(--app-panel);
  box-shadow: var(--app-shadow-card);
  color: var(--app-text);
  font-size: 11px;
  line-height: 1.5;
  pointer-events: none;
  z-index: 2;
}
.graph-empty,
.graph-truncated {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0 24px;
  text-align: center;
  font-size: 11px;
  color: var(--app-muted);
  pointer-events: none;
}
.graph-truncated {
  inset: auto 0 0 0;
  justify-content: flex-end;
  padding: 4px 12px;
  background: color-mix(in srgb, var(--app-panel) 72%, transparent);
  font-size: 10px;
}
</style>
