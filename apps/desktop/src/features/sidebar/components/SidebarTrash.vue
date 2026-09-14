<script setup lang="ts">
/**
 * The trash group: what a vault is holding, with a restore per entry and the
 * two-step clear.
 *
 * A section renders and forwards (§13.3): the entries, the armed clear and all
 * four commands come from `composables/useSidebarTrash`, which is also where
 * the vault-switch reset lives. The group's chrome comes from `SidebarGroup` —
 * the body it wraps is this component's, so the styles below are this
 * component's too.
 *
 * The one thing this component owns is when to read: the list is fetched as the
 * group opens, never before, so a trash that is closed costs nothing.
 */
import { watch } from 'vue'
import { RotateCcw, Trash2 } from 'lucide-vue-next'
import SidebarGroup from './SidebarGroup.vue'
import { useSidebarTrash } from '../composables/use-sidebar-trash'
import { t } from '../../../i18n'

const props = defineProps<{
  vault: string
}>()

const open = defineModel<boolean>('open', { required: true })

const {
  trashEntries,
  trashUnreadable,
  clearingTrash,
  refreshTrash,
  restore,
  trashLabel,
  clearTrash,
} = useSidebarTrash({ vault: () => props.vault })

watch(open, (isOpen) => {
  if (isOpen) void refreshTrash()
})
</script>

<template>
  <SidebarGroup
    :title="t('nav.trash')"
    :count="trashEntries.length"
    :open="open"
    @toggle="open = !open"
  >
    <button
      v-if="trashEntries.length"
      class="trash-clear"
      :class="{ armed: clearingTrash }"
      @click="clearTrash"
    >
      <Trash2
        :size="12"
        :stroke-width="1.8"
      />
      <span>{{ clearingTrash ? t('trash.clearConfirm') : t('trash.clear') }}</span>
    </button>
    <div
      v-for="entry in trashEntries"
      :key="entry.trash_path"
      class="trash-item"
    >
      <span
        class="trash-name"
        :title="entry.original_path || entry.name"
      >{{ trashLabel(entry) }}</span>
      <button
        class="trash-restore"
        :title="t('nav.restore')"
        @click="restore(entry)"
      >
        <RotateCcw
          :size="12"
          :stroke-width="1.8"
        />
      </button>
    </div>
    <p
      v-if="trashEntries.length === 0"
      class="group-empty"
    >
      {{ trashUnreadable ? t('nav.trashUnreadable') : t('nav.trashEmpty') }}
    </p>
  </SidebarGroup>
</template>

<style scoped>
.trash-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: var(--app-radius-sm);
  transition: background var(--app-motion-fast) var(--app-ease);
}
.trash-item:hover {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.trash-name {
  flex: 1;
  font-size: 11px;
  color: color-mix(in srgb, var(--app-text) 76%, var(--app-muted));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.trash-restore {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.trash-restore:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-panel) 72%, transparent);
}
.trash-clear {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  margin: 0 2px 3px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 10.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.trash-clear:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.trash-clear.armed {
  color: var(--app-danger);
  background: color-mix(in srgb, var(--app-danger) 10%, transparent);
}
.group-empty {
  margin: 0;
  padding: 6px 8px;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--app-muted);
}
</style>
