<script setup lang="ts">
import { getToolbar } from '@nekowite/editor-core'

const emit = defineEmits<{ (e: 'command', id: string): void }>()

interface Btn {
  id: string
  label: string
  title: string
}

const buttons: Btn[] = [
  { id: 'heading:h1', label: 'H1', title: 'Heading 1' },
  { id: 'heading:h2', label: 'H2', title: 'Heading 2' },
  { id: 'heading:h3', label: 'H3', title: 'Heading 3' },
  { id: 'heading:h4', label: 'H4', title: 'Heading 4' },
  { id: 'heading:h5', label: 'H5', title: 'Heading 5' },
  { id: 'heading:h6', label: 'H6', title: 'Heading 6' },
  { id: 'separator', label: '|', title: '' },
  { id: 'bold', label: 'B', title: 'Bold' },
  { id: 'italic', label: 'I', title: 'Italic' },
  { id: 'strike', label: 'S', title: 'Strikethrough' },
  { id: 'inline-code', label: '`', title: 'Inline code' },
  { id: 'separator', label: '|', title: '' },
  { id: 'list-ordered', label: '1.', title: 'Ordered list' },
  { id: 'list-unordered', label: '•', title: 'Unordered list' },
  { id: 'list-task', label: '☑', title: 'Task list' },
  { id: 'separator', label: '|', title: '' },
  { id: 'quote', label: '“”', title: 'Blockquote' },
  { id: 'link', label: '🔗', title: 'Insert link' },
  { id: 'image', label: '🖼', title: 'Insert image' },
  { id: 'code-block', label: '</>', title: 'Code block' },
  { id: 'hr', label: '—', title: 'Thematic break' },
  { id: 'separator', label: '|', title: '' },
  { id: 'insert-component', label: 'MDX', title: 'Insert MDX component' },
]

const registryItems = getToolbar()

function run(id: string): void {
  if (id === 'separator') return
  emit('command', id)
}
</script>

<template>
  <div class="word-toolbar">
    <button
      v-for="b in buttons"
      :key="`builtin-${b.id}-${b.title}`"
      class="tb-btn"
      :class="{ sep: b.id === 'separator' }"
      :title="b.title"
      @click="run(b.id)"
    >
      {{ b.label }}
    </button>
    <template v-if="registryItems.length">
      <span class="tb-sep">|</span>
      <button
        v-for="item in registryItems"
        :key="`reg-${item.id}`"
        class="tb-btn"
        :title="item.id"
        @click="item.run()"
      >
        {{ item.label }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.word-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  padding: 4px 8px;
  border-bottom: 1px solid #e0e0e0;
  background: #fbfbfb;
}
.tb-btn {
  min-width: 28px;
  padding: 3px 6px;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1.3;
}
.tb-btn:hover { background: #ececec; border-color: #d0d0d0; }
.tb-btn.sep { cursor: default; color: #bbb; }
.tb-btn.sep:hover { background: transparent; border-color: transparent; }
.tb-sep { color: #bbb; margin: 0 4px; }
</style>