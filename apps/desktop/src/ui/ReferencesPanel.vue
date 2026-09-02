<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { computeCiteOrder } from '@nekowite/editor-core'
import { useRefsStore } from '../stores/refs'
import { editorBridge } from '../services/editorBridge'

const refs = useRefsStore()
const bump = ref(0)
let unlistenChange: (() => void) | null = null

interface Cited {
  key: string
  num: number
  title: string | null
  authors: string[]
  year: string | null
}

const cited = computed<Cited[]>(() => {
  // Re-run whenever the editor signals a doc change (bump) or refs load.
  void bump.value
  const view = editorBridge.getView()
  if (!view) return []
  // Reuse editor-core's numbering so chips in the doc and this panel agree.
  const order = computeCiteOrder(view)
  return [...order.entries()].map(([key, num]) => {
    const ref = refs.get(key)
    return { key, num, title: ref?.title ?? null, authors: ref?.authors ?? [], year: ref?.year ?? null }
  })
})

onMounted(() => {
  const editor = editorBridge.getEditor()
  if (editor) {
    unlistenChange = editor.onContentChange(() => {
      bump.value++
    })
  }
})

onBeforeUnmount(() => {
  unlistenChange?.()
  unlistenChange = null
})
</script>

<template>
  <section class="references-panel">
    <h3>References</h3>
    <ol
      v-if="cited.length"
      class="refs-list"
    >
      <li
        v-for="c in cited"
        :key="c.key"
        class="refs-item"
      >
        [{{ c.num }}] <b>{{ c.key }}</b> —
        <template v-if="c.title">
          {{ c.title }} ({{ c.authors.join(', ') }}{{ c.year ? `, ${c.year}` : '' }})
        </template>
        <template v-else>
          （未在引用库中找到）
        </template>
      </li>
    </ol>
    <p
      v-else
      class="refs-empty"
    >
      本文档还没有引用。
    </p>
  </section>
</template>

<style scoped>
.references-panel {
  border-top: 1px solid var(--app-border);
  padding: 10px;
  max-height: 220px;
  overflow: auto;
  background: var(--app-elevated);
}
.references-panel h3 { color: var(--app-text); font-size: 13px; margin: 0 0 6px; }
.refs-list { margin: 0; padding-left: 20px; font-size: 12px; color: var(--app-text); }
.refs-empty { color: var(--app-muted); font-size: 12px; }
</style>