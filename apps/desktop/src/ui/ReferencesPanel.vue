<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { computeCiteOrder } from '@nekowite/editor-core'
import { useRefsStore } from '../stores/refs'
import { editorBridge } from '../services/editorBridge'
import { t } from '../i18n'

const refs = useRefsStore()
const bump = ref(0)
let unlistenChange: (() => void) | null = null
let offEditorChange: (() => void) | null = null

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

function resubscribe(): void {
  unlistenChange?.()
  unlistenChange = null
  const editor = editorBridge.getEditor()
  if (editor) {
    unlistenChange = editor.onContentChange(() => {
      bump.value++
    })
  }
}

onMounted(() => {
  // The editor is created lazily (after the first tab opens), so subscribe
  // now if it exists and again whenever it is (re)created.
  resubscribe()
  offEditorChange = editorBridge.onEditorChange(() => {
    resubscribe()
    bump.value++
  })
})

onBeforeUnmount(() => {
  unlistenChange?.()
  unlistenChange = null
  offEditorChange?.()
  offEditorChange = null
})
</script>

<template>
  <section class="references-panel">
    <h3 class="rail-section-title">
      {{ t('references.title') }}
      <span
        v-if="cited.length"
        class="rail-section-count"
      >{{ cited.length }}</span>
    </h3>
    <ol
      v-if="cited.length"
      class="refs-list"
    >
      <li
        v-for="c in cited"
        :key="c.key"
        class="refs-item"
      >
        <span class="refs-num">[{{ c.num }}]</span>
        <span class="refs-body">
          <span class="refs-key">{{ c.key }}</span>
          <span
            v-if="c.title"
            class="refs-detail"
          >{{ c.title }} ({{ c.authors.join(', ') }}{{ c.year ? `, ${c.year}` : '' }})</span>
          <span
            v-else
            class="refs-detail refs-missing"
          >
            {{ t('references.missing') }}
          </span>
        </span>
      </li>
    </ol>
    <p
      v-else
      class="rail-empty"
    >
      {{ t('references.empty') }}
    </p>
  </section>
</template>

<style scoped>
.references-panel {
  padding: 12px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
}
.rail-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
}
.rail-section-count {
  font-weight: 400;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}
.refs-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.refs-item {
  display: flex;
  gap: 6px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--app-text);
}
.refs-num {
  flex: none;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
}
.refs-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.refs-key {
  font-weight: 600;
  letter-spacing: -0.01em;
}
.refs-detail {
  color: color-mix(in srgb, var(--app-text) 76%, var(--app-muted));
  overflow-wrap: anywhere;
}
.refs-missing { color: var(--app-muted); }
.rail-empty {
  margin: 0;
  font-size: 11px;
  color: var(--app-muted);
}
</style>
