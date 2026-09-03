<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getToolbar } from '@nekowite/editor-core'
import {
  Bold,
  Braces,
  Code,
  Heading2,
  Image as ImageIcon,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  MessageSquareQuote,
  Minus,
  Quote,
  Sigma,
  SquareCode,
  Strikethrough,
  Table as TableIcon,
  Boxes,
} from 'lucide-vue-next'
import type { Component } from 'vue'

const emit = defineEmits<{ (e: 'command', id: string): void }>()

const headingMenuOpen = ref(false)
const headingEl = ref<HTMLElement | null>(null)

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6]

function toggleHeadingMenu(): void {
  headingMenuOpen.value = !headingMenuOpen.value
}

function pickHeading(level: number): void {
  headingMenuOpen.value = false
  emit('command', `heading:h${level}`)
}

function onDocPointerDown(e: PointerEvent): void {
  if (!headingMenuOpen.value) return
  if (headingEl.value && !headingEl.value.contains(e.target as Node)) {
    headingMenuOpen.value = false
  }
}

onMounted(() => document.addEventListener('pointerdown', onDocPointerDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown, true))

const registryItems = getToolbar()

const REGISTRY_ICONS: Record<string, Component> = {
  'math.insert': Sigma,
  'table.insert': TableIcon,
  'callout.insert': MessageSquareQuote,
  'floatbox.insert': Boxes,
}

function run(id: string): void {
  emit('command', id)
}
</script>

<template>
  <div
    class="word-toolbar"
    role="toolbar"
  >
    <div
      ref="headingEl"
      class="heading-menu-wrap"
    >
      <button
        class="toolbar-btn"
        title="标题"
        @click="toggleHeadingMenu"
      >
        <Heading2 :size="15" :stroke-width="1.8" />
      </button>
      <Transition name="menu">
        <div
          v-if="headingMenuOpen"
          class="heading-menu"
        >
          <button
            v-for="level in HEADING_LEVELS"
            :key="level"
            class="heading-option"
            @click="pickHeading(level)"
          >
            <span class="heading-preview" :data-level="level">H{{ level }}</span>
            标题 {{ level }}
          </button>
        </div>
      </Transition>
    </div>
    <span class="toolbar-sep" />
    <button class="toolbar-btn" title="加粗" @click="run('bold')"><Bold :size="15" :stroke-width="1.8" /></button>
    <button class="toolbar-btn" title="斜体" @click="run('italic')"><Italic :size="15" :stroke-width="1.8" /></button>
    <button class="toolbar-btn" title="删除线" @click="run('strike')"><Strikethrough :size="15" :stroke-width="1.8" /></button>
    <button class="toolbar-btn" title="行内代码" @click="run('inline-code')"><Code :size="15" :stroke-width="1.8" /></button>
    <span class="toolbar-sep" />
    <button class="toolbar-btn" title="链接" @click="run('link')"><Link :size="15" :stroke-width="1.8" /></button>
    <button class="toolbar-btn" title="图片" @click="run('image')"><ImageIcon :size="15" :stroke-width="1.8" /></button>
    <span class="toolbar-sep" />
    <button class="toolbar-btn" title="无序列表" @click="run('list-unordered')"><List :size="15" :stroke-width="1.8" /></button>
    <button class="toolbar-btn" title="有序列表" @click="run('list-ordered')"><ListOrdered :size="15" :stroke-width="1.8" /></button>
    <button class="toolbar-btn" title="任务列表" @click="run('list-task')"><ListTodo :size="15" :stroke-width="1.8" /></button>
    <button class="toolbar-btn" title="引用" @click="run('quote')"><Quote :size="15" :stroke-width="1.8" /></button>
    <span class="toolbar-sep" />
    <button class="toolbar-btn" title="代码块" @click="run('code-block')"><SquareCode :size="15" :stroke-width="1.8" /></button>
    <button class="toolbar-btn" title="分隔线" @click="run('hr')"><Minus :size="15" :stroke-width="1.8" /></button>
    <span class="toolbar-sep" />
    <button class="toolbar-btn" title="插入 MDX 组件" @click="run('insert-component')"><Braces :size="15" :stroke-width="1.8" /></button>
    <template v-if="registryItems.length">
      <span class="toolbar-sep" />
      <button
        v-for="item in registryItems"
        :key="`reg-${item.id}`"
        class="toolbar-btn"
        :title="item.label"
        @click="item.run()"
      >
        <component :is="REGISTRY_ICONS[item.id]" v-if="REGISTRY_ICONS[item.id]" :size="15" :stroke-width="1.8" />
        <span v-else>{{ item.label }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.word-toolbar {
  display: flex;
  align-items: center;
  gap: 1px;
  height: var(--app-toolbar-height);
  padding: 0 10px;
  border-bottom: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-elevated) 76%, var(--app-canvas));
  overflow-x: auto;
  user-select: none;
}
.heading-menu-wrap {
  position: relative;
  display: inline-flex;
}
.heading-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 140px;
  padding: 5px;
  background: color-mix(in srgb, var(--app-elevated) 96%, var(--app-panel));
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-lg);
  box-shadow: var(--app-shadow-menu);
}
.heading-option {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.heading-option:hover {
  background: color-mix(in srgb, var(--app-accent-soft) 70%, var(--app-elevated));
}
.heading-preview {
  width: 26px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  background: color-mix(in srgb, var(--app-panel) 70%, transparent);
  font-size: 10px;
  font-weight: 700;
  color: var(--app-muted);
}
.heading-preview[data-level="1"] { font-size: 13px; }
.heading-preview[data-level="2"] { font-size: 12px; }
.heading-preview[data-level="3"] { font-size: 11px; }
.menu-enter-active,
.menu-leave-active {
  transition: opacity var(--app-motion-fast) var(--app-ease),
              transform var(--app-motion-fast) var(--app-ease);
}
.menu-enter-from,
.menu-leave-to {
  opacity: 0;
  transform: translateY(4px) scale(0.98);
}
</style>
