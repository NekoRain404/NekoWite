<script setup lang="ts">
/**
 * The Plugins section: the plugins the open vault offers, and whether each one
 * may run.
 *
 * The rows come from `usePluginSettings`, which reads the vault's plugin folder
 * when this section is mounted — and this section is only mounted while it is
 * the visible one, so nothing is read in the background.
 */
import { t } from '../../../i18n'
import { usePluginSettings } from '../composables/usePluginSettings'

const { runnable, loading, vaultPath, rows, togglePlugin } = usePluginSettings()
</script>

<template>
  <section class="settings-section">
    <span class="settings-label">{{ t('settings.section.plugins') }}</span>
    <span class="settings-note">{{ t('settings.plugins.hint') }}</span>
    <span
      v-if="!runnable"
      class="settings-note plugin-blocked"
      data-test="plugins-blocked"
    >{{ t('settings.plugins.blocked') }}</span>
    <span
      v-if="loading"
      class="settings-note"
    >{{ t('settings.plugins.loading') }}</span>
    <span
      v-else-if="!vaultPath"
      class="settings-note"
    >{{ t('settings.plugins.vaultMissing') }}</span>
    <span
      v-else-if="!rows.length"
      class="settings-note"
    >{{ t('settings.plugins.empty') }}</span>
    <div
      v-for="row in rows"
      :key="row.id"
      class="plugin-row"
    >
      <label class="settings-field settings-toggle plugin-row-toggle">
        <span>{{ row.name }} <span class="plugin-version">v{{ row.version }}</span></span>
        <input
          :checked="!row.disabled"
          type="checkbox"
          class="checkbox"
          @change="togglePlugin(row, ($event.target as HTMLInputElement).checked)"
        >
      </label>
      <span class="settings-note plugin-state">
        {{ row.disabled ? t('settings.plugins.disabledNote') : (row.active ? t('settings.plugins.activeNote') : t('settings.plugins.inactiveNote')) }}
      </span>
      <span
        v-if="row.unstable"
        class="settings-note plugin-state is-warn"
      >{{ t('settings.plugins.unstableNote') }}</span>
    </div>
  </section>
</template>

<style scoped>
/* `.settings-section`, `.settings-field`, `.settings-note`, `.settings-label`
   and `.settings-toggle` are restated in the sections that render them: a
   scoped block belongs to the component that renders the element, and the
   classes are too small to belong in the shared stylesheet. */
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

/* A build that cannot run plugins must say so where the switches are, not
 * only in a toast once per session. */
.plugin-blocked {
  color: var(--app-muted);
  border-left: 2px solid var(--app-warn, #b7791f);
  padding-left: 8px;
}
</style>
