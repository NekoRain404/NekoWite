<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'

const tabs = useTabsStore()
const view = useViewStore()

const container = ref<HTMLTextAreaElement | null>(null)

const content = computed(() => tabs.activeTab?.content ?? '')

function onInput(e: Event): void {
  const target = e.target as HTMLTextAreaElement
  const tab = tabs.activeTab
  if (!tab) return
  tab.content = target.value
  tabs.markDirty(tab.id)
}

function onScroll(): void {
  if (container.value) view.syncScroll('source', container.value.scrollTop)
}

function getRatio(): number {
  const el = container.value
  if (!el) return 0
  const range = el.scrollHeight - el.clientHeight
  return range > 0 ? el.scrollTop / range : 0
}

function setRatio(r: number): void {
  const el = container.value
  if (!el) return
  const range = el.scrollHeight - el.clientHeight
  if (range > 0) el.scrollTop = r * range
}

defineExpose({ getRatio, setRatio })
</script>

<template>
  <textarea
    ref="container"
    class="source-textarea"
    :value="content"
    spellcheck="false"
    @input="onInput"
    @scroll="onScroll"
  />
</template>

<style scoped>
.source-textarea {
  width: 100%;
  height: 100%;
  border: none;
  outline: none;
  resize: none;
  padding: 16px;
  font-family: var(--neko-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 14px;
  line-height: 1.6;
  background: var(--app-canvas);
  color: var(--app-text);
}
</style>