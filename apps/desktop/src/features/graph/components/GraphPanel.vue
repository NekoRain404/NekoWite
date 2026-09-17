<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { t } from '../../../i18n'
import GraphToolbar from './GraphToolbar.vue'
import { useGraphCanvas } from '../composables/use-graph-canvas'
import { useGraphFilters } from '../composables/use-graph-filters'
import { useNoteGraph } from '../composables/use-note-graph'
import { fileName } from '../services/graph-geometry'

/**
 * 笔记关系图谱面板：读取当前 vault 的全部笔记，构建链接关系图，
 * 用手写 Canvas 力导向布局渲染（纯 Canvas，不引入图谱库）。
 *
 * 编排组件（§13.3）：笔记读取与异步重建在 `useNoteGraph`，筛选和派生查询在
 * `useGraphFilters`，画布、视图变换、手势与布局缓存在 `useGraphCanvas`，绘制在
 * `services/graph-render.ts`，节点尺寸/命中/方向键扫描等纯几何在
 * `services/graph-geometry.ts`。这里只剩下 props、三者的接线、画布的无障碍文案
 * 和跨模块的顺序规则（切库时必须同时清掉模型和画布，二者互相看不见对方）。
 * store 访问在 composable 内（§10.2），组件不直接读 store。
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

// 模型和画布互相依赖：模型持有图谱并按它触发布局，画布画的是模型里的图。两边
// 都只拿到惰性回调/取值器，接线集中在下面几行；回调都只在异步流程里触发，所以
// 声明顺序（模型 → 筛选 → 画布）不受影响。
const model = useNoteGraph({
  vaultReady: () => props.vaultReady,
  maxNotes: props.maxNotes,
  onGraphChanged: () => canvasView.relayout(),
  onGraphCleared: () => canvasView.clearLayout(),
})

const {
  vault,
  openNote,
  loading,
  failed,
  truncated,
  noteCount,
  edgeCount,
  totalNotes,
  capValue,
  graph,
  contentsRecord,
  degreeOf,
  rebuildTimer,
  rebuild,
  clear,
} = model

const filters = useGraphFilters({ graph, contentsRecord })

const {
  filterDir,
  filterTag,
  filterLink,
  showOrphans,
  showBroken,
  directories,
  tagOptions,
  brokenSources,
  visibleGraph,
  orphanCount,
  brokenCount,
} = filters

// 画布元素与它的容器由模板持有，composable 只接收这两个 ref（并在挂载后观察容器尺寸）。
const container = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)

const canvasView = useGraphCanvas({
  container,
  canvas,
  visible: () => visibleGraph.value,
  broken: () => graph.value?.broken ?? [],
  brokenSources: () => brokenSources.value,
  showBroken: () => showBroken.value,
  degreeOf,
  onOpenNote: openNote,
})

const {
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
} = canvasView

const canvasAriaLabel = computed(() => {
  const base = t('graph.count', { n: noteCount.value, m: edgeCount.value })
  const focused = kbNodeId.value ? fileName(kbNodeId.value) : ''
  return focused ? `${base} · ${focused} · ${t('graph.kbHint')}` : `${base} · ${t('graph.kbHint')}`
})

watch(
  [vault, () => props.vaultReady] as const,
  ([openVault]) => {
    if (rebuildTimer.value !== null) {
      clearTimeout(rebuildTimer.value)
      rebuildTimer.value = null
    }
    if (openVault && props.vaultReady !== false) {
      void rebuild()
      return
    }
    clear()
    clearLayout()
  },
  { immediate: true },
)

// Re-run the layout when any filter toggles (visible graph changes). The layout
// cache key already covers node/edge structure, so this only re-lays out when
// the filtered graph actually changed.
watch([filterDir, filterTag, filterLink, showOrphans, showBroken], () => {
  void relayout(true)
})

// Changing the render cap reads a different slice of the vault.
watch(capValue, () => {
  void rebuild()
})

defineExpose({ rebuild })
</script>

<template>
  <section class="graph-panel">
    <GraphToolbar
      v-model:cap-value="capValue"
      v-model:filter-dir="filterDir"
      v-model:filter-tag="filterTag"
      v-model:filter-link="filterLink"
      v-model:show-orphans="showOrphans"
      v-model:show-broken="showBroken"
      :loading="loading"
      :failed="failed"
      :note-count="noteCount"
      :edge-count="edgeCount"
      :orphan-count="orphanCount"
      :broken-count="brokenCount"
      :directories="directories"
      :tag-options="tagOptions"
      @reset-view="resetView"
      @relayout="relayout(true)"
    />
    <div
      ref="container"
      class="graph-canvas-wrap"
    >
      <canvas
        ref="canvas"
        class="graph-canvas"
        role="img"
        tabindex="0"
        :aria-label="canvasAriaLabel"
        @mousedown="onPointerDown"
        @mousemove="onPointerMove"
        @mouseup="onPointerUp"
        @mouseleave="onPointerLeave"
        @wheel="onWheel"
        @keydown="onCanvasKeydown"
      />
      <div
        v-if="hoverId"
        class="graph-tooltip"
        :style="{ left: `${hoverX}px`, top: `${hoverY}px` }"
      >
        {{ fileName(hoverId) }}
      </div>
      <p
        v-if="!vault"
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
/* Inset, and this is the one offset that works here. The canvas fills `.graph-canvas-wrap`
   exactly, and the wrap is `overflow: hidden`, so a ring drawn outside the canvas's box is
   clipped away entirely: before this rule the engine still reported its own ring on the canvas
   and the engine painted none of it — the element took focus with nothing on screen to say so.
   `-2px` puts the ring inside the same box, which is what the other full-bleed surfaces in this
   app (`.agent-timeline`, `.chat-scroll`) do for the same reason. */
.graph-canvas:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -2px;
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
  color: var(--app-muted);
}
</style>
