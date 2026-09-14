<script setup lang="ts">
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
import ToolbarMenu from './ToolbarMenu.vue'
import { COMMAND_KEYS } from '../ui/command-catalog'
import { rewriteSelection } from '../services/ai-edit'
import type { EditAction } from '../services/ai-edit'
import { t } from '../i18n'

const emit = defineEmits<{ (e: 'command', id: string): void }>()

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6]

function pickHeading(level: number): void {
  emit('command', `heading:h${level}`)
}

const AI_ACTIONS: ReadonlyArray<{ id: EditAction; badge: string; labelKey: string }> = [
  { id: 'rewrite', badge: 'RW', labelKey: 'ai.rewrite' },
  { id: 'polish', badge: 'PL', labelKey: 'ai.polish' },
  { id: 'translate', badge: 'TR', labelKey: 'ai.translate' },
]

function runAi(action: EditAction): void {
  void rewriteSelection(action)
}

const registryItems = getToolbar()

const REGISTRY_ICONS: Record<string, Component> = {
  'math.insert': Sigma,
  'table.insert': TableIcon,
  'callout.insert': MessageSquareQuote,
  'floatbox.insert': Boxes,
}

/**
 * Tooltip / label for a registry (plugin or builtin) toolbar item.
 *
 * Registration happens in editor-core, which has no i18n, so the builtin
 * "Table" button shipped an English tooltip in an otherwise localized toolbar.
 * `COMMAND_KEYS` already maps the command ids to message keys for the command
 * palette, so reuse it and fall back to the registered label for a
 * third-party plugin (which brings its own text).
 */
function registryLabel(item: { id: string; label: string }): string {
  const key = COMMAND_KEYS[item.id]
  return key ? t(key) : item.label
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
    <ToolbarMenu
      :title="t('toolbar.heading')"
      :icon="Heading2"
    >
      <template #default="{ close }">
        <button
          v-for="level in HEADING_LEVELS"
          :key="level"
          class="menu-option"
          @click="pickHeading(level); close()"
        >
          <span
            class="heading-preview"
            :data-level="level"
          >H{{ level }}</span>
          {{ t('toolbar.headingLevel', { n: level }) }}
        </button>
      </template>
    </ToolbarMenu>
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
    <ToolbarMenu
      :title="t('ai.title')"
      :icon="Sparkles"
    >
      <template #default="{ close }">
        <button
          v-for="action in AI_ACTIONS"
          :key="action.id"
          class="menu-option"
          @click="runAi(action.id); close()"
        >
          <span class="heading-preview">{{ action.badge }}</span>
          {{ t(action.labelKey) }}
        </button>
      </template>
    </ToolbarMenu>
    <template v-if="registryItems.length">
      <span class="toolbar-sep" />
      <button
        v-for="item in registryItems"
        :key="`reg-${item.id}`"
        class="toolbar-btn"
        :data-command-id="item.id"
        :title="registryLabel(item)"
        :aria-label="registryLabel(item)"
        @mousedown.prevent
        @click="runRegistry(item.id)"
      >
        <component
          :is="REGISTRY_ICONS[item.id]"
          v-if="REGISTRY_ICONS[item.id]"
          :size="15"
          :stroke-width="1.8"
        />
        <span v-else>{{ registryLabel(item) }}</span>
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
</style>
