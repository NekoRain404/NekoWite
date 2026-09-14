<script setup lang="ts">
import { computed } from 'vue'
import { useViewStore } from '../stores/view'
import type { ViewMode } from '../stores/view'
import { t } from '../i18n'

const view = useViewStore()

interface ModeItem {
  key: ViewMode
  label: string
}

const modes = computed<ModeItem[]>(() => [
  { key: 'source', label: t('viewswitch.source') },
  { key: 'rendered', label: t('viewswitch.rendered') },
  { key: 'split', label: t('viewswitch.split') },
])
</script>

<template>
  <!-- `data-view-switch` marks the control that hands the keyboard to the pane
       it opens (the pane handoff looks for it by this hook): the click leaves
       the focus on the button, so without that the first keystrokes after a
       mode switch go nowhere. -->
  <div
    class="view-switch"
    data-view-switch
    role="tablist"
    :aria-label="t('viewswitch.aria')"
  >
    <button
      v-for="m in modes"
      :key="m.key"
      class="switch-option"
      :class="{ 'is-active': view.mode === m.key }"
      role="tab"
      :aria-selected="view.mode === m.key"
      :title="m.label"
      @click="view.setMode(m.key)"
    >
      {{ m.label }}
    </button>
  </div>
</template>

<style scoped>
.view-switch {
  display: flex;
  gap: 2px;
  padding: 1px;
  border: 1px solid color-mix(in srgb, var(--app-border) 88%, transparent);
  border-radius: var(--app-radius);
  background: color-mix(in srgb, var(--app-panel) 74%, transparent);
}
.switch-option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 18px;
  padding: 0 8px;
  font-family: var(--app-font);
  font-size: 11px;
  font-weight: 550;
  letter-spacing: -0.01em;
  line-height: 1;
  white-space: nowrap;
  color: var(--app-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--app-radius-sm);
  cursor: pointer;
  /* `transform` is in this list for the shared press movement (motion.css scales
     every `.switch-option` under the pointer): a control that scales without a
     transform in its own transition list snaps to the pressed size and snaps
     back, which is the one press in the app that read as a glitch rather than as
     a press. */
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease),
              border-color var(--app-motion-fast) var(--app-ease),
              box-shadow var(--app-motion-fast) var(--app-ease),
              transform var(--app-motion-fast) var(--app-ease);
}
.switch-option:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.switch-option.is-active {
  background: var(--app-elevated);
  color: var(--app-text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgb(35 33 29 / 10%),
              inset 0 0 0 1px rgb(255 255 255 / 40%);
}
[data-theme="dark"] .switch-option.is-active {
  box-shadow: 0 1px 2px rgb(0 0 0 / 30%),
              inset 0 0 0 1px rgb(255 255 255 / 5%);
}
</style>
