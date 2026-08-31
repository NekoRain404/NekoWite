<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createEditor, basicPlugins } from '@nekowite/editor-core'
import type { NekoEditor } from '@nekowite/editor-core'
import { emitLifecycle } from '@nekowite/plugin-host'
import { setCalloutView } from '../plugins/callout'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'
import { useFloatStore } from '../stores/float'
import { notifyError } from '../services/errors'
import { editorBridge } from '../services/editorBridge'

const tabs = useTabsStore()
const view = useViewStore()
const floatStore = useFloatStore()

const scrollEl = ref<HTMLElement | null>(null)
const editorEl = ref<HTMLElement | null>(null)
let editor: NekoEditor | null = null
let unlistenChange: (() => void) | null = null
let applyingExternal = false
let parseFailed = false
let gen = 0
let calloutViewSet = false
let docChangeTimer: ReturnType<typeof setTimeout> | null = null
let lastDoc = ''

async function applyContent(content: string): Promise<void> {
  if (!editor) return
  applyingExternal = true
  try {
    await editor.open(content)
    floatStore.select(null)
    if (!calloutViewSet) {
      try {
        setCalloutView(editor.getView())
        calloutViewSet = true
      } catch {
        // The editor view is expected to be ready once open() resolves.
        parseFailed = true
        notifyError('文档解析失败，已切换到源码视图，请检查文档格式')
        view.setMode('source')
      }
    }
  } catch {
    parseFailed = true
    notifyError('文档解析失败，已切换到源码视图，请检查文档格式')
    view.setMode('source')
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

function onContainerPointerDownCapture(e: PointerEvent): void {
  const target = e.target as Element | null
  if (target && target.closest('.float-box')) return
  floatStore.select(null)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && floatStore.selectedId) {
    floatStore.select(null)
  }
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
  editorBridge.setEditor(editor)
  const current = tabs.activeTab
  if (current) await applyContent(current.content)

  emitLifecycle('onEditorReady', editor)

  editorEl.value.addEventListener('pointerdown', onContainerPointerDownCapture, true)
  window.addEventListener('keydown', onKeydown)

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
      lastDoc = markdown
      if (docChangeTimer) return
      docChangeTimer = setTimeout(() => {
        emitLifecycle('onDocChange', { doc: lastDoc })
        docChangeTimer = null
      }, 300)
    })()
  })
})

onBeforeUnmount(() => {
  if (docChangeTimer) {
    clearTimeout(docChangeTimer)
    docChangeTimer = null
  }
  setCalloutView(null)
  editorBridge.setEditor(null)
  editorEl.value?.removeEventListener('pointerdown', onContainerPointerDownCapture, true)
  window.removeEventListener('keydown', onKeydown)
  unlistenChange?.()
  editor?.destroy()
  editor = null
})

watch(
  () => tabs.activeTab?.content,
  (content) => {
    if (applyingExternal) return
    if (content === undefined) return
    if (parseFailed) return
    gen++
    void applyContent(content)
  },
)

watch(
  () => view.mode,
  (mode) => {
    if (!parseFailed) return
    if (mode === 'source') return
    parseFailed = false
    const content = tabs.activeTab?.content
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
  position: relative;
  padding: 0 16px;
  min-height: 100%;
}
</style>