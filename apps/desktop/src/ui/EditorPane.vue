<script setup lang="ts">
import { onBeforeUnmount, onMounted, nextTick, ref, watch } from 'vue'
import { getCommand } from '@nekowite/editor-core'
import { useViewStore } from '../stores/view'
import { useTabsStore } from '../stores/tabs'
import SourcePane from '../view/SourcePane.vue'
import RenderedPane from '../view/RenderedPane.vue'
import ViewSwitch from '../view/ViewSwitch.vue'
import WordToolbar from '../components/WordToolbar.vue'
import FloatToolbar from '../components/FloatToolbar.vue'

const view = useViewStore()
const tabs = useTabsStore()

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
    if (view.mode !== 'split' || syncing) return
    drive(renderedPane.value, sourcePane.value)
  },
)

watch(
  () => view.renderedScroll,
  () => {
    if (view.mode !== 'split' || syncing) return
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
    <WordToolbar @command="handleCommand" />
    <ViewSwitch />
    <div
      class="panes"
      :class="view.mode"
    >
      <SourcePane
        v-show="view.mode !== 'rendered'"
        ref="sourcePane"
        class="pane source"
      />
      <RenderedPane
        v-show="view.mode !== 'source'"
        ref="renderedPane"
        class="pane rendered"
      />
      <FloatToolbar />
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
.panes.split .pane {
  width: 50%;
  border-right: 1px solid #e0e0e0;
}
.panes.split .pane:last-child {
  border-right: none;
}
</style>