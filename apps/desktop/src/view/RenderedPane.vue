<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createEditor, basicPlugins } from '@nekowite/editor-core'
import type { NekoEditor } from '@nekowite/editor-core'
import { setCalloutView } from '../plugins/callout'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'

const tabs = useTabsStore()
const view = useViewStore()

const scrollEl = ref<HTMLElement | null>(null)
const editorEl = ref<HTMLElement | null>(null)
let editor: NekoEditor | null = null
let unlistenChange: (() => void) | null = null
let applyingExternal = false
let gen = 0

async function applyContent(content: string): Promise<void> {
  if (!editor) return
  applyingExternal = true
  try {
    await editor.open(content)
  } finally {
    applyingExternal = false
  }
}

function onScroll(): void {
  if (scrollEl.value) view.syncScroll('rendered', scrollEl.value.scrollTop)
}

function getRatio(): number {
  const el = scrollEl.value
  if (!el) return 0
  const range = el.scrollHeight - el.clientHeight
  return range > 0 ? el.scrollTop / range : 0
}

function setRatio(r: number): void {
  const el = scrollEl.value
  if (!el) return
  const range = el.scrollHeight - el.clientHeight
  if (range > 0) el.scrollTop = r * range
}

defineExpose({ getRatio, setRatio })

onMounted(async () => {
  if (!editorEl.value) return
  editor = createEditor(editorEl.value, { plugins: basicPlugins })
  setCalloutView(editor.getView())
  const current = tabs.activeTab
  if (current) await applyContent(current.content)

  unlistenChange = editor.onContentChange(() => {
    if (applyingExternal || !editor) return
    void (async () => {
      const active = tabs.activeTab
      if (!active) return
      const markdown = await editor!.save()
      const myGen = gen
      if (tabs.activeTab?.id !== active.id) return
      if (myGen !== gen) return
      active.content = markdown
      tabs.markDirty(active.id)
    })()
  })
})

onBeforeUnmount(() => {
  setCalloutView(null)
  unlistenChange?.()
  editor?.destroy()
  editor = null
})

watch(
  () => tabs.activeTab?.content,
  (content) => {
    if (applyingExternal) return
    if (content === undefined) return
    gen++
    void applyContent(content)
  },
)
</script>

<template>
  <div
    ref="scrollEl"
    class="rendered-pane"
    @scroll="onScroll"
  >
    <div
      ref="editorEl"
      class="editor-container"
    />
  </div>
</template>

<style scoped>
.rendered-pane {
  width: 100%;
  height: 100%;
  overflow: auto;
  background: #fff;
}
.editor-container {
  padding: 0 16px;
  min-height: 100%;
}
</style>