<script setup lang="ts">
/**
 * One collapsible sidebar group: the header button, its chevron, the count and
 * the body that exists only while the group is open.
 *
 * References and trash are the same chrome around different content, so the
 * chrome lives here once instead of twice (§13.11). `open` is a prop rather
 * than local state because the sidebar owns which groups are expanded — it is
 * the one that collapses them when the vault changes — and the body arrives as
 * a slot, so this component renders nothing of what it opens.
 */
import { ChevronDown, ChevronRight } from 'lucide-vue-next'

defineProps<{
  title: string
  count?: number
  open: boolean
}>()

defineEmits<{
  toggle: []
}>()
</script>

<template>
  <section class="sidebar-section">
    <button
      class="group-header"
      @click="$emit('toggle')"
    >
      <ChevronDown
        v-if="open"
        class="group-caret"
        :size="12"
        :stroke-width="1.8"
      />
      <ChevronRight
        v-else
        class="group-caret"
        :size="12"
        :stroke-width="1.8"
      />
      <span class="group-title">{{ title }}</span>
      <span
        v-if="count"
        class="group-count"
      >{{ count }}</span>
    </button>
    <div
      v-if="open"
      class="group-body"
    >
      <slot />
    </div>
  </section>
</template>

<style scoped>
.sidebar-section {
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 44%, transparent);
}

.group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.group-header:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 54%, transparent);
}
.group-caret { flex: none; }
.group-title { flex: 1; text-align: left; }
.group-count {
  font-size: 10px;
  font-weight: 400;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
}
.group-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 2px 2px 4px;
}
</style>
