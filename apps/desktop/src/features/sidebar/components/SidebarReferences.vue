<script setup lang="ts">
/**
 * The references section: the search box over the vault's bibliography and the
 * entries it matches.
 *
 * A section renders and forwards (§13.3): the search state, the results and the
 * insert command come from `composables/useSidebarReferences`, and the open
 * state belongs to the sidebar, which collapses the group when the vault
 * changes. The group's chrome comes from `SidebarGroup` — the body it wraps is
 * this component's, so the styles below are this component's too.
 */
import SidebarGroup from './SidebarGroup.vue'
import { useSidebarReferences } from '../composables/use-sidebar-references'
import { t } from '../../../i18n'

const open = defineModel<boolean>('open', { required: true })

const { refQuery, refCount, refResults, insertRef } = useSidebarReferences()
</script>

<template>
  <SidebarGroup
    :title="t('nav.references')"
    :count="refCount"
    :open="open"
    @toggle="open = !open"
  >
    <input
      v-model="refQuery"
      class="search-input ref-search"
      type="text"
      :placeholder="t('nav.searchRefs')"
    >
    <button
      v-for="r in refResults"
      :key="r.key"
      class="ref-item"
      :title="t('nav.insertRef', { key: r.key })"
      @click="insertRef(r.key)"
    >
      <span class="ref-key">{{ r.key }}</span>
      <span class="ref-title">{{ r.title }}</span>
      <span class="ref-meta">{{ r.authors.join(', ') }}{{ r.year ? ` · ${r.year}` : '' }}</span>
    </button>
    <p
      v-if="refResults.length === 0"
      class="group-empty"
    >
      {{ t('nav.refEmpty') }}
    </p>
  </SidebarGroup>
</template>

<style scoped>
.ref-search {
  height: 30px;
  padding: 0 10px;
  margin: 2px 4px 4px;
  font-family: var(--app-font);
  font-size: 12px;
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 42%, var(--app-panel));
  border: 1px solid color-mix(in srgb, var(--app-border) 54%, transparent);
  border-radius: var(--app-radius-lg);
  outline: none;
}
.ref-search::placeholder { color: var(--app-muted); }
.ref-search:focus {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
}
.ref-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 5px 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-text);
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.ref-item:hover {
  background: color-mix(in srgb, var(--app-accent-soft) 70%, var(--app-elevated));
}
.ref-key {
  font-size: 11px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.ref-title {
  font-size: 11px;
  color: color-mix(in srgb, var(--app-text) 80%, var(--app-muted));
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ref-meta {
  font-size: 10px;
  color: var(--app-muted);
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.group-empty {
  margin: 0;
  padding: 6px 8px;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--app-muted);
}
</style>
