<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createEditor, basicPlugins, getCommand } from '@nekowite/editor-core'
import type { NekoEditor } from '@nekowite/editor-core'
import { useTabsStore } from '../stores/tabs'
import WordToolbar from '../components/WordToolbar.vue'

const tabs = useTabsStore()

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

async function handleCommand(id: string): Promise<void> {
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

onMounted(async () => {
  if (!editorEl.value) return
  editor = createEditor(editorEl.value, { plugins: basicPlugins })
  const current = tabs.activeTab
  if (current) await applyContent(current.content)

  unlistenChange = editor.onContentChange(() => {
    if (applyingExternal || !editor) return
    void (async () => {
      const active = tabs.activeTab
      if (!active) return
      const markdown = await editor!.save()
      const myGen = gen
      // only apply when the active tab hasn't switched underneath
      if (tabs.activeTab?.id !== active.id) return
      if (myGen !== gen) return
      active.content = markdown
      tabs.markDirty(active.id)
    })()
  })

  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  unlistenChange?.()
  window.removeEventListener('keydown', onKeydown)
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
  <div class="editor-pane">
    <WordToolbar @command="handleCommand" />
    <div
      ref="editorEl"
      class="editor-container"
    />
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
.editor-container {
  flex: 1;
  overflow: auto;
  padding: 0 16px;
}
</style>