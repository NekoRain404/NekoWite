<script setup lang="ts">
/**
 * 项目与多角色 — §5.1's project page, and §5.2's 项目与多角色 row: 库绑定、主角色、装饰角色、
 * 数量上限, with 「路径绑定转稳定 vaultId」 and 「数量上限由后端控制」.
 *
 * Two things belong here, and only one of them can be done today:
 *
 *  - **The cap** (`project.maxCharacters`), which is policy-backed — D1's rule, D6's session —
 *    so it is stored under the same revision check as every other setting, and it is the number
 *    the host is to enforce (「数量上限由后端控制」: one number read by both sides, rather than a
 *    limit the settings page believes in on its own).
 *  - **The binding**, which does not exist yet. §5.2's 「保留」 keeps the entry, not a control for
 *    something no code reads: the multi-character surface it belongs to (D11b) is not in this
 *    build, so the page states that and draws no switch — the same rule as §5.2's
 *    「不显示可点击但无效果的控件」.
 *
 * The cap is a `<select>` over the rule's own range rather than a number field, and that is a
 * correctness choice, not a style one: D1's rule is an integer between 1 and 5, so every value
 * the user can pick is valid and an out-of-range write is unreachable. A free number field would
 * have to either send a value the store refuses — leaving a page that says "not saved" — or
 * silently snap back to something the user did not type.
 */
import { computed } from 'vue'
import SelectMenu, { type SelectOption } from '../../../components/SelectMenu.vue'
import { t } from '../../../i18n'
import { PET_NUMBER_RULES } from '../../../platform/gateways/pet-contracts'
import type { PetSettingsSaveStatus } from '../composables/use-pet-settings'
import type { PetSettingsContext } from './DesktopPetSettings.vue'

const props = defineProps<{
  /** The container's sessions and capability report. This page creates neither. */
  context: PetSettingsContext
}>()

const project = props.context.sessions.project

const values = computed(() => project.values.value)
const status = computed(() => project.status.value)
const locked = computed(() => status.value === 'read-only')

/**
 * The cap's options, derived from the rule the store validates with (§5.3 「界面和后端使用同一
 * 规则」): changing the rule changes this list, so the two cannot drift into disagreeing about
 * what is acceptable.
 */
const CAP_RULE = PET_NUMBER_RULES['project.maxCharacters']
const capChoices: SelectOption[] = []
for (let size = CAP_RULE.min; size <= CAP_RULE.max; size += 1) {
  capChoices.push({ value: size, label: String(size) })
}

/** See PetCareSettings: the arms with nothing to say are absent, and `read-only` is the page. */
const STATUS_KEYS: Partial<Record<PetSettingsSaveStatus, string>> = {
  loading: 'settings.pet.save.loading',
  pending: 'settings.pet.save.pending',
  saving: 'settings.pet.save.saving',
  saved: 'settings.pet.save.saved',
  invalid: 'settings.pet.save.invalid',
  conflict: 'settings.pet.save.conflict',
  failed: 'settings.pet.save.failed',
}

const statusKey = computed(() => STATUS_KEYS[status.value] ?? null)

function setCap(value: string | number): void {
  // The menu only ever emits one of `capChoices`, which are the rule's own values, so a write
  // the store would refuse is not reachable from here.
  project.edit('maxCharacters', Number(value))
}

function retry(): void {
  void project.save()
}
</script>

<template>
  <section class="settings-section">
    <p
      v-if="locked"
      class="settings-note"
      data-test="pet-project-read-only"
    >
      {{ t('settings.pet.readOnly') }}
    </p>

    <template v-else>
      <label
        class="settings-field"
        for="pet-project-max-characters"
      >
        <span>{{ t('settings.pet.project.maxCharacters') }}</span>
        <SelectMenu
          id="pet-project-max-characters"
          class="input"
          :model-value="values.maxCharacters"
          :options="capChoices"
          @update:model-value="setCap"
        />
      </label>
      <span class="settings-note">{{ t('settings.pet.project.maxCharactersNote') }}</span>

      <span
        v-if="statusKey !== null"
        class="settings-note pet-project__state"
        data-test="pet-project-status"
      >{{ t(statusKey) }}</span>
      <button
        v-if="status === 'failed'"
        class="btn btn-secondary btn-sm pet-project__retry"
        type="button"
        data-test="pet-project-retry"
        @click="retry"
      >
        {{ t('settings.pet.retry') }}
      </button>
    </template>

    <p
      class="settings-note pet-absent"
      data-test="pet-project-binding"
    >
      {{ t('settings.pet.project.bindingUnavailable') }}
    </p>
  </section>
</template>

<style scoped>
.settings-section { display: flex; flex-direction: column; gap: 8px; }
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.settings-field > span { color: var(--app-muted); font-size: 11px; }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }

.pet-project__state { min-height: 16px; }
.pet-project__retry { align-self: flex-start; }

/* A statement about what is missing, marked the way the plugin section marks a build that
   cannot run plugins: a bar at the reading edge, not a toast. */
.pet-absent {
  border-left: 2px solid var(--app-warn);
  padding-left: 8px;
}
</style>
