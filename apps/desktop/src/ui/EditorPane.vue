<script setup lang="ts">
import { onBeforeUnmount, onMounted, computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import { getCommand } from '@nekowite/editor-core'
import { FileText } from 'lucide-vue-next'
import { useViewStore, SPLIT_RATIO_DEFAULT, SPLIT_RATIO_MAX, SPLIT_RATIO_MIN } from '../stores/view'
import { useTabsStore } from '../stores/tabs'
import type { EditorView } from '@codemirror/view'
import RenderedPane from '../view/RenderedPane.vue'
import LayoutResizeHandle from './LayoutResizeHandle.vue'
import WordToolbar from '../components/WordToolbar.vue'
import FloatToolbar from '../components/FloatToolbar.vue'
import { t } from '../i18n'

// The source (CodeMirror) pane is loaded only when the user actually needs it.
// Its graph (@codemirror/*, @lezer/*, the host and highlighting services) would
// otherwise be pulled into the first-load bundle even though the Milkdown
// rendered view is what shows on open. Importing it on demand keeps CodeMirror
// off the eager path and lets the pane be torn down (v-if, not v-show) so it is
// not kept resident while the rendered editor is displayed.
type SourcePaneExpose = {
  getRatio(): number
  setRatio(r: number): void
  focus(): void
  getText(): string
  getSourceView(): EditorView | null
  getVisibleUnit(): number | null
  setMeasureSuppressed(suppressed: boolean): void
}

const SourcePane = defineAsyncComponent(() => import('../view/SourcePane.vue'))

const view = useViewStore()
const tabs = useTabsStore()

const hasTab = computed(() => tabs.activeTab !== null)

const sourcePane = ref<SourcePaneExpose | null>(null)
const renderedPane = ref<InstanceType<typeof RenderedPane> | null>(null)
let syncing = false

interface ScrollPane {
  getRatio(): number
  setRatio(r: number): void
  getVisibleUnit?(): number | null
  setScrollToLine?(line: number): void
}

function drive(dst: ScrollPane | null, src: ScrollPane | null): void {
  if (!dst || !src) return
  const fromSourceToRendered = dst === renderedPane.value && src === sourcePane.value
  syncing = true
  if (fromSourceToRendered && src.getVisibleUnit && dst.setScrollToLine) {
    const unit = src.getVisibleUnit()
    if (unit !== null) dst.setScrollToLine(unit)
    else dst.setRatio(src.getRatio())
  } else {
    dst.setRatio(src.getRatio())
  }
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

// The source pane is loaded on demand (CodeMirror is async). Entering split
// mode from the rendered view can happen before that chunk has resolved, so we
// remember the pane that was visible before the switch and re-align once the
// source pane's ref populates. The pane that was visible before entering split
// is the reference: align the other pane to its scroll position once layout is
// done. Both entries do nothing until both panes actually exist.
let pendingSplitAlignFrom: 'source' | 'rendered' | null = null

function alignSplitPanes(prev: 'source' | 'rendered'): void {
  if (prev === 'rendered') {
    drive(sourcePane.value, renderedPane.value)
  } else {
    drive(renderedPane.value, sourcePane.value)
  }
}

watch(
  () => view.mode,
  (mode, prev) => {
    if (mode !== 'split' || prev === 'split' || syncing) return
    pendingSplitAlignFrom = prev
    void nextTick(() => {
      if (view.mode !== 'split' || syncing) return
      // The source pane may still be resolving its async chunk — the ref
      // watcher below retries once it mounts.
      if (!sourcePane.value || !renderedPane.value) return
      pendingSplitAlignFrom = null
      alignSplitPanes(prev)
    })
  },
)

watch(
  () => sourcePane.value,
  () => {
    if (view.mode !== 'split' || syncing) return
    if (!pendingSplitAlignFrom || !sourcePane.value || !renderedPane.value) return
    const prev = pendingSplitAlignFrom
    pendingSplitAlignFrom = null
    alignSplitPanes(prev)
  },
)

let resizing = false

function onSplitResizeStart(): void {
  resizing = true
  sourcePane.value?.setMeasureSuppressed(true)
}

function onSplitResize(value: number): void {
  view.setSplitRatio(value)
}

function onSplitResizeEnd(): void {
  if (!resizing) return
  resizing = false
  sourcePane.value?.setMeasureSuppressed(false)
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
          v-if="view.mode !== 'rendered'"
          ref="sourcePane"
          class="pane source"
          :style="sourceStyle"
        />
        <LayoutResizeHandle
          v-if="view.mode === 'split'"
          class="split-handle"
          :label="t('editorPane.resizeSplit')"
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
        <FileText
          :size="28"
          :stroke-width="1.5"
        />
      </div>
      <p class="empty-title">
        {{ t('editorPane.emptyTitle') }}
      </p>
      <p class="empty-hint">
        {{ t('editorPane.emptyHint') }}
      </p>
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
