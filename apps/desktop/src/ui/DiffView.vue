<script setup lang="ts">
import { computed } from 'vue'
import { X } from 'lucide-vue-next'
import { diffStats, lineDiff } from '../services/diff'
import { t } from '../i18n'

const props = defineProps<{
  /** Current editor content. */
  current: string
  /** A historic version of the same document. */
  history: string
  /** Optional human-readable timestamp for the history side. */
  historyTime?: string
}>()

const emit = defineEmits<{
  (e: 'restore'): void
  (e: 'close'): void
}>()

const ops = computed(() => lineDiff(props.current, props.history))
const stats = computed(() => diffStats(ops.value))
const identical = computed(() => stats.value.added === 0 && stats.value.removed === 0)
</script>

<template>
  <section class="diff-view">
    <header class="diff-header">
      <span class="diff-title">{{ t('diff.title') }}</span>
      <button
        class="diff-close"
        :title="t('diff.close')"
        :aria-label="t('diff.close')"
        @click="emit('close')"
      >
        <X
          :size="13"
          :stroke-width="1.8"
        />
      </button>
    </header>

    <p class="diff-meta">
      <span class="diff-meta-label">{{ t('diff.currentLabel') }}</span>
      <span class="diff-meta-sep">→</span>
      <span class="diff-meta-time">{{ historyTime ?? t('diff.historyLabel') }}</span>
    </p>

    <div class="diff-toolbar">
      <span
        v-if="!identical"
        class="diff-stats"
      >
        <span class="diff-stat diff-stat-add">+{{ stats.added }}</span>
        <span class="diff-stat diff-stat-del">−{{ stats.removed }}</span>
        <span class="diff-stat diff-stat-same">{{ t('diff.unchangedCount', { n: stats.unchanged }) }}</span>
      </span>
      <span
        v-else
        class="diff-stats"
      >
        {{ t('diff.unchangedCount', { n: stats.unchanged }) }}
      </span>
      <button
        class="btn btn-secondary btn-sm btn-diff-restore"
        :disabled="identical"
        :title="t('diff.restoreTitle')"
        @click="emit('restore')"
      >
        {{ t('diff.restore') }}
      </button>
    </div>

    <div
      v-if="identical"
      class="diff-identical"
    >
      {{ t('diff.identical') }}
    </div>
    <div
      v-else
      class="diff-scroll"
    >
      <div
        v-for="(line, index) in ops"
        :key="index"
        class="diff-line"
        :class="`diff-line-${line.type}`"
      >
        <span class="diff-gutter">{{ line.oldLine ?? '' }}</span>
        <span class="diff-gutter">{{ line.newLine ?? '' }}</span>
        <code class="diff-text">{{ line.text || ' ' }}</code>
      </div>
    </div>
  </section>
</template>

<style scoped>
.diff-view {
  margin-top: 8px;
  border: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
  border-radius: var(--app-radius);
  background: color-mix(in srgb, var(--app-elevated) 52%, var(--app-panel));
  overflow: hidden;
}
.diff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
}
.diff-title {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
}
.diff-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.diff-close:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.diff-close:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.diff-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 5px 8px;
  font-size: 10px;
  color: var(--app-muted);
}
.diff-meta-sep {
  color: color-mix(in srgb, var(--app-muted) 55%, transparent);
}
.diff-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 8px 6px;
}
.diff-stats {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--app-muted);
  min-width: 0;
}
.diff-stat {
  white-space: nowrap;
}
.diff-stat-add {
  color: var(--app-success);
  font-weight: 600;
}
.diff-stat-del {
  color: var(--app-danger);
  font-weight: 600;
}
.diff-identical {
  padding: 12px;
  text-align: center;
  font-size: 11px;
  color: var(--app-muted);
}
.diff-scroll {
  max-height: 260px;
  overflow: auto;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
  font-family: var(--app-mono-font);
  font-size: 11px;
  line-height: 1.6;
}
.diff-line {
  display: grid;
  grid-template-columns: 34px 34px minmax(0, 1fr);
  align-items: start;
}
.diff-line-same {
  color: var(--app-muted);
}
.diff-line-del {
  background: color-mix(in srgb, var(--app-danger) 14%, transparent);
  color: color-mix(in srgb, var(--app-danger) 82%, var(--app-text));
}
.diff-line-add {
  background: color-mix(in srgb, var(--app-success) 16%, transparent);
  color: color-mix(in srgb, var(--app-success) 74%, var(--app-text));
}
.diff-gutter {
  padding: 0 6px;
  text-align: right;
  white-space: nowrap;
  color: color-mix(in srgb, var(--app-muted) 55%, transparent);
  user-select: none;
  font-variant-numeric: tabular-nums;
}
.diff-gutter:not(:empty)::after {
  content: '·';
  color: color-mix(in srgb, var(--app-muted) 30%, transparent);
}
.diff-text {
  padding: 0 8px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: inherit;
}
</style>