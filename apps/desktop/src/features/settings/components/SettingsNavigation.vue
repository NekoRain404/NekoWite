<script setup lang="ts">
/**
 * The settings dialog's left rail: the section list, and which one is open.
 *
 * It owns the table of sections because it renders them — the icons live here,
 * so the panel that switches between the sections stays free of them. The
 * selected id is the one two-way value: the panel holds it, this displays it.
 */
import { computed } from 'vue'
import { Bot, Download, Palette, SlidersHorizontal, Sparkles, Type, Puzzle } from 'lucide-vue-next'
import { t } from '../../../i18n'
import type { SettingsSectionId } from '../types'

const activeSection = defineModel<SettingsSectionId>('activeSection', { required: true })

const SECTIONS = computed<Array<{ id: SettingsSectionId; label: string; icon: typeof Type }>>(() => [
  { id: 'general', label: t('settings.section.general'), icon: SlidersHorizontal },
  { id: 'appearance', label: t('settings.section.appearance'), icon: Palette },
  { id: 'editor', label: t('settings.section.editor'), icon: Type },
  { id: 'export', label: t('settings.section.export'), icon: Download },
  { id: 'ai', label: t('settings.section.ai'), icon: Sparkles },
  { id: 'plugins', label: t('settings.section.plugins'), icon: Puzzle },
  // Last, and after the app's own sections rather than beside the AI one: this
  // tree configures an engine that runs *in* the editor, which makes it the
  // section a reader arrives at looking for it rather than passing through.
  { id: 'agents', label: t('settings.section.agents'), icon: Bot },
])
</script>

<template>
  <aside
    class="dialog-nav"
    role="tablist"
    :aria-label="t('settings.dialogTitle')"
  >
    <button
      v-for="s in SECTIONS"
      :key="s.id"
      class="nav-row"
      :class="{ active: activeSection === s.id }"
      role="tab"
      :aria-selected="activeSection === s.id"
      :aria-current="activeSection === s.id ? 'true' : undefined"
      @click="activeSection = s.id"
    >
      <component
        :is="s.icon"
        class="nav-row-icon"
        :size="15"
        :stroke-width="1.8"
      />
      <span>{{ s.label }}</span>
    </button>
  </aside>
</template>

<style scoped>
.dialog-nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 152px;
  flex: none;
  padding: 10px 8px;
  border-right: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
  overflow-y: auto;
  user-select: none;
}
.nav-row {
  display: grid;
  grid-template-columns: 15px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: none;
  border-radius: var(--app-radius-lg);
  background: transparent;
  color: color-mix(in srgb, var(--app-text) 72%, var(--app-muted));
  font-family: var(--app-font);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.nav-row:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-panel) 62%, transparent);
}
.nav-row:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.nav-row.active {
  background: color-mix(in srgb, var(--app-accent-soft) 76%, var(--app-elevated));
  color: var(--app-text);
  font-weight: 600;
}
.nav-row.active .nav-row-icon {
  color: var(--app-accent);
}
.nav-row-icon {
  color: color-mix(in srgb, var(--app-accent) 82%, var(--app-text));
}
</style>
