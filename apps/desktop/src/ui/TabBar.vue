<script setup lang="ts">
import { computed, markRaw, ref } from 'vue'
import { Plus, Trash2, X, XSquare } from 'lucide-vue-next'
import { useTabsStore } from '../stores/tabs'
import ContextMenu from './ContextMenu.vue'
import type { ContextMenuItem } from './ContextMenu.vue'
import { t } from '../i18n'
import { baseName as baseNameOf } from '../services/paths'

const tabs = useTabsStore()

const tabBarEl = ref<HTMLElement | null>(null)
const menu = ref<{ x: number; y: number; tabId: string } | null>(null)

const menuItems = computed<ContextMenuItem[]>(() => [
  { id: 'close', label: t('tabs.close'), icon: markRaw(X) },
  { id: 'close-others', label: t('tabs.closeOthers'), icon: markRaw(XSquare), separator: true },
  { id: 'close-all', label: t('tabs.closeAll'), icon: markRaw(Trash2) },
])

function baseName(path: string | null): string {
  if (!path) return t('tabs.untitled')
  // Separator-agnostic: on Windows the tab path is `\\?\C:\...\note.md`,
  // so a `split('/')` returned the entire absolute path as the label.
  return baseNameOf(path)
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

function tabEls(): HTMLElement[] {
  const el = tabBarEl.value
  if (!el) return []
  return [...el.querySelectorAll<HTMLElement>('[data-tab-id]')]
}

/** Roving tabindex: only the active tab is reachable via Tab. */
function tabindexOf(id: string): number {
  return id === tabs.activeId ? 0 : -1
}

function onTabKeydown(e: KeyboardEvent, id: string): void {
  if (e.target !== e.currentTarget) return
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    tabs.setActive(id)
    return
  }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  const list = tabEls()
  const idx = list.findIndex((el) => el.getAttribute('data-tab-id') === id)
  if (idx < 0 || list.length === 0) return
  const offset = e.key === 'ArrowRight' ? 1 : -1
  const next = list[(idx + offset + list.length) % list.length]
  const nextId = next?.getAttribute('data-tab-id')
  if (nextId) {
    tabs.setActive(nextId)
    next?.focus()
  }
}

async function onMenuSelect(id: string): Promise<void> {
  const target = menu.value
  if (!target) return
  if (id === 'close') await tabs.closeTab(target.tabId)
  else if (id === 'close-others') await tabs.closeOthers(target.tabId)
  else if (id === 'close-all') void tabs.closeAll()
}
</script>

<template>
  <div
    ref="tabBarEl"
    class="tab-bar"
    role="tablist"
    :aria-label="t('tabs.aria')"
  >
    <div
      v-for="tab in tabs.tabs"
      :key="tab.id"
      class="tab"
      :class="{ active: tab.id === tabs.activeId }"
      role="tab"
      :aria-selected="tab.id === tabs.activeId"
      :tabindex="tabindexOf(tab.id)"
      :data-tab-id="tab.id"
      @click="tabs.setActive(tab.id)"
      @keydown="onTabKeydown($event, tab.id)"
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
        :aria-label="t('tabs.closeTab')"
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
      :aria-label="t('tabs.newDoc')"
      @click="tabs.openTab(null)"
    >
      <Plus
        :size="14"
        :stroke-width="1.8"
      />
    </button>
    <!-- The exit. A context menu is mounted with `v-if` in every host, so its
         own leave rule never ran and it was gone in the frame the user acted;
         `<Transition>` keeps the node mounted for that rule and nothing else
         changes. See `ui/ContextMenu.vue` for the selectors that had to
         out-specify its own `.is-open`. -->
    <Transition name="ctx">
      <ContextMenu
        v-if="menu"
        :x="menu.x"
        :y="menu.y"
        :items="menuItems"
        @select="onMenuSelect"
        @close="menu = null"
      />
    </Transition>
  </div>
</template>

<style scoped>
.tab-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  /* The bar shares the toolbar rung with the rail header rather than taking its
     height from whatever 28px tab plus padding happened to add up to. Min, not
     a fixed height: the strip scrolls sideways, and a scrollbar inside a fixed
     box would clip the tabs it exists to reveal. */
  min-height: var(--app-toolbar-height);
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
              box-shadow var(--app-motion-fast) var(--app-ease);
}
.tab:hover {
  background: color-mix(in srgb, var(--app-elevated) 54%, transparent);
  color: var(--app-text);
}
.tab.active {
  background: color-mix(in srgb, var(--app-accent-soft) 72%, var(--app-elevated));
  /* One ring, drawn inside the border box. Pairing a `border-color` with this
     painted the same 1px line twice, so the active tab wore a 2px edge where
     every other selected row wears 1px; 9% is the strength those rows use. */
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-accent) 9%, transparent);
  color: var(--app-text);
  font-weight: 600;
}
.tab-name { white-space: nowrap; }
/* No `.save-dot[data-state='saved']` rule here on purpose: the shared recipe in
   components.css already states the meaning (muted, and hidden until something
   asks to show it). Repainting "saved" green and forcing it visible — which is
   what this block used to do — made the same document read "green dot" in its
   tab and "no dot" in the status bar, so the dot stopped meaning anything. */
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
  border-radius: var(--app-radius-sm);
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
