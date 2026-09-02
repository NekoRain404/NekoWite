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
  border-right: 1px solid #e0e0e0;
  padding: 10px;
  overflow: auto;
  background: #fafafa;
  height: 100%;
}
.ref-search {
  width: 100%;
  box-sizing: border-box;
  padding: 6px;
  margin-bottom: 8px;
}
.ref-list { list-style: none; margin: 0; padding: 0; }
.ref-item {
  padding: 6px;
  border-bottom: 1px solid #f0f0f0;
  cursor: pointer;
  font-size: 12px;
}
.ref-item:hover { background: #f0f7ff; }
.ref-key { font-weight: 700; display: block; }
.ref-title { display: block; color: #333; }
.ref-meta { display: block; color: #888; }
.ref-empty { color: #999; font-size: 12px; padding: 8px; }
</style>
