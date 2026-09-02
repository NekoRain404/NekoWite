<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRefsStore } from '../stores/refs'
import { insertCiteAtCursor } from '../services/editorBridge'

const store = useRefsStore()
const query = ref('')
const results = computed(() => store.search(query.value))

function insert(key: string): void {
  insertCiteAtCursor(key)
  query.value = ''
}
</script>

<template>
  <aside class="ref-sidebar">
    <h3>References</h3>
    <input
      v-model="query"
      class="ref-search"
      placeholder="搜索 key / 标题 / 作者 / 年份"
    >
    <ul class="ref-list">
      <li
        v-for="r in results"
        :key="r.key"
        class="ref-item"
        @click="insert(r.key)"
      >
        <span class="ref-key">{{ r.key }}</span>
        <span class="ref-title">{{ r.title }}</span>
        <span class="ref-meta">{{ r.authors.join(', ') }} · {{ r.year }}</span>
      </li>
      <li
        v-if="results.length === 0"
        class="ref-empty"
      >
        无匹配引用。请将 .bib / .ris / .json(CSL) 文件放入 vault。
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.ref-sidebar {
  width: 260px;
  min-width: 260px;
  border-right: 1px solid var(--app-border);
  padding: 10px;
  overflow: auto;
  background: var(--app-panel);
  height: 100%;
}
.ref-sidebar h3 { color: var(--app-text); font-size: 13px; margin: 0 0 8px; }
.ref-search {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  margin-bottom: 8px;
  border: 1px solid var(--app-border);
  background: var(--app-elevated);
  border-radius: var(--app-radius);
  color: var(--app-text);
}
.ref-search:focus { outline: 2px solid var(--app-accent); outline-offset: 0; }
.ref-list { list-style: none; margin: 0; padding: 0; }
.ref-item {
  padding: 6px 8px;
  border-bottom: 1px solid var(--app-border);
  cursor: pointer;
  font-size: 12px;
  border-radius: var(--app-radius);
}
.ref-item:hover { background: var(--app-accent-soft); }
.ref-key { font-weight: 700; display: block; color: var(--app-text); }
.ref-title { display: block; color: var(--app-text); }
.ref-meta { display: block; color: var(--app-muted); }
.ref-empty { color: var(--app-muted); font-size: 12px; padding: 8px; }
</style>
