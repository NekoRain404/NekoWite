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
  Sparkles,
  SquareCode,
  Strikethrough,
  Table as TableIcon,
  Boxes,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import { rewriteSelection } from '../services/aiEdit'
import type { EditAction } from '../services/aiEdit'
import { t } from '../i18n'

const emit = defineEmits<{ (e: 'command', id: string): void }>()

const headingMenuOpen = ref(false)
const headingEl = ref<HTMLElement | null>(null)

const aiMenuOpen = ref(false)
const aiMenuEl = ref<HTMLElement | null>(null)

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6]

function toggleHeadingMenu(): void {
  headingMenuOpen.value = !headingMenuOpen.value
}

function pickHeading(level: number): void {
  headingMenuOpen.value = false
  emit('command', `heading:h${level}`)
}

function toggleAiMenu(): void {
  aiMenuOpen.value = !aiMenuOpen.value
}

function runAi(action: EditAction): void {
  aiMenuOpen.value = false
  void rewriteSelection(action)
}

function onDocPointerDown(e: PointerEvent): void {
  if (!headingMenuOpen.value && !aiMenuOpen.value) return
  if (headingEl.value && headingEl.value.contains(e.target as Node)) {
    return
  }
  if (aiMenuEl.value && aiMenuEl.value.contains(e.target as Node)) {
    return
  }
  headingMenuOpen.value = false
  aiMenuOpen.value = false
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

/**
 * Plugin/registry buttons resolve their own view, which is the rendered one —
 * in source mode that edit would be lost. Routing them through the same
 * `command` event as the builtin buttons puts them on the shared, mode-aware
 * path.
 */
function runRegistry(id: string): void {
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
        :title="t('toolbar.heading')"
        :aria-label="t('toolbar.heading')"
        @click="toggleHeadingMenu"
      >
        <Heading2
          :size="15"
          :stroke-width="1.8"
        />
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
            <span
              class="heading-preview"
              :data-level="level"
            >H{{ level }}</span>
            {{ t('toolbar.headingLevel', { n: level }) }}
          </button>
        </div>
      </Transition>
    </div>
    <span class="toolbar-sep" />
    <button
      class="toolbar-btn"
      :title="t('toolbar.bold')"
      :aria-label="t('toolbar.bold')"
      @mousedown.prevent
      @click="run('bold')"
    >
      <Bold
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <button
      class="toolbar-btn"
      :title="t('toolbar.italic')"
      :aria-label="t('toolbar.italic')"
      @mousedown.prevent
      @click="run('italic')"
    >
      <Italic
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <button
      class="toolbar-btn"
      :title="t('toolbar.strike')"
      :aria-label="t('toolbar.strike')"
      @mousedown.prevent
      @click="run('strike')"
    >
      <Strikethrough
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <button
      class="toolbar-btn"
      :title="t('toolbar.inlineCode')"
      :aria-label="t('toolbar.inlineCode')"
      @mousedown.prevent
      @click="run('inline-code')"
    >
      <Code
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <span class="toolbar-sep" />
    <button
      class="toolbar-btn"
      :title="t('toolbar.link')"
      :aria-label="t('toolbar.link')"
      @mousedown.prevent
      @click="run('link')"
    >
      <Link
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <button
      class="toolbar-btn"
      :title="t('toolbar.image')"
      :aria-label="t('toolbar.image')"
      @mousedown.prevent
      @click="run('image')"
    >
      <ImageIcon
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <span class="toolbar-sep" />
    <button
      class="toolbar-btn"
      :title="t('toolbar.listUnordered')"
      :aria-label="t('toolbar.listUnordered')"
      @mousedown.prevent
      @click="run('list-unordered')"
    >
      <List
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <button
      class="toolbar-btn"
      :title="t('toolbar.listOrdered')"
      :aria-label="t('toolbar.listOrdered')"
      @mousedown.prevent
      @click="run('list-ordered')"
    >
      <ListOrdered
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <button
      class="toolbar-btn"
      :title="t('toolbar.listTask')"
      :aria-label="t('toolbar.listTask')"
      @mousedown.prevent
      @click="run('list-task')"
    >
      <ListTodo
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <button
      class="toolbar-btn"
      :title="t('toolbar.quote')"
      :aria-label="t('toolbar.quote')"
      @mousedown.prevent
      @click="run('quote')"
    >
      <Quote
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <span class="toolbar-sep" />
    <button
      class="toolbar-btn"
      :title="t('toolbar.codeBlock')"
      :aria-label="t('toolbar.codeBlock')"
      @mousedown.prevent
      @click="run('code-block')"
    >
      <SquareCode
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <button
      class="toolbar-btn"
      :title="t('toolbar.hr')"
      :aria-label="t('toolbar.hr')"
      @mousedown.prevent
      @click="run('hr')"
    >
      <Minus
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <span class="toolbar-sep" />
    <button
      class="toolbar-btn"
      :title="t('toolbar.insertComponent')"
      :aria-label="t('toolbar.insertComponent')"
      @mousedown.prevent
      @click="run('insert-component')"
    >
      <Braces
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <div
      ref="aiMenuEl"
      class="heading-menu-wrap"
    >
      <button
        class="toolbar-btn"
        :title="t('ai.title')"
        :aria-label="t('ai.title')"
        @click="toggleAiMenu"
      >
        <Sparkles
          :size="15"
          :stroke-width="1.8"
        />
      </button>
      <Transition name="menu">
        <div
          v-if="aiMenuOpen"
          class="heading-menu"
        >
          <button
            class="heading-option"
            @click="runAi('rewrite')"
          >
            <span class="heading-preview">RW</span>
            {{ t('ai.rewrite') }}
          </button>
          <button
            class="heading-option"
            @click="runAi('polish')"
          >
            <span class="heading-preview">PL</span>
            {{ t('ai.polish') }}
          </button>
          <button
            class="heading-option"
            @click="runAi('translate')"
          >
            <span class="heading-preview">TR</span>
            {{ t('ai.translate') }}
          </button>
        </div>
      </Transition>
    </div>
    <template v-if="registryItems.length">
      <span class="toolbar-sep" />
      <button
        v-for="item in registryItems"
        :key="`reg-${item.id}`"
        class="toolbar-btn"
        :title="item.label"
        :aria-label="item.label"
        @mousedown.prevent
        @click="runRegistry(item.id)"
      >
        <component
          :is="REGISTRY_ICONS[item.id]"
          v-if="REGISTRY_ICONS[item.id]"
          :size="15"
          :stroke-width="1.8"
        />
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
