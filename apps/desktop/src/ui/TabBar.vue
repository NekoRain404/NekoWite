<script setup lang="ts">
import { computed, markRaw, ref } from 'vue'
import { Plus, Trash2, X, XSquare } from 'lucide-vue-next'
import { useTabsStore } from '../stores/tabs'
import ContextMenu from './ContextMenu.vue'
import type { ContextMenuItem } from './ContextMenu.vue'
import { t } from '../i18n'

const tabs = useTabsStore()

const menu = ref<{ x: number; y: number; tabId: string } | null>(null)

const menuItems = computed<ContextMenuItem[]>(() => [
  { id: 'close', label: t('tabs.close'), icon: markRaw(X) },
  { id: 'close-others', label: t('tabs.closeOthers'), icon: markRaw(XSquare), separator: true },
  { id: 'close-all', label: t('tabs.closeAll'), icon: markRaw(Trash2) },
])

function baseName(path: string | null): string {
  if (!path) return t('tabs.untitled')
  return path.split('/').pop() ?? path
}

function dotTitle(id: string): string {
  const state = tabs.saveStateOf(id)
  if (state === 'saving') return t('tabs.saving')
  if (state === 'dirty') return t('tabs.dirty')
  return t('tabs.saved')
}

function onTabMouseDown(e: MouseEvent): void {
  if (e.button === 1) e.preventDefault()
}

function onTabAuxClick(e: MouseEvent, id: string): void {
  if (e.button !== 1) return
  e.preventDefault()
  void tabs.closeTab(id)
}

async function onMenuSelect(id: string): Promise<void> {
  const target = menu.value
  if (!target) return
  if (id === 'close') await tabs.closeTab(target.tabId)
  else if (id === 'close-others') await tabs.closeOthers(target.tabId)
  else if (id === 'close-all') tabs.closeAll()
}
</script>

<template>
  <div class="tab-bar">
    <div
      v-for="tab in tabs.tabs"
      :key="tab.id"
      class="tab"
      :class="{ active: tab.id === tabs.activeId }"
      @click="tabs.setActive(tab.id)"
      @mousedown="onTabMouseDown($event)"
      @auxclick="onTabAuxClick($event, tab.id)"
      @contextmenu.prevent="menu = { x: $event.clientX, y: $event.clientY, tabId: tab.id }"
    >
      <span
        class="save-dot"
        :data-state="tabs.saveStateOf(tab.id)"
        :title="dotTitle(tab.id)"
      />
      <span class="tab-name">{{ baseName(tab.path) }}</span>
      <button
        class="tab-close"
        :title="t('tabs.closeTab')"
        @click.stop="tabs.closeTab(tab.id)"
      >
        <X
          :size="12"
          :stroke-width="1.8"
        />
      </button>
    </div>
    <button
      class="new-tab"
      :title="t('tabs.newDoc')"
      @click="tabs.openTab(null)"
    >
      <Plus
        :size="14"
        :stroke-width="1.8"
      />
    </button>
    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menuItems"
      @select="onMenuSelect"
      @close="menu = null"
    />
  </div>
</template>

<style scoped>
.tab-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel) 55%, var(--app-canvas));
  overflow-x: auto;
  user-select: none;
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 28px;
  padding: 0 8px 0 10px;
  border: 1px solid transparent;
  border-radius: var(--app-radius);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  background: transparent;
  color: color-mix(in srgb, var(--app-text) 72%, var(--app-muted));
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease),
              border-color var(--app-motion-fast) var(--app-ease),
              box-shadow var(--app-motion-fast) var(--app-ease);
}
.tab:hover {
  background: color-mix(in srgb, var(--app-elevated) 54%, transparent);
  color: var(--app-text);
}
.tab.active {
  background: color-mix(in srgb, var(--app-accent-soft) 72%, var(--app-elevated));
  border-color: color-mix(in srgb, var(--app-accent) 8%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-accent) 8%, transparent);
  color: var(--app-text);
  font-weight: 600;
}
.tab-name { white-space: nowrap; }
.save-dot[data-state='saved'] {
  background: var(--app-success);
  opacity: 0.75;
}
.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--app-muted);
  padding: 0;
  border-radius: 4px;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.tab-close:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-panel) 70%, transparent);
}
.new-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: none;
  margin-left: 2px;
  border: none;
  background: transparent;
  border-radius: var(--app-radius-sm);
  cursor: pointer;
  color: var(--app-muted);
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.new-tab:hover {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
  color: var(--app-text);
}
</style>
