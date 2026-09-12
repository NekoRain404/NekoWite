<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  buildLinkGraphDetailed,
  graphSignature,
  orphanNodes,
  refreshNode,
  type DetailedGraph,
  type LinkGraphEdge,
  type LinkGraphNode,
  type LayoutPoint,
} from '../services/linkGraph'
import { computeGraphLayout } from '../services/graphLayoutClient'
import { fsService, type FsChangeEvent } from '../platform/gateways/fs'
import { vaultFileIndex } from '../services/vaultFiles'
import { parseFrontmatterBlock, splitFrontmatterRaw } from '../services/noteMeta'
import { useTabsStore } from '../stores/tabs'
import { t } from '../i18n'

/**
 * 笔记关系图谱面板：读取当前 vault 的全部笔记，构建链接关系图，
 * 用手写 Canvas 力导向布局渲染（纯 Canvas，不引入图谱库）。
 *
 * 默认渲染全量 vault（不设固定上限）；可通过 maxNotes prop / 面板内的上限
 * 选择器放宽到 200/500 或切回全量，截断时以显式“展示前 N / 共 M”提示，绝不
 * 静默丢弃。布局对大图走 Web Worker（缺失时回退到分块主线程路径），并支持
 * 按目录、标签、链接类型筛选，以及断链/孤立节点的可见统计与切换。
 */

// vaultReady 缺省（undefined）时组件自行以 tabs.vault 是否就绪为准；
// 显式传 false 可暂停加载（例如父容器尚未挂载完 vault）。
// maxNotes 缺省为 0（全量）；传 >0 表示一个可配置的渲染上限。
const props = withDefaults(
  defineProps<{ vaultReady?: boolean | undefined; maxNotes?: number }>(),
  {
    vaultReady: undefined,
    maxNotes: 0,
  },
)

const tabs = useTabsStore()

const container = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)

const loading = ref(false)
const failed = ref(false)
const truncated = ref(false)
const noteCount = ref(0)
const edgeCount = ref(0)
/** Total number of markdown notes found in the vault, before any node cap is
 * applied. Surfaced so truncation is never silent (showing first N depends on M). */
const totalNotes = ref(0)
/** Active node cap. 0 means "full vault" (render all). */
const capValue = ref(Math.max(0, props.maxNotes))

// Filters: directory, tag, link kind, plus broken/orphan visibility toggles.
const filterDir = ref('')
const filterTag = ref('')
const filterLink = ref<'all' | 'wiki' | 'markdown'>('all')
const showOrphans = ref(true)
const showBroken = ref(true)

const canvasAriaLabel = computed(() =>
  t('graph.count', { n: noteCount.value, m: edgeCount.value }),
)

const layout = ref<LayoutPoint[]>([])
const hoverId = ref<string | null>(null)
const hoverX = ref(0)
const hoverY = ref(0)

const READ_CONCURRENCY = 8
/** Coalesce bursts of fs-change events into a single graph rebuild (a save may
 * otherwise fire several read/stat events for one note). */
const REBUILD_DEBOUNCE_MS = 300

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
/** Full detailed graph (all nodes/edges, uncapped by any render cap), updated
 *  incrementally on content-only fs changes. */
const graph = ref<DetailedGraph | null>(null)
/** Vault-relative path → raw content, kept so a single-note edit refreshes just
 *  that note rather than re-reading every note. */
const contentsRecord = ref<Map<string, string>>(new Map())
/** The path set the current graph was built from (used to detect structural
 *  add/delete/move changes that force a full rebuild). */
let currentPathSet = new Set<string>()
let degreeMap = new Map<string, number>()
let resizeObserver: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null
let generation = 0
// fs-change subscription and a debounced rebuild so the graph stays fresh while
// the panel is open (not just on vault switch). Derived from the library/fs
// change event; coalesces a burst and is cancelled on vault switch/teardown.
let unlistenFs: (() => void) | null = null
let rebuildTimer: ReturnType<typeof setTimeout> | null = null
let disposed = false

// 布局缓存：图谱结构与画布尺寸都没变时，直接复用上次计算结果，避免
// resize/主题/视图切换等与内容无关的更新反复重跑昂贵的力导向布局。
let layoutCache: { sig: string; w: number; h: number; points: LayoutPoint[] } | null = null
// 并发令牌：新的布局/清空会递增，用于丢弃已被取代的异步布局结果。
let layoutToken = 0

// 视图变换：screen = layout * scale + offset
let scale = 1
let offsetX = 0
let offsetY = 0

/** Directory (parent path) of a node's path, or '' for root.
 *
 *  Separator-agnostic on purpose: node ids are the note paths the vault walk
 *  returned, which are NATIVE (backslash-separated on Windows). Splitting on
 *  `/` alone made every node's directory the empty string there, so the filter
 *  dropdown offered only "root" and no directory could ever be selected. */
function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i < 0 ? '' : path.slice(0, i)
}

/** Distinct directories across the graph's nodes, for the filter dropdown. */
const directories = computed(() => {
  const g = graph.value
  if (!g) return []
  const set = new Set<string>()
  for (const node of g.nodes) set.add(dirOf(node.id))
  return [...set].sort((a, b) => a.localeCompare(b))
})

/** path → tags parsed from each note's frontmatter, for the tag filter. */
const nodeTags = computed(() => {
  const map = new Map<string, string[]>()
  for (const [path, content] of contentsRecord.value) {
    const { front } = splitFrontmatterRaw(content)
    map.set(path, parseFrontmatterBlock(front).tags)
  }
  return map
})

/** Distinct tags across the graph's nodes, for the filter dropdown. */
const tagOptions = computed(() => {
  const set = new Set<string>()
  for (const tags of nodeTags.value.values()) for (const tag of tags) set.add(tag)
  return [...set].sort((a, b) => a.localeCompare(b))
})

/** Nodes that are linked to by a broken (unresolvable) link, shown distinctly. */
const brokenSources = computed(() => {
  const g = graph.value
  if (!g) return new Set<string>()
  return new Set(g.broken.map((b) => b.from))
})

/** Nodes/edges after applying directory, tag and link-type filters (and the
 *  orphan-visibility toggle). Layout runs on this filtered graph, so a filter
 *  change re-lays out rather than silently keeping hidden nodes. */
const visibleGraph = computed<{ nodes: LinkGraphNode[]; edges: LinkGraphEdge[] } | null>(() => {
  const g = graph.value
  if (!g) return null
  const useDir = filterDir.value !== ''
  const useTag = filterTag.value !== ''
  const useLink = filterLink.value !== 'all'
  const nodes = g.nodes.filter((n) => {
    if (useDir && dirOf(n.id) !== filterDir.value) return false
    if (useTag && !(nodeTags.value.get(n.id) ?? []).includes(filterTag.value)) return false
    if (!showOrphans.value && n.degree === 0) return false
    return true
  })
  const ids = new Set(nodes.map((n) => n.id))
  const edges = g.edges.filter((e) => {
    if (!ids.has(e.from) || !ids.has(e.to)) return false
    if (useLink && e.kind !== filterLink.value) return false
    return true
  })
  return { nodes, edges }
})

/** Orphan (degree-0) nodes in the full graph, for the legend count. */
const orphanCount = computed(() => (graph.value ? orphanNodes(graph.value).length : 0))
/** Broken-link count, for the legend count. */
const brokenCount = computed(() => graph.value?.broken.length ?? 0)

async function readWithConcurrency(
  vault: string,
  paths: string[],
  shouldAbort: () => boolean = () => false,
): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, async () => {
    while (cursor < paths.length) {
      // Stop issuing reads once the build is superseded (e.g. a newer rebuild
      // or a vault switch bumped `generation`). Without this, a stale in-flight
      // readWithConcurrency keeps calling fsService.read — which in tests
      // crosses test boundaries (resetMock) and bleeds read counts. The
      // post-await generation check backstop remains.
      if (shouldAbort()) return
      const path = paths[cursor++]!
      try {
        out.push({ path, content: await fsService.read(vault, path) })
      } catch {
        out.push({ path, content: '' })
      }
    }
  })
  await Promise.all(workers)
  return out
}

function pathSetEquals(a: string[], b: Set<string>): boolean {
  if (a.length !== b.size) return false
  for (const p of a) if (!b.has(p)) return false
  return true
}

async function rebuild(): Promise<void> {
  const vault = tabs.vault
  if (!vault || props.vaultReady === false) return
  const thisGeneration = ++generation
  loading.value = true
  failed.value = false
  truncated.value = false
  try {
    const paths = await vaultFileIndex.get(vault)
    if (thisGeneration !== generation) return
    totalNotes.value = paths.length
    const cap = capValue.value
    const useCap = cap > 0
    const selected = useCap ? paths.slice(0, cap) : paths
    truncated.value = useCap && paths.length > cap
    const contents = await readWithConcurrency(vault, selected, () => thisGeneration !== generation)
    if (thisGeneration !== generation) return
    contentsRecord.value = new Map(contents.map((c) => [c.path, c.content]))
    currentPathSet = new Set(selected)
    graph.value = buildLinkGraphDetailed(contents)
    degreeMap = new Map(graph.value.nodes.map((node) => [node.id, node.degree]))
    noteCount.value = graph.value.nodes.length
    edgeCount.value = graph.value.edges.length
    await relayout()
  } catch {
    if (thisGeneration !== generation) return
    graph.value = null
    layoutToken += 1
    layoutCache = null
    layout.value = []
    noteCount.value = 0
    edgeCount.value = 0
    totalNotes.value = 0
    failed.value = true
    draw()
  } finally {
    if (thisGeneration === generation) loading.value = false
  }
}

/** Incrementally apply a single-note fs-change to an already-built graph.
 *  A content-only change refreshes only that note's node/edges; a structural
 *  change (add/remove/move) falls back to a full rebuild because other notes'
 *  links may re-resolve. */
async function applyChange(path: string, kind: string): Promise<void> {
  const vault = tabs.vault
  if (!vault || !graph.value) return
  if (kind === 'removed') {
    void rebuild()
    return
  }
  const paths = await vaultFileIndex.get(vault)
  if (!pathSetEquals(paths, currentPathSet)) {
    // Path set changed (add / move / delete) — a full recompute is the safe,
    // correct path (links from other notes may now resolve differently).
    void rebuild()
    return
  }
  const thisGeneration = generation
  try {
    const content = await fsService.read(vault, path)
    if (thisGeneration !== generation) return
    contentsRecord.value.set(path, content)
    const candidate = refreshNode(graph.value, path, content, Array.from(currentPathSet))
    graph.value = candidate
    degreeMap = new Map(candidate.nodes.map((n) => [n.id, n.degree]))
    noteCount.value = candidate.nodes.length
    edgeCount.value = candidate.edges.length
    await relayout()
  } catch {
    void rebuild()
  }
}

async function relayout(force = false): Promise<void> {
  const g = visibleGraph.value
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
  const options = { seed: Math.floor(Math.random() * 0x7fffffff) }
  // 小图足够快，直接用同步路径（仍带自适应迭代上限）；大图走 Web Worker，
  // 缺失时回退到分块主线程路径（两者产出相同坐标）。这里统一走 computeGraphLayout，
  // 内部自动选择 worker 或分块回退。
  const points = await computeGraphLayout(g.nodes, g.edges, safeW, safeH, options)
  if (token !== layoutToken) return
  layoutCache = { sig, w: safeW, h: safeH, points }
  layout.value = points
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
    const radius = Math.max(nodeRadius(degreeMap.get(point.id) ?? 0) + 4, 8)
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
  const g = graph.value
  if (points.length === 0 || !g) return
  const byId = new Map(points.map((p) => [p.id, p]))
  const sources = brokenSources.value

  ctx.save()
  ctx.translate(offsetX, offsetY)
  ctx.scale(scale, scale)

  ctx.lineWidth = 1 / scale
  ctx.strokeStyle = colors.border
  ctx.globalAlpha = 0.4
  ctx.beginPath()
  for (const edge of visibleGraph.value?.edges ?? []) {
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
  if (showBroken.value && g.broken.length > 0) {
    ctx.save()
    ctx.setLineDash([4 / scale, 4 / scale])
    ctx.strokeStyle = colors.muted
    ctx.globalAlpha = 0.6
    ctx.lineWidth = 1 / scale
    let i = 0
    for (const b of g.broken) {
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
    const degree = degreeMap.get(point.id) ?? 0
    const radius = nodeRadius(degree)
    const hovered = point.id === hoverId.value
    const isBrokenSource = showBroken.value && sources.has(point.id)
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

/** Auto-rebuild the graph when note/link data changes (not just on vault
 *  switch). Only markdown changes affect the graph; attachment/directory churn
 *  is ignored. Invalidate the vault file index so an add/delete is picked up,
 *  then apply the change incrementally where the path set is unchanged
 *  (resize/theme-only updates still reuse the cached layout via relayout()). */
function onFsChangeHandler(e: FsChangeEvent): void {
  if (disposed) return
  const vault = tabs.vault
  if (!vault || props.vaultReady === false) return
  if (!/\.(md|mdx)$/i.test(e.path)) return
  vaultFileIndex.invalidate(vault)
  if (rebuildTimer !== null) clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null
    if (disposed) return
    void applyChange(e.path, e.kind)
  }, REBUILD_DEBOUNCE_MS)
}

watch(
  () => [tabs.vault, props.vaultReady] as const,
  ([vault]) => {
    if (rebuildTimer !== null) {
      clearTimeout(rebuildTimer)
      rebuildTimer = null
    }
    if (vault && props.vaultReady !== false) {
      void rebuild()
      return
    }
    generation += 1
    graph.value = null
    layoutToken += 1
    layoutCache = null
    layout.value = []
    noteCount.value = 0
    edgeCount.value = 0
    totalNotes.value = 0
    truncated.value = false
    loading.value = false
    failed.value = false
    draw()
  },
  { immediate: true },
)

// Re-run the layout when any filter toggles (visible graph changes). The layout
// cache key already covers node/edge structure, so this only re-lays out when
// the filtered graph actually changed.
watch(
  [filterDir, filterTag, filterLink, showOrphans, showBroken],
  () => {
    void relayout(true)
  },
)

// Changing the render cap reads a different slice of the vault.
watch(capValue, () => {
  void rebuild()
})

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
  const pending = fsService.onFsChange(onFsChangeHandler)
  Promise.resolve(pending)
    .then((unlisten) => {
      if (disposed) unlisten?.()
      else unlistenFs = unlisten
    })
    .catch(() => {
      // Registration failed (test/fallback gateway): keep existing behavior.
    })
})

onBeforeUnmount(() => {
  disposed = true
  if (rebuildTimer !== null) {
    clearTimeout(rebuildTimer)
    rebuildTimer = null
  }
  unlistenFs?.()
  unlistenFs = null
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
      <label
        class="graph-filter"
        :title="t('graph.capLabel')"
      >
        <select
          v-model="capValue"
          class="graph-select"
          :aria-label="t('graph.capLabel')"
        >
          <option :value="0">{{ t('graph.showFull') }}</option>
          <option :value="200">200</option>
          <option :value="500">500</option>
        </select>
      </label>
      <label
        class="graph-filter"
        :title="t('graph.filterDir')"
      >
        <select
          v-model="filterDir"
          class="graph-select"
          :aria-label="t('graph.filterDir')"
        >
          <option value="">{{ t('graph.allDirs') }}</option>
          <option
            v-for="d in directories"
            :key="d"
            :value="d"
          >{{ d || t('notelist.rootDir') }}</option>
        </select>
      </label>
      <label
        class="graph-filter"
        :title="t('graph.filterTag')"
      >
        <select
          v-model="filterTag"
          class="graph-select"
          :aria-label="t('graph.filterTag')"
        >
          <option value="">{{ t('graph.allTags') }}</option>
          <option
            v-for="tag in tagOptions"
            :key="tag"
            :value="tag"
          >{{ tag }}</option>
        </select>
      </label>
      <label
        class="graph-filter"
        :title="t('graph.filterLink')"
      >
        <select
          v-model="filterLink"
          class="graph-select"
          :aria-label="t('graph.filterLink')"
        >
          <option value="all">{{ t('graph.allLinks') }}</option>
          <option value="wiki">{{ t('graph.wikiLinks') }}</option>
          <option value="markdown">{{ t('graph.markdownLinks') }}</option>
        </select>
      </label>
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
      class="graph-toolbar graph-toolbar-alt"
    >
      <span
        class="graph-legend"
        :title="t('graph.legend')"
      >
        <span class="legend-dot legend-orphan" />{{ t('graph.orphansCount', { n: orphanCount }) }}
      </span>
      <span
        class="graph-legend"
        :title="t('graph.legend')"
      >
        <span class="legend-dot legend-broken" />{{ t('graph.brokenLinksCount', { n: brokenCount }) }}
      </span>
      <label class="graph-toggle">
        <input
          v-model="showOrphans"
          type="checkbox"
        >{{ t('graph.showOrphans') }}
      </label>
      <label class="graph-toggle">
        <input
          v-model="showBroken"
          type="checkbox"
        >{{ t('graph.showBroken') }}
      </label>
      <button
        class="graph-btn"
        :disabled="loading || noteCount === 0"
        :title="t('graph.relayoutTitle')"
        @click="relayout(true)"
      >
        {{ t('graph.relayout') }}
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
        {{ t('graph.truncatedFull', { n: capValue, total: totalNotes }) }}
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
  gap: 6px;
  flex-wrap: wrap;
}
.graph-toolbar-alt {
  margin-top: -4px;
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
.graph-filter {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.graph-select {
  height: 24px;
  max-width: 130px;
  padding: 0 6px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: color-mix(in srgb, var(--app-elevated) 60%, var(--app-panel));
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 11px;
  line-height: 1.5;
  cursor: pointer;
}
.graph-select:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.graph-legend {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
  font-variant-numeric: tabular-nums;
}
.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.legend-orphan {
  background: var(--app-muted);
}
.legend-broken {
  background: color-mix(in srgb, var(--app-accent) 60%, transparent);
  box-shadow: 0 0 0 1px var(--app-border);
}
.graph-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: 550;
  color: var(--app-muted);
  cursor: pointer;
}
.graph-toggle input {
  margin: 0;
  accent-color: var(--app-accent);
  cursor: pointer;
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
.graph-truncated-total {
  margin-left: 4px;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
}
</style>
