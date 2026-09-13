<script setup lang="ts">
import { computed } from 'vue'
import { parseOutline, type OutlineItem } from '../services/outline'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'
import { t } from '../i18n'

const tabs = useTabsStore()
const view = useViewStore()

const items = computed<OutlineItem[]>(() => parseOutline(tabs.activeTab?.content ?? ''))
const hasDoc = computed(() => tabs.activeTab !== null)

function onPick(item: OutlineItem): void {
  view.requestOutlineTarget({ line: item.line, index: item.index })
}
</script>

<template>
  <section class="outline-panel">
    <h3 class="rail-section-title">
      {{ t('outline.title') }}
      <span
        v-if="items.length"
        class="rail-section-count"
      >{{ items.length }}</span>
    </h3>
    <template v-if="hasDoc">
      <ul
        v-if="items.length"
        class="outline-list"
      >
        <li
          v-for="item in items"
          :key="item.index"
        >
          <button
            class="outline-item"
            :style="{ paddingLeft: `${(item.level - 1) * 12 + 8}px` }"
            :title="t('outline.jumpLine', { n: item.line + 1 })"
            @click="onPick(item)"
          >
            <span class="outline-level">H{{ item.level }}</span>
            <span class="outline-text">{{ item.text || t('outline.emptyHeading') }}</span>
          </button>
        </li>
      </ul>
      <!-- Only when the list is empty: the hint used to sit outside the list's
           v-if, so every document with headings had "no headings" printed
           underneath its outline. -->
      <p
        v-if="!items.length"
        class="rail-empty"
      >
        {{ t('outline.empty') }}
      </p>
    </template>
    <p
      v-else
      class="rail-empty"
    >
      {{ t('outline.openDoc') }}
    </p>
  </section>
</template>

<style scoped>
.outline-panel {
  padding: 12px 14px;
}
.rail-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}
.rail-section-count {
  font-weight: 400;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}
.outline-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.outline-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 11px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.outline-item:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.outline-item:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.outline-level {
  flex: none;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
}
.outline-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rail-empty {
  margin: 0;
  font-size: 11px;
  color: var(--app-muted);
}
</style>
