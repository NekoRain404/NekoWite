<script setup lang="ts">
/**
 * The General section: which build this is, which vault is open, and the
 * language.
 *
 * The vault field is a read-only display of the vault that is open. Browsing is
 * the only way it changes, and the browse itself is the composable's — this
 * renders what the two return and reports a pick upward (§13.3).
 */
import { computed } from 'vue'
import SelectMenu, { type SelectOption } from '../../../components/SelectMenu.vue'
import { setLocale, t } from '../../../i18n'
import { useGeneralSettings } from '../composables/use-general-settings'

defineProps<{
  /** The build a bug report should name, or null when nothing can answer. */
  appVersion: string | null
}>()

const emit = defineEmits<{ (e: 'saved', path: string): void }>()

const { vaultPath, locale, browseVault } = useGeneralSettings()

const languageChoices = computed<SelectOption[]>(() => [
  { value: 'zh', label: t('settings.general.languageZh') },
  { value: 'en', label: t('settings.general.languageEn') },
])

/** The composable's `onLocaleChange` still reads the value off a native
 *  select's `change` event and its module is outside this change, so the
 *  dropdown reaches `setLocale` — the same command — with the same narrowing
 *  the composable applied. */
function pickLocale(value: string | number): void {
  setLocale(value === 'en' ? 'en' : 'zh')
}

async function onBrowse(): Promise<void> {
  const picked = await browseVault()
  if (picked) emit('saved', picked)
}
</script>

<template>
  <section class="settings-section">
    <div
      v-if="appVersion"
      class="settings-field version-row"
      data-test="app-version"
    >
      <span>{{ t('settings.general.version') }}</span>
      <span class="settings-note">{{ appVersion }}</span>
    </div>
    <span class="settings-label">{{ t('settings.general.vault') }}</span>
    <div class="vault-row">
      <!-- Read-only on purpose: the backend only serves a root the user
           picked in the native dialog (or the one it recorded last
           time), so an editable field could only collect a path
           that is refused on save. Selectable, so it can still be
           read or copied. -->
      <input
        class="input vault-path"
        type="text"
        :value="vaultPath"
        readonly
        data-test="vault-path"
        :title="vaultPath"
      >
      <button
        class="btn btn-secondary btn-sm vault-browse"
        :title="t('common.browse')"
        @click="onBrowse"
      >
        {{ t('common.browse') }}
      </button>
    </div>
    <span class="settings-note">{{ t('settings.general.vaultNote') }}</span>

    <span class="settings-label">{{ t('settings.general.language') }}</span>
    <label
      class="settings-field"
      for="settings-locale"
    >
      <SelectMenu
        id="settings-locale"
        class="input"
        :model-value="locale"
        :options="languageChoices"
        @update:model-value="pickLocale"
      />
    </label>
  </section>
</template>

<style scoped>
/* `.settings-section`, `.settings-field`, `.settings-note` and
   `.settings-label` are restated in every settings section: a scoped block
   belongs to the component that renders the element, and the classes are too
   small to belong in the shared stylesheet. */
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

.vault-row { display: flex; gap: 6px; }
.vault-row .input { flex: 1; min-width: 0; }
/* Display, not an editor: without a visual difference the field reads as
 * "type the vault path here", which is the gesture the backend now refuses. */
.vault-path {
  cursor: default;
  background: color-mix(in srgb, var(--app-canvas) 70%, var(--app-panel));
}
.vault-browse { flex: none; }
</style>
