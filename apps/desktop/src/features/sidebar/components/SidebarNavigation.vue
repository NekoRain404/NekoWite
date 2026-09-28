<script setup lang="ts">
/**
 * Everything the sidebar uses to move around the library: the vault it is
 * showing, the two new-note shortcuts, the view filters and the tags.
 *
 * A section renders and forwards (§13.3): the entries and the tag rows come
 * from their composables, and a click either runs one of those commands or
 * emits the shortcut the sidebar owns — the daily note and the template picker
 * both open a tab, and the picker itself is mounted by the sidebar, so its
 * state cannot be owned twice.
 *
 * The vault arrives as a name because that is all this section shows of it.
 */
import { markRaw, ref } from 'vue'
import { Calendar, FolderOpen, Hash, LayoutTemplate, PanelLeftClose, PanelLeftOpen, Server, Tag as TagIcon, X } from 'lucide-vue-next'
import ContextMenu from '../../../ui/ContextMenu.vue'
import { useSidebarNavigation } from '../composables/use-sidebar-navigation'
import { useSidebarTags } from '../composables/use-sidebar-tags'
import { t } from '../../../i18n'

defineProps<{
  vaultName: string
  compact: boolean
}>()

const emit = defineEmits<{
  openFolder: [path: string]
  newDaily: []
  pickTemplate: []
  addRemote: []
  toggleCompact: []
}>()

const vaultMenu = ref<{ x: number; y: number } | null>(null)
const vaultMenuItems = [{ id: 'remote', label: t('remote.add'), icon: markRaw(Server) }]

const { navEntries, pickVaultFolder } = useSidebarNavigation()
const { tagCounts, activeTag, selectTag, activeDocTags, removeCurrentTag } = useSidebarTags()

async function pickFolder(): Promise<void> {
  const picked = await pickVaultFolder()
  if (picked) emit('openFolder', picked)
}
</script>

<template>
  <div
    class="vault-row"
    :class="{ compact }"
  >
    <button
      class="nav-item vault-item"
      :title="t('nav.openOther')"
      :aria-label="compact ? t('nav.openOther') : undefined"
      @click="pickFolder"
      @contextmenu.prevent="vaultMenu = { x: $event.clientX, y: $event.clientY }"
    >
      <FolderOpen
        class="nav-icon"
        :size="16"
        :stroke-width="1.8"
      />
      <span
        class="nav-label"
        :aria-hidden="compact"
      >{{ vaultName }}</span>
    </button>
    <button
      class="drawer-toggle"
      type="button"
      data-test="sidebar-drawer-toggle"
      :title="t(compact ? 'nav.expandDrawer' : 'nav.collapseDrawer')"
      :aria-label="t(compact ? 'nav.expandDrawer' : 'nav.collapseDrawer')"
      :aria-expanded="!compact"
      @click="emit('toggleCompact')"
    >
      <PanelLeftOpen
        v-if="compact"
        :size="16"
        :stroke-width="1.8"
      />
      <PanelLeftClose
        v-else
        :size="16"
        :stroke-width="1.8"
      />
    </button>
  </div>
  <Transition name="ctx">
    <ContextMenu
      v-if="vaultMenu"
      :x="vaultMenu.x"
      :y="vaultMenu.y"
      :items="vaultMenuItems"
      @select="vaultMenu = null; emit('addRemote')"
      @close="vaultMenu = null"
    />
  </Transition>

  <div
    class="quick-actions"
    :class="{ compact }"
  >
    <button
      class="nav-item quick-action"
      :title="t('daily.new')"
      @click="emit('newDaily')"
    >
      <Calendar
        class="nav-icon"
        :size="16"
        :stroke-width="1.8"
      />
      <span
        class="nav-label"
        :aria-hidden="compact"
      >{{ t('daily.new') }}</span>
    </button>
    <button
      class="nav-item quick-action"
      :title="t('template.pickTitle')"
      @click="emit('pickTemplate')"
    >
      <LayoutTemplate
        class="nav-icon"
        :size="16"
        :stroke-width="1.8"
      />
      <span
        class="nav-label"
        :aria-hidden="compact"
      >{{ t('template.pickTitle') }}</span>
    </button>
  </div>

  <nav
    class="nav-group"
    :class="{ compact }"
  >
    <button
      v-for="entry in navEntries"
      :key="entry.id"
      class="nav-item"
      :class="{ active: entry.active }"
      :aria-current="entry.active ? 'page' : undefined"
      :title="compact ? entry.label : undefined"
      :aria-label="compact ? entry.label : undefined"
      @click="entry.onClick"
    >
      <component
        :is="entry.icon"
        class="nav-icon"
        :size="16"
        :stroke-width="1.8"
      />
      <span
        class="nav-label"
        :aria-hidden="compact"
      >{{ entry.label }}</span>
      <span
        v-if="typeof entry.count === 'number'"
        class="nav-count"
        :aria-hidden="compact"
      >{{ entry.count }}</span>
    </button>
  </nav>

  <section
    v-if="!compact && tagCounts.length"
    class="sidebar-section"
  >
    <div class="section-title">
      <TagIcon
        :size="12"
        :stroke-width="1.8"
      />
      <span>{{ t('nav.tags') }}</span>
    </div>
    <div class="tag-list">
      <div
        v-for="tc in tagCounts"
        :key="tc.tag"
        class="tag-row"
      >
        <button
          class="nav-item tag-item"
          :class="{ active: activeTag === tc.tag }"
          :title="t('nav.noteCount', { n: tc.count })"
          @click="selectTag(tc.tag)"
        >
          <Hash
            class="nav-icon"
            :size="16"
            :stroke-width="1.8"
          />
          <span class="nav-label">{{ tc.tag }}</span>
          <span class="nav-count">{{ tc.count }}</span>
        </button>
        <button
          v-if="activeDocTags.has(tc.tag)"
          class="tag-remove"
          :title="t('tag.removeFromDoc')"
          @click="removeCurrentTag(tc.tag, $event)"
        >
          <X
            :size="11"
            :stroke-width="2"
          />
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.vault-row { position: relative; height: 34px; flex: none; min-width: 0; transition: height var(--app-motion) var(--app-ease); }
.vault-row .vault-item { position: absolute; top: 0; left: 0; width: calc(100% - 30px); min-width: 0; transition: top var(--app-motion) var(--app-ease), width var(--app-motion) var(--app-ease); }
.drawer-toggle { position: absolute; top: 2px; right: 0; display: grid; place-items: center; width: 28px; height: 30px; padding: 0; border: 0; border-radius: var(--app-radius-sm); background: transparent; color: var(--app-muted); cursor: pointer; }
.drawer-toggle:hover { color: var(--app-text); background: var(--app-elevated); }
.drawer-toggle:focus-visible { outline: 2px solid var(--app-accent); outline-offset: 1px; }
.vault-row.compact { height: 68px; }
.vault-row.compact .vault-item { top: 34px; width: 100%; }
.nav-group.compact .nav-item, .quick-actions.compact .nav-item, .vault-row.compact .vault-item { display: flex; justify-content: center; padding: 0; }
.compact .nav-label, .compact .nav-count { position: absolute; opacity: 0; pointer-events: none; }
.compact .nav-label { left: 34px; }
.compact .nav-count { right: 10px; }
.nav-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-top: 6px;
}

.quick-actions {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-top: 8px;
  padding-bottom: 2px;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 44%, transparent);
}
.quick-action {
  height: 30px;
  font-size: 11.5px;
}

.nav-item {
  position: relative;
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: none;
  border-radius: var(--app-radius-lg);
  background: transparent;
  color: color-mix(in srgb, var(--app-text) 72%, var(--app-muted));
  font-family: var(--app-font);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease),
              box-shadow var(--app-motion-fast) var(--app-ease);
}
.nav-item:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 62%, transparent);
}
.nav-item:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.nav-item.active {
  background: color-mix(in srgb, var(--app-accent-soft) 76%, var(--app-panel));
  color: var(--app-text);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-accent) 9%, transparent);
}
.nav-item.active .nav-icon {
  color: var(--app-accent);
}
.nav-icon {
  color: color-mix(in srgb, var(--app-accent) 82%, var(--app-text));
}
.nav-hint {
  opacity: 0;
  color: var(--app-muted);
  transition: opacity var(--app-motion-fast) var(--app-ease);
}
.nav-item:hover .nav-hint { opacity: 1; }
.nav-label {
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: opacity var(--app-motion-fast) var(--app-ease);
}
.nav-count {
  font-size: 10px;
  font-weight: 400;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
  transition: opacity var(--app-motion-fast) var(--app-ease);
}
.nav-item.active .nav-count {
  color: color-mix(in srgb, var(--app-text) 54%, var(--app-muted));
}

.sidebar-section {
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 44%, transparent);
}
.section-title {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}

.tag-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 2px 0 4px;
}
.tag-row {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 34px;
}
.tag-row .tag-item {
  flex: 1;
  min-width: 0;
}
.tag-remove {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--app-radius-xs);
  background: color-mix(in srgb, var(--app-elevated) 82%, var(--app-panel));
  color: var(--app-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--app-motion-fast) var(--app-ease),
              background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.tag-row:hover .tag-remove {
  opacity: 1;
}
.tag-remove:hover {
  color: var(--app-danger);
  background: color-mix(in srgb, var(--app-danger) 14%, transparent);
}
.tag-remove:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.tag-item .nav-label::before {
  content: '#';
  margin-right: 1px;
  color: color-mix(in srgb, var(--app-accent) 70%, var(--app-muted));
}
</style>
