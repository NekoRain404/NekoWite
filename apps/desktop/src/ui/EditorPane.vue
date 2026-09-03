<script setup lang="ts">
import { onBeforeUnmount, onMounted, computed, nextTick, ref, watch } from 'vue'
import { getCommand } from '@nekowite/editor-core'
import { FileText } from 'lucide-vue-next'
import { useViewStore, SPLIT_RATIO_DEFAULT, SPLIT_RATIO_MAX, SPLIT_RATIO_MIN } from '../stores/view'
import { useTabsStore } from '../stores/tabs'
import SourcePane from '../view/SourcePane.vue'
import RenderedPane from '../view/RenderedPane.vue'
import LayoutResizeHandle from './LayoutResizeHandle.vue'
import WordToolbar from '../components/WordToolbar.vue'
import FloatToolbar from '../components/FloatToolbar.vue'

const view = useViewStore()
const tabs = useTabsStore()

const hasTab = computed(() => tabs.activeTab !== null)

const sourcePane = ref<InstanceType<typeof SourcePane> | null>(null)
const renderedPane = ref<InstanceType<typeof RenderedPane> | null>(null)
let syncing = false

interface ScrollPane {
  getRatio(): number
  setRatio(r: number): void
}

function drive(dst: ScrollPane | null, src: ScrollPane | null): void {
  if (!dst || !src) return
  const ratio = src.getRatio()
  syncing = true
  dst.setRatio(ratio)
  void nextTick(() => {
    syncing = false
  })
}

watch(
  () => view.sourceScroll,
  () => {
    if (view.mode !== 'split' || syncing || resizing) return
    drive(renderedPane.value, sourcePane.value)
  },
)

watch(
  () => view.renderedScroll,
  () => {
    if (view.mode !== 'split' || syncing || resizing) return
    drive(sourcePane.value, renderedPane.value)
  },
)

watch(
  () => view.mode,
  (mode, prev) => {
    if (mode !== 'split' || prev === 'split' || syncing) return
    // The pane that was visible before entering split is the reference:
    // align the other pane to its scroll position once layout is done.
    void nextTick(() => {
      if (view.mode !== 'split' || syncing) return
      if (prev === 'rendered') {
        drive(sourcePane.value, renderedPane.value)
      } else {
        drive(renderedPane.value, sourcePane.value)
      }
    })
  },
)

let resizing = false

function onSplitResizeStart(): void {
  resizing = true
}

function onSplitResize(value: number): void {
  view.setSplitRatio(value)
}

function onSplitResizeEnd(): void {
  if (!resizing) return
  resizing = false
  if (view.mode !== 'split') return
  // Widths changed under both panes, so their scroll ratios are stale:
  // re-align once from the source pane (document flow reference), then let
  // normal scroll sync take over.
  drive(renderedPane.value, sourcePane.value)
}

const sourceStyle = computed((): Record<string, string> => {
  if (view.mode !== 'split') return {}
  return { width: `${view.splitRatio * 100}%` }
})
const renderedStyle = computed((): Record<string, string> => {
  if (view.mode !== 'split') return {}
  return { width: `${(1 - view.splitRatio) * 100}%` }
})

function scrollToLine(line: number): void {
  const pane = sourcePane.value
  if (!pane) return
  const cm = pane.getSourceView()
  if (!cm) return
  const doc = cm.state.doc
  const clamped = Math.max(0, Math.min(line, doc.lines - 1))
  const info = cm.lineBlockAt(doc.line(clamped + 1).from)
  cm.scrollDOM.scrollTop = Math.max(0, info.top - cm.scrollDOM.clientHeight / 3)
}

function scrollToHeadingIndex(index: number): void {
  const pane = renderedPane.value
  if (!pane) return
  const el = pane.getHeadingEls()[index]
  if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' })
}

watch(
  () => view.pendingOutlineTarget,
  async (target) => {
    if (!target) return
    view.consumeOutlineTarget()
    await nextTick()
    // In split mode the programmatic scroll triggers the normal ratio sync,
    // which brings the counterpart pane along — no extra alignment needed.
    if (view.mode === 'source') scrollToLine(target.line)
    else scrollToHeadingIndex(target.index)
  },
)

function handleCommand(id: string): void {
  const cmd = getCommand(id)
  if (cmd) {
    cmd.run()
    return
  }
  // Surface-only: concrete markdown actions for builtin buttons are
  // completed in Tasks 10/13. No-op safely here.
}

function onKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void tabs.saveActive()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="editor-pane">
    <template v-if="hasTab">
      <WordToolbar @command="handleCommand" />
      <div
        class="panes"
        :class="view.mode"
      >
        <SourcePane
          v-show="view.mode !== 'rendered'"
          ref="sourcePane"
          class="pane source"
          :style="sourceStyle"
        />
        <LayoutResizeHandle
          v-if="view.mode === 'split'"
          class="split-handle"
          label="调整分屏比例"
          :min="SPLIT_RATIO_MIN"
          :max="SPLIT_RATIO_MAX"
          :value="view.splitRatio"
          :default-value="SPLIT_RATIO_DEFAULT"
          :step="0.02"
          @resize-start="onSplitResizeStart"
          @change="onSplitResize"
          @resize-end="onSplitResizeEnd"
        />
        <RenderedPane
          v-show="view.mode !== 'source'"
          ref="renderedPane"
          class="pane rendered"
          :style="renderedStyle"
        />
        <FloatToolbar />
      </div>
    </template>
    <div
      v-else
      class="editor-empty"
    >
      <div class="empty-icon">
        <FileText :size="28" :stroke-width="1.5" />
      </div>
      <p class="empty-title">从左侧打开一个文件开始写作</p>
      <p class="empty-hint">Ctrl+S 保存 · Ctrl+Z 撤销 · 支持数学公式、引用与 MDX 组件</p>
    </div>
  </div>
</template>

<style scoped>
.editor-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--app-canvas);
}
.panes {
  position: relative;
  flex: 1;
  display: flex;
  min-height: 0;
}
.pane {
  min-width: 0;
  overflow: auto;
}
.panes.source .pane,
.panes.rendered .pane {
  width: 100%;
}
.panes.split .pane.source {
  border-right: 1px solid var(--app-border);
}
.panes.split .split-handle {
  align-self: stretch;
}

.editor-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--app-muted);
  user-select: none;
}
.empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--app-panel) 70%, var(--app-canvas));
  border: 1px solid var(--app-border);
  color: color-mix(in srgb, var(--app-muted) 70%, transparent);
  margin-bottom: 6px;
}
.empty-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: color-mix(in srgb, var(--app-text) 72%, var(--app-muted));
}
.empty-hint {
  margin: 0;
  font-size: 11px;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
}
</style>
