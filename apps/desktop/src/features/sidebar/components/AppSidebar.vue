<script setup lang="ts">
/**
 * The sidebar: the vault's navigation column.
 *
 * Orchestration only (§13.3). What is left here is the shell — the scrolling
 * column, the footer, and the template picker, which mounts as a sibling of the
 * column rather than inside any one section — plus the two things the shell is
 * the only one able to own: which sections are expanded, since it is the
 * component that hears about a vault change, and the daily-note and template
 * commands, because the picker they open is mounted here. Each section reads
 * its own state through `composables/*`, so this file holds no store reads at
 * all (§10.2).
 */
import { computed, ref, watch } from 'vue'
import { Library, Moon, Settings, Sun } from 'lucide-vue-next'
import SidebarNavigation from './SidebarNavigation.vue'
import SidebarReferences from './SidebarReferences.vue'
import SidebarTrash from './SidebarTrash.vue'
import TemplatePicker from '../../../ui/TemplatePicker.vue'
import { useSidebarTemplates } from '../composables/use-sidebar-templates'
import { useSidebarTheme } from '../composables/use-sidebar-theme'
import { baseName } from '../../../services/paths'
import { t } from '../../../i18n'

const props = defineProps<{ vault: string }>()
const emit = defineEmits<{
  openFolder: [path: string]
  openSettings: []
}>()

const { theme, toggleTheme } = useSidebarTheme()

const {
  templatePickerOpen,
  templateTemplates,
  createDailyNote,
  openTemplatePicker,
  closeTemplatePicker,
  createFromTemplate,
} = useSidebarTemplates({ vault: () => props.vault })

const refsOpen = ref(false)
const trashOpen = ref(false)

const vaultName = computed(() => {
  // Windows vault paths end with a backslash-separated folder name, so a
  // `/`-split returned the whole path.
  return baseName(props.vault) || props.vault
})

// Both groups collapse on a vault change: an expanded group would otherwise be
// showing one vault's references while the column already navigates another.
watch(
  () => props.vault,
  () => {
    refsOpen.value = false
    trashOpen.value = false
  },
)
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-scroll">
      <SidebarNavigation
        :vault-name="vaultName"
        @open-folder="(path: string) => emit('openFolder', path)"
        @new-daily="createDailyNote"
        @pick-template="openTemplatePicker"
      />
      <SidebarReferences v-model:open="refsOpen" />
      <SidebarTrash
        v-model:open="trashOpen"
        :vault="props.vault"
      />
    </div>

    <div class="sidebar-footer">
      <span
        class="footer-vault"
        :title="props.vault"
      >
        <Library
          :size="12"
          :stroke-width="1.8"
        />
        {{ vaultName }}
      </span>
      <span class="footer-spacer" />
      <button
        class="footer-btn"
        :title="theme === 'dark' ? t('nav.switchLight') : t('nav.switchDark')"
        @click="toggleTheme"
      >
        <Sun
          v-if="theme === 'dark'"
          :size="15"
          :stroke-width="1.8"
        />
        <Moon
          v-else
          :size="15"
          :stroke-width="1.8"
        />
      </button>
      <button
        class="footer-btn"
        :title="t('nav.settings')"
        @click="emit('openSettings')"
      >
        <Settings
          :size="15"
          :stroke-width="1.8"
        />
      </button>
    </div>

    <!-- The shared dialog departure (see motion.css). It has to sit where the
         `v-if` is, so every host of a `.dialog` needs its own wrapper — this one
         is a child of the sidebar rather than of the shell. -->
    <Transition
      name="dialog"
      type="transition"
    >
      <TemplatePicker
        v-if="templatePickerOpen"
        :templates="templateTemplates"
        @select="createFromTemplate"
        @close="closeTemplatePicker"
      />
    </Transition>
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--app-sidebar-width);
  min-width: var(--app-sidebar-width);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--app-panel);
  border-right: 1px solid var(--app-border);
  overflow: hidden;
  user-select: none;
}
.sidebar-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 8px 12px;
  display: flex;
  flex-direction: column;
}

.sidebar-footer {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 72%, transparent);
  background: color-mix(in srgb, var(--app-panel) 92%, var(--app-elevated));
}
.footer-vault {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: 11px;
  font-weight: 550;
  letter-spacing: -0.01em;
  color: color-mix(in srgb, var(--app-text) 76%, var(--app-muted));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.footer-spacer { flex: 1; }
.footer-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: none;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.footer-btn:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
</style>
