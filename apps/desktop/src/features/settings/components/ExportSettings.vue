<script setup lang="ts">
/**
 * The Export section: the two export buttons and the defaults they use.
 *
 * It emits `export-html` / `export-pdf` and nothing else happens here (§10.3-C):
 * the export implementation belongs to `features/export/services`, so this file
 * must not grow a second copy of it. The defaults are `v-model`, so writing one
 * reaches the store through the panel that owns `useExportSettings`.
 */
import { computed } from 'vue'
import SelectMenu, { type SelectOption } from '../../../components/SelectMenu.vue'
import { t } from '../../../i18n'
// Type-only, so the two dropdowns are bound to the same unions the store holds.
import type { ExportPdfOrientation, ExportPdfPageSize } from '../../../stores/settings'

defineProps<{
  /** Whether a note is open for the two buttons to act on. */
  hasActiveTab: boolean
}>()

// The bindings are assigned, not left as bare calls: `defineModel` registers the
// model *name* as a props binding, so a bare `defineModel('frontmatter')` makes
// the template compile `frontmatter = $event` into a write to `$props.frontmatter`
// — a props mutation Vue refuses in dev and drops in production, which left the
// checkbox flipping nowhere. Named, the compiler binds the model ref and the
// write becomes `frontmatter.value = $event`, which emits `update:frontmatter`.
const frontmatter = defineModel<boolean>('frontmatter', { required: true })
const pageSize = defineModel<ExportPdfPageSize>('pageSize', { required: true })
const orientation = defineModel<ExportPdfOrientation>('orientation', { required: true })

const emit = defineEmits<{
  (e: 'export-html'): void
  (e: 'export-pdf'): void
}>()

const pageSizeChoices = computed<SelectOption[]>(() => [
  { value: 'A4', label: t('settings.export.pageSizeA4') },
  { value: 'Letter', label: t('settings.export.pageSizeLetter') },
])
const orientationChoices = computed<SelectOption[]>(() => [
  { value: 'portrait', label: t('settings.export.portrait') },
  { value: 'landscape', label: t('settings.export.landscape') },
])
</script>

<template>
  <section class="settings-section">
    <span class="settings-label">{{ t('settings.export.current') }}</span>
    <div class="view-modes">
      <button
        class="btn btn-secondary btn-sm"
        :disabled="!hasActiveTab"
        @click="emit('export-html')"
      >
        {{ t('settings.export.html') }}
      </button>
      <button
        class="btn btn-secondary btn-sm"
        :disabled="!hasActiveTab"
        @click="emit('export-pdf')"
      >
        {{ t('settings.export.pdf') }}
      </button>
    </div>
    <span
      v-if="!hasActiveTab"
      class="settings-note"
    >{{ t('settings.export.none') }}</span>
    <span class="settings-label">{{ t('settings.export.defaults') }}</span>
    <label class="settings-field settings-toggle">
      <span>{{ t('settings.export.frontmatter') }}</span>
      <input
        :checked="frontmatter"
        type="checkbox"
        class="checkbox"
        @change="frontmatter = ($event.target as HTMLInputElement).checked"
      >
    </label>
    <label
      class="settings-field"
      for="settings-export-page-size"
    >
      <span>{{ t('settings.export.pageSize') }}</span>
      <SelectMenu
        id="settings-export-page-size"
        class="input"
        :model-value="pageSize"
        :options="pageSizeChoices"
        @update:model-value="pageSize = $event as ExportPdfPageSize"
      />
    </label>
    <label
      class="settings-field"
      for="settings-export-orientation"
    >
      <span>{{ t('settings.export.orientation') }}</span>
      <SelectMenu
        id="settings-export-orientation"
        class="input"
        :model-value="orientation"
        :options="orientationChoices"
        @update:model-value="orientation = $event as ExportPdfOrientation"
      />
    </label>
  </section>
</template>

<style scoped>
/* `.settings-section`, `.settings-field`, `.settings-note`, `.settings-label`,
   `.settings-toggle`, `.checkbox` and `.view-modes` are restated in the
   sections that render them: a scoped block belongs to the component that
   renders the element, and the classes are too small to belong in the shared
   stylesheet. */
.settings-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.settings-field > span { color: var(--app-muted); font-size: 11px; }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.settings-label {
  margin-top: 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}
.settings-section .settings-label:first-child { margin-top: 0; }
.settings-toggle {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
.settings-toggle > span { color: var(--app-text); font-size: 12px; }
.checkbox {
  width: 16px;
  height: 16px;
  accent-color: var(--app-accent);
  cursor: pointer;
}
.view-modes { display: flex; gap: 6px; flex-wrap: wrap; }
.view-modes button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
