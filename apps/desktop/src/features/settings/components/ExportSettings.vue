<script setup lang="ts">
/**
 * The Export section: what to export as, how the page is set up, and a preview
 * of the result.
 *
 * It reads its own composable, the way the AI section's prompt shelf does, and
 * takes no props (§10.2): the panel that composes the sections is orchestration
 * and nothing else, and there is no reason for it to be holding six `v-model`s
 * and five event handlers on this section's behalf. `useExportSettings` owns
 * the store reads and the commands; `useExportPreview` owns the preview.
 */
import { computed } from 'vue'
import SelectMenu, { type SelectOption } from '../../../components/SelectMenu.vue'
import { t } from '../../../i18n'
import {
  EXPORT_MARGIN_MM_MAX,
  EXPORT_MARGIN_MM_MIN,
  EXPORT_PAGE_SIZES,
} from '../../../services/export-page'
import { EXPORT_JPEG_QUALITY_MAX, EXPORT_JPEG_QUALITY_MIN } from '../../../stores/settings'
import type {
  ExportImageFormat,
  ExportPdfOrientation,
  ExportPdfPageSize,
} from '../../../stores/settings'
import { useExportSettings } from '../composables/use-export-settings'
import ExportPreview from './ExportPreview.vue'

const {
  hasActiveTab,
  frontmatter,
  pageSize,
  orientation,
  marginMm,
  imageFormat,
  imageQuality,
  exportHtmlFile,
  exportPdfFile,
  exportImageFile,
  exportTextFile,
  exportCsvFile,
} = useExportSettings()

// The two dropdowns are bound to the same unions the store holds, and the paper
// list is the store's own closed list rather than a second copy of it — a size
// offered here that `@page` did not recognise would be a rule the print dialog
// silently ignores.
const pageSizeChoices = computed<SelectOption[]>(() =>
  EXPORT_PAGE_SIZES.map((size) => ({ value: size, label: t(`settings.export.pageSize${size}`) })),
)
const orientationChoices = computed<SelectOption[]>(() => [
  { value: 'portrait', label: t('settings.export.portrait') },
  { value: 'landscape', label: t('settings.export.landscape') },
])
const imageFormatChoices = computed<SelectOption[]>(() => [
  { value: 'png', label: t('settings.export.imageFormatPng') },
  { value: 'jpeg', label: t('settings.export.imageFormatJpeg') },
])

/** The quality control is a percentage; the encoder takes 0–1. */
const qualityPercent = computed({
  get: () => Math.round(imageQuality.value * 100),
  set: (pct: number) => { imageQuality.value = pct / 100 },
})

const disabled = computed(() => !hasActiveTab.value)
</script>

<template>
  <section class="settings-section">
    <span class="settings-label">{{ t('settings.export.current') }}</span>
    <div class="view-modes">
      <button
        class="btn btn-secondary btn-sm"
        :disabled="disabled"
        @click="exportHtmlFile"
      >
        {{ t('settings.export.html') }}
      </button>
      <button
        class="btn btn-secondary btn-sm"
        :disabled="disabled"
        @click="exportPdfFile"
      >
        {{ t('settings.export.pdf') }}
      </button>
      <button
        class="btn btn-secondary btn-sm"
        :disabled="disabled"
        @click="exportImageFile"
      >
        {{ t('settings.export.image') }}
      </button>
      <button
        class="btn btn-secondary btn-sm"
        :disabled="disabled"
        @click="exportTextFile"
      >
        {{ t('settings.export.txt') }}
      </button>
      <button
        class="btn btn-secondary btn-sm"
        :disabled="disabled"
        @click="exportCsvFile"
      >
        {{ t('settings.export.csv') }}
      </button>
    </div>
    <span
      v-if="disabled"
      class="settings-note"
    >{{ t('settings.export.none') }}</span>

    <span class="settings-label">{{ t('settings.export.preview') }}</span>
    <ExportPreview v-if="!disabled" />

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
    <label
      class="settings-field"
      for="settings-export-margin"
    >
      <span>{{ t('settings.export.margin') }}</span>
      <input
        id="settings-export-margin"
        class="input"
        type="number"
        inputmode="numeric"
        :min="EXPORT_MARGIN_MM_MIN"
        :max="EXPORT_MARGIN_MM_MAX"
        step="1"
        :value="marginMm"
        @change="marginMm = Number(($event.target as HTMLInputElement).value)"
      >
    </label>
    <span class="settings-note">{{ t('settings.export.marginNote') }}</span>

    <span class="settings-label">{{ t('settings.export.image') }}</span>
    <label
      class="settings-field"
      for="settings-export-image-format"
    >
      <span>{{ t('settings.export.imageFormat') }}</span>
      <SelectMenu
        id="settings-export-image-format"
        class="input"
        :model-value="imageFormat"
        :options="imageFormatChoices"
        @update:model-value="imageFormat = $event as ExportImageFormat"
      />
    </label>
    <label
      class="settings-field"
      for="settings-export-image-quality"
    >
      <span>{{ t('settings.export.imageQuality', { pct: qualityPercent }) }}</span>
      <input
        id="settings-export-image-quality"
        class="input range"
        type="range"
        :min="Math.round(EXPORT_JPEG_QUALITY_MIN * 100)"
        :max="Math.round(EXPORT_JPEG_QUALITY_MAX * 100)"
        step="1"
        :value="qualityPercent"
        @input="qualityPercent = Number(($event.target as HTMLInputElement).value)"
      >
    </label>
    <span class="settings-note">{{ t('settings.export.imageQualityNote') }}</span>
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
