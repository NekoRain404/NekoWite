<script setup lang="ts">
import { computed } from 'vue'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'
import { useAppearanceStore } from '../stores/appearance'
import { taskProgress } from '../services/editorBehaviors'
import { t } from '../i18n'

const tabs = useTabsStore()
const view = useViewStore()
const appearance = useAppearanceStore()

const VERSION = 'v0.1.0'

// CJK unified ideographs + kana + Hangul syllables: no whitespace between words.
const CJK_RE = /[一-鿿぀-ヿ가-힯]/g

function countWords(text: string): number {
  // CJK text has no whitespace between words — count each character as one
  // word, and count whitespace-separated runs in the remainder as words.
  const cjk = text.match(CJK_RE)?.length ?? 0
  const rest = text.replace(CJK_RE, ' ').trim()
  const latinWords = rest ? rest.split(/\s+/).filter(Boolean).length : 0
  return cjk + latinWords
}

const content = computed(() => tabs.activeTab?.content ?? '')
const wordCount = computed(() => countWords(content.value))
const charCount = computed(() => content.value.length)
const readMinutes = computed(() => (wordCount.value === 0 ? 0 : Math.max(1, Math.ceil(wordCount.value / 300))))
const taskInfo = computed(() => taskProgress(content.value))

const saveState = computed(() => {
  const tab = tabs.activeTab
  if (!tab) return null
  return tabs.saveStateOf(tab.id)
})

const saveLabel = computed(() => {
  switch (saveState.value) {
    case 'saving': return t('status.saving')
    case 'dirty': return t('status.dirty')
    case 'saved': return t('status.saved')
    default: return ''
  }
})

const modeLabel = computed(() => {
  switch (view.mode) {
    case 'source': return t('status.source')
    case 'rendered': return t('status.rendered')
    case 'split': return t('status.split')
    default: return view.mode
  }
})
</script>

<template>
  <footer class="status-bar">
    <template v-if="appearance.statusBarWords">
      <span class="status-item">{{ t('status.words', { n: wordCount }) }}</span>
      <span class="status-sep">·</span>
      <span class="status-item">{{ t('status.chars', { n: charCount }) }}</span>
      <span class="status-sep">·</span>
      <span class="status-item">{{ t('status.readMinutes', { n: readMinutes }) }}</span>
    </template>
    <span
      v-if="taskInfo.total > 0"
      class="status-item status-task"
      :class="{ 'is-done': taskInfo.done === taskInfo.total }"
    >
      {{ t('status.tasks', { done: taskInfo.done, total: taskInfo.total }) }}
    </span>
    <span class="status-spacer" />
    <span
      v-if="saveState"
      class="status-save"
      :data-state="saveState"
    >
      <span class="save-dot" :class="{ 'is-shown': saveState !== 'saved' }" :data-state="saveState" />
      {{ saveLabel }}
    </span>
    <span class="status-sep">·</span>
    <span class="status-item">{{ modeLabel }}</span>
    <span class="status-sep">·</span>
    <span class="status-item">NekoWite {{ VERSION }}</span>
    <slot name="actions" />
  </footer>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--app-statusbar-height);
  flex: none;
  padding: 0 14px;
  border-top: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel) 92%, var(--app-elevated));
  font-size: 11px;
  letter-spacing: -0.006em;
  color: var(--app-muted);
  user-select: none;
}
.status-item { white-space: nowrap; }
.status-sep { opacity: 0.6; }
.status-spacer { flex: 1; }
.status-task.is-done { color: var(--app-accent); }
.status-save {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.status-save .save-dot { width: 7px; height: 7px; }
</style>
