<script setup lang="ts">
/**
 * The Appearance section: theme, colour scheme, accent, typography, text
 * direction and the reading-mode toggle.
 *
 * Every value and every write comes from `useAppearanceSettings`, which owns
 * the store reads (§10.2); this decides only how they are laid out and what a
 * click means.
 */
import { computed } from 'vue'
import SelectMenu, { type SelectOption } from '../../../components/SelectMenu.vue'
import { t } from '../../../i18n'
// Type-only, so the template's `as UiFontId` casts are checked against the same
// union the composable's setters take (§13.9); nothing is imported at runtime.
import type { ContentDirection, EditorFontId, MonoFontId, UiFontId } from '../../../stores/appearance'
import { useAppearanceSettings } from '../composables/use-appearance-settings'

const {
  theme,
  setTheme,
  colorSchemes,
  colorScheme,
  setColorScheme,
  colorSchemePreview,
  accents,
  accentColors,
  accent,
  setAccent,
  followSystemAccent,
  setFollowSystemAccent,
  followAccentNote,
  uiFontOptions,
  editorFontOptions,
  monoFontOptions,
  uiFont,
  editorFont,
  monoFont,
  setUiFont,
  setEditorFont,
  setMonoFont,
  bodyFontSize,
  lineHeight,
  setBodyFontSize,
  setLineHeight,
  highContrast,
  setHighContrast,
  contentDirection,
  setContentDirection,
  focusMode,
  setFocusMode,
} = useAppearanceSettings()

// The font ids the store holds are not the names a user reads, so each list is
// paired with its translated label here (§13.3: the section renders its own
// control). Computed rather than built once, because `t` follows the locale.
const uiFontChoices = computed<SelectOption[]>(() =>
  uiFontOptions.map((font) => ({ value: font, label: t(`font.${font}`) })),
)
const editorFontChoices = computed<SelectOption[]>(() =>
  editorFontOptions.map((font) => ({ value: font, label: t(`font.${font}`) })),
)
const monoFontChoices = computed<SelectOption[]>(() =>
  monoFontOptions.map((font) => ({ value: font, label: t(`font.${font}`) })),
)
const directionChoices = computed<SelectOption[]>(() => [
  { value: 'auto', label: t('settings.appearance.directionAuto') },
  { value: 'ltr', label: t('settings.appearance.directionLtr') },
  { value: 'rtl', label: t('settings.appearance.directionRtl') },
])
</script>

<template>
  <section class="settings-section">
    <span class="settings-label">{{ t('settings.appearance.theme') }}</span>
    <div class="view-modes">
      <button
        class="switch-option"
        :class="{ 'is-active': theme === 'light' }"
        @click="setTheme('light')"
      >
        {{ t('settings.appearance.themeLight') }}
      </button>
      <button
        class="switch-option"
        :class="{ 'is-active': theme === 'dark' }"
        @click="setTheme('dark')"
      >
        {{ t('settings.appearance.themeDark') }}
      </button>
      <button
        class="switch-option"
        :class="{ 'is-active': theme === 'system' }"
        @click="setTheme('system')"
      >
        {{ t('settings.appearance.themeSystem') }}
      </button>
    </div>
    <span class="settings-label">{{ t('settings.appearance.colorScheme') }}</span>
    <div
      class="color-scheme-grid"
      role="radiogroup"
      :aria-label="t('settings.appearance.colorScheme')"
    >
      <button
        v-for="s in colorSchemes"
        :key="s"
        type="button"
        class="color-scheme-card"
        role="radio"
        :aria-checked="colorScheme === s"
        :class="{ 'is-selected': colorScheme === s }"
        :data-scheme="s"
        :title="t(`settings.appearance.colorScheme_${s}`)"
        @click="setColorScheme(s)"
      >
        <span
          class="color-scheme-preview"
          aria-hidden="true"
        >
          <span
            class="color-scheme-swatch"
            :style="{ background: colorSchemePreview(s).canvas, borderColor: colorSchemePreview(s).border }"
          />
        </span>
        <span class="color-scheme-name">{{ t(`settings.appearance.colorScheme_${s}`) }}</span>
      </button>
    </div>
    <span class="settings-label">{{ t('settings.appearance.accent') }}</span>
    <div
      class="accent-row"
      :class="{ 'is-disabled': followSystemAccent }"
    >
      <button
        v-for="a in accents"
        :key="a"
        type="button"
        class="accent-swatch"
        :class="{ 'is-selected': accent === a }"
        :style="{ background: accentColors[a] }"
        :aria-label="a"
        :title="a as string"
        @click="setAccent(a)"
      />
    </div>
    <label class="settings-field settings-toggle">
      <span>{{ t('settings.appearance.followSystemAccent') }}</span>
      <input
        :checked="followSystemAccent"
        type="checkbox"
        class="checkbox"
        @change="setFollowSystemAccent(($event.target as HTMLInputElement).checked)"
      >
    </label>
    <span
      v-if="followSystemAccent"
      class="settings-note"
    >{{ followAccentNote }}</span>
    <span class="settings-label">{{ t('settings.appearance.font') }}</span>
    <label
      class="settings-field"
      for="settings-ui-font"
    >
      <span>{{ t('settings.appearance.uiFont') }}</span>
      <SelectMenu
        id="settings-ui-font"
        class="input"
        :model-value="uiFont"
        :options="uiFontChoices"
        @update:model-value="setUiFont($event as UiFontId)"
      />
    </label>
    <label
      class="settings-field"
      for="settings-editor-font"
    >
      <span>{{ t('settings.appearance.editorFont') }}</span>
      <SelectMenu
        id="settings-editor-font"
        class="input"
        :model-value="editorFont"
        :options="editorFontChoices"
        @update:model-value="setEditorFont($event as EditorFontId)"
      />
    </label>
    <label
      class="settings-field"
      for="settings-mono-font"
    >
      <span>{{ t('settings.appearance.monoFont') }}</span>
      <SelectMenu
        id="settings-mono-font"
        class="input"
        :model-value="monoFont"
        :options="monoFontChoices"
        @update:model-value="setMonoFont($event as MonoFontId)"
      />
    </label>
    <label class="settings-field">
      <span>{{ t('settings.appearance.fontSize', { size: bodyFontSize }) }}</span>
      <input
        class="input"
        :value="bodyFontSize"
        type="number"
        min="12"
        max="20"
        @change="setBodyFontSize(Math.min(20, Math.max(12, Number(($event.target as HTMLInputElement).value) || 15)))"
      >
    </label>
    <label class="settings-field">
      <span>{{ t('settings.appearance.lineHeight', { lh: lineHeight }) }}</span>
      <input
        class="input"
        :value="lineHeight"
        type="number"
        min="1.2"
        max="2.4"
        step="0.1"
        @change="setLineHeight(Math.min(2.4, Math.max(1.2, Number(($event.target as HTMLInputElement).value) || 1.8)))"
      >
    </label>
    <label class="settings-field settings-toggle">
      <span>{{ t('settings.appearance.highContrast') }}</span>
      <input
        type="checkbox"
        :checked="highContrast"
        @change="setHighContrast(($event.target as HTMLInputElement).checked)"
      >
    </label>
    <label
      class="settings-field"
      for="settings-content-direction"
    >
      <span>{{ t('settings.appearance.contentDirection') }}</span>
      <SelectMenu
        id="settings-content-direction"
        class="input"
        :model-value="contentDirection"
        :options="directionChoices"
        @update:model-value="setContentDirection($event as ContentDirection)"
      />
    </label>
    <span class="settings-label">{{ t('settings.editor.behavior') }}</span>
    <label class="settings-field settings-toggle">
      <span>{{ t('settings.editor.focusMode') }}</span>
      <input
        :checked="focusMode"
        type="checkbox"
        class="checkbox"
        @change="setFocusMode(($event.target as HTMLInputElement).checked)"
      >
    </label>
  </section>
</template>

<style scoped>
/* `.settings-section`, `.settings-field`, `.settings-note`, `.settings-label`,
   `.settings-toggle`, `.checkbox`, `.view-modes` and the colour-scheme cards
   are restated in the sections that render them: a scoped block belongs to the
   component that renders the element, and the classes are too small to belong
   in the shared stylesheet. */
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
.accent-row { display: flex; gap: 6px; }
.accent-row.is-disabled { opacity: 0.5; pointer-events: none; }
.color-scheme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(86px, 1fr));
  gap: 8px;
}
.color-scheme-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  padding: 6px;
  border: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
  border-radius: var(--app-radius-lg);
  background: color-mix(in srgb, var(--app-elevated) 82%, var(--app-panel));
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 11px;
  cursor: pointer;
  transition: border-color var(--app-motion-fast) var(--app-ease),
              box-shadow var(--app-motion-fast) var(--app-ease),
              background var(--app-motion-fast) var(--app-ease);
}
.color-scheme-card:hover {
  border-color: color-mix(in srgb, var(--app-accent) 45%, var(--app-border));
}
.color-scheme-card:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.color-scheme-card.is-selected {
  border-color: var(--app-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--app-accent) 24%, transparent);
}
.color-scheme-preview {
  display: block;
}
.color-scheme-swatch {
  display: block;
  width: 100%;
  height: 44px;
  border-radius: var(--app-radius-sm);
  border: 1px solid;
}
.color-scheme-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: center;
  color: var(--app-muted);
}
</style>
