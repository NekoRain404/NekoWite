<script setup lang="ts">
import { computed } from 'vue'
import { X } from 'lucide-vue-next'
import ReferencesPanel from './ReferencesPanel.vue'
import HistoryPanel from './HistoryPanel.vue'
import OutlinePanel from './OutlinePanel.vue'
import { ChatPanel } from '../features/chat'
import FrontmatterPanel from './FrontmatterPanel.vue'
import DocStatsPanel from './DocStatsPanel.vue'
import { t } from '../i18n'

const emit = defineEmits<{ (e: 'close'): void }>()

export type RailTab = 'ai' | 'outline' | 'refs' | 'history' | 'meta' | 'stats'

// The rail is mounted with `v-if="railOpen"`, so a ref of its own would not
// survive being closed: every reopen constructed a fresh `'ai'`, and a user who
// had been reading the outline was thrown back to the chat each time they took
// the width back. The tab belongs to whoever decides whether the rail is open,
// so it is a model rather than local state — and the close that unmounts the
// rail already stops any chat stream on the way out.
const activeTab = defineModel<RailTab>('tab', { default: 'ai' })

const TABS = computed(() => [
  { id: 'ai', label: t('rail.ai') },
  { id: 'outline', label: t('rail.outline') },
  { id: 'refs', label: t('rail.refs') },
  { id: 'history', label: t('rail.history') },
  { id: 'meta', label: t('rail.meta') },
  { id: 'stats', label: 'Stats' },
] as const)
</script>

<template>
  <aside class="info-rail">
    <div class="rail-header">
      <div
        class="rail-tabs"
        role="tablist"
        :aria-label="t('rail.bodyAria')"
      >
        <button
          v-for="tab in TABS"
          :key="tab.id"
          class="rail-tab"
          role="tab"
          :class="{ 'is-active': activeTab === tab.id }"
          :aria-selected="activeTab === tab.id"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>
      <button
        class="rail-close"
        :title="t('rail.close')"
        @click="emit('close')"
      >
        <X
          :size="14"
          :stroke-width="1.8"
        />
      </button>
    </div>
    <div class="rail-body">
      <!-- One `<Transition>` per section — a `<Transition>` takes a single
           child, and all six stay mounted — which is what gives the tab swap
           the same shape the sidebar has: the section arriving fades in place,
           and the one leaving fades out *still rendered* instead of being cut
           by `display: none` in the frame of the click. `v-show` and not
           `v-if`, unchanged: the display flip is what keeps the chat session
           and the loaded lists alive (see useSectionShown). -->
      <Transition name="rail-panel">
        <ChatPanel v-show="activeTab === 'ai'" />
      </Transition>
      <Transition name="rail-panel">
        <OutlinePanel v-show="activeTab === 'outline'" />
      </Transition>
      <Transition name="rail-panel">
        <ReferencesPanel v-show="activeTab === 'refs'" />
      </Transition>
      <Transition name="rail-panel">
        <HistoryPanel v-show="activeTab === 'history'" />
      </Transition>
      <Transition name="rail-panel">
        <FrontmatterPanel v-show="activeTab === 'meta'" />
      </Transition>
      <Transition name="rail-panel">
        <DocStatsPanel v-show="activeTab === 'stats'" />
      </Transition>
    </div>
  </aside>
</template>

<style scoped>
.info-rail {
  width: var(--app-rail-width);
  min-width: var(--app-rail-width);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--app-panel);
  border-left: 1px solid var(--app-border);
  overflow: hidden;
}
.rail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  /* The rail header sits at the top of the same row as the tab bar, so it takes
     the same rung instead of a height of its own — it stood 3px shorter than the
     bar beside it, which reads as a misalignment across the editor/rail seam. */
  height: var(--app-toolbar-height);
  flex: none;
  padding: 0 8px 0 8px;
  border-bottom: 1px solid var(--app-border);
  user-select: none;
}
.rail-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
.rail-tab {
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 12px;
  font-weight: 550;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.rail-tab:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.rail-tab.is-active {
  color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent-soft) 72%, var(--app-elevated));
}
.rail-tab:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.rail-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.rail-close:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.rail-body {
  /* The containing block for a section on its way out. */
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  /* Switching from a panel with a list to one without drops this body's
     scrollbar, and its 10px gutter (src/style.css) then comes out of the content
     box — so every panel shifted 10px sideways on a tab click, which is the half
     of the "jump" a fade cannot hide. Reserving the gutter keeps the column
     still. Engines without `scrollbar-gutter` keep today's behaviour. */
  scrollbar-gutter: stable;
}
/* The section swap — the sidebar's pattern one level down, because that is the
   one the user judged and asked for here. Opacity only: these are text panels,
   and a `scale` on a container re-rasterises every glyph inside it (which is
   what 文字发虚 was). Nothing here may touch the body's *height* either — the
   panels differ by hundreds of pixels, and animating a scroll container's
   height would thrash the scrollbar the rule above just stabilised.

   The section on its way out is taken out of flow, exactly as the sidebar is
   and for the same reason: the flex column must not hold two panels for the
   length of a fade, and it must not give up the outgoing one's height at the
   end of it either. It stays rendered to fade, and stops taking the pointer. */
.rail-panel-enter-active {
  transition: opacity var(--app-motion) var(--app-ease);
}
.rail-panel-leave-active {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  pointer-events: none;
  transition: opacity var(--app-motion-exit) var(--app-ease-exit);
}
.rail-panel-enter-from,
.rail-panel-leave-to {
  opacity: 0;
}
</style>
