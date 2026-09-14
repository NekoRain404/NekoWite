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
import { Calendar, FolderOpen, Hash, LayoutTemplate, Tag as TagIcon, X } from 'lucide-vue-next'
import { useSidebarNavigation } from '../composables/use-sidebar-navigation'
import { useSidebarTags } from '../composables/use-sidebar-tags'
import { t } from '../../../i18n'

defineProps<{
  vaultName: string
}>()

const emit = defineEmits<{
  openFolder: [path: string]
  newDaily: []
  pickTemplate: []
}>()

const { navEntries, pickVaultFolder } = useSidebarNavigation()
const { tagCounts, activeTag, selectTag, activeDocTags, removeCurrentTag } = useSidebarTags()

async function pickFolder(): Promise<void> {
  const picked = await pickVaultFolder()
  if (picked) emit('openFolder', picked)
}
</script>

<template>
  <button
    class="nav-item vault-item"
    :title="t('nav.openOther')"
    @click="pickFolder"
  >
    <FolderOpen
      class="nav-icon"
      :size="16"
      :stroke-width="1.8"
    />
    <span class="nav-label">{{ vaultName }}</span>
    <FolderOpen
      class="nav-hint"
      :size="13"
      :stroke-width="1.8"
    />
  </button>

  <div class="quick-actions">
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
      <span class="nav-label">{{ t('daily.new') }}</span>
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
      <span class="nav-label">{{ t('template.pickTitle') }}</span>
    </button>
  </div>

  <nav class="nav-group">
    <button
      v-for="entry in navEntries"
      :key="entry.id"
      class="nav-item"
      :class="{ active: entry.active }"
      :aria-current="entry.active ? 'page' : undefined"
      @click="entry.onClick"
    >
      <component
        :is="entry.icon"
        class="nav-icon"
        :size="16"
        :stroke-width="1.8"
      />
      <span class="nav-label">{{ entry.label }}</span>
      <span
        v-if="typeof entry.count === 'number'"
        class="nav-count"
      >{{ entry.count }}</span>
    </button>
  </nav>

  <section
    v-if="tagCounts.length"
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
}
.nav-count {
  font-size: 10px;
  font-weight: 400;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
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
