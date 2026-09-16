<script setup lang="ts">
/**
 * §5.1's 常规与交互, less the fields that belong to another page.
 *
 * The master switch is the whole reason this page exists: the plan records that upstream has no
 * such setting (「不存在上游能力：独立的启用/禁用桌宠总开关」) and that §4's rollback is defined by
 * it — 「回退通过关闭桌宠功能开关和移除装配引用，不影响 Agent 工作、笔记保存或原设置页。已导入的角色/
 * 养成保留」. So the switch is a settings write like any other, and what it must *not* do is
 * stated where the user can read it rather than left to be discovered.
 *
 * It writes two domains, because §5.1's page does and because the schemas are what a page is
 * allowed to be about: `general` for 启用 and the motion policy, `view` for 窗口行为. The
 * restored-defaults action is the two of them together and nothing else (§5.3
 * 「恢复本页默认只影响当前域」).
 *
 * §7.2 decides which of the window behaviours may be offered. A control whose capability this
 * machine was not verified to have is shown *disabled, with the finding's own words* — the mode
 * is kept rather than rewritten, because §5.3 stores the choice as a preference that follows the
 * user between machines, and §7.2's third column asks for the reason rather than a silent
 * substitution.
 */
import { computed } from 'vue'
import SelectMenu, { type SelectOption } from '../../../components/SelectMenu.vue'
import { t } from '../../../i18n'
import { PET_NUMBER_RULES } from '../../../platform/gateways/pet-contracts'
import type { PetCapability, PetRoamMode } from '../../../platform/gateways/pet-contracts'
import type { PetSettingsContext } from './DesktopPetSettings.vue'
import { reportedCapabilities } from '../services/pet-capability-report'

const props = defineProps<{
  /** The container's sessions. This page never creates one of its own. */
  context: PetSettingsContext
}>()

const { general, view } = props.context.sessions

const generalValues = computed(() => general.values.value)
const viewValues = computed(() => view.values.value)

/**
 * Both domains are read through the same rule the store will apply (§5.3
 * 「界面和后端使用同一规则」): the slider's ends are the schema's, not numbers this page picked,
 * so a value the control can produce is a value the write accepts.
 */
const OPACITY_RULE = PET_NUMBER_RULES['view.opacity']
const opacityPercent = computed(() => Math.round(viewValues.value.opacity * 100))

/**
 * A store written by a newer build is read-only (§10.2), and the controls are not drawn at all
 * rather than drawn disabled: the session answers a refused read with *this build's* defaults,
 * so a form here would be showing numbers the user never chose and offering to save them —
 * which is the one thing §10.2 says the older build must not do.
 */
const locked = computed(() => general.status.value === 'read-only' || view.status.value === 'read-only')

const motionChoices = computed<SelectOption[]>(() => [
  { value: 'system', label: t('settings.pet.general.motionSystem') },
  { value: 'reduced', label: t('settings.pet.general.motionReduced') },
])

/** The modes the schema declares, in the order §7.2's column lists what they need. */
const ROAM_MODES: readonly PetRoamMode[] = ['off', 'stay', 'follow-pointer', 'climb']

const ROAM_LABEL_KEYS: { [M in PetRoamMode]: string } = {
  off: 'settings.pet.general.roamOff',
  stay: 'settings.pet.general.roamStay',
  'follow-pointer': 'settings.pet.general.roamFollowPointer',
  climb: 'settings.pet.general.roamClimb',
}

/** What each mode needs before it may be picked; `off` and `stay` need nothing. */
const MODE_CAPABILITY: { [M in PetRoamMode]?: PetCapability } = {
  'follow-pointer': 'pointer-follow',
  climb: 'window-climb',
}

/**
 * Why a capability cannot decide here, in a sentence, or null when it can.
 *
 * A report this build did not receive is *not* the same claim as a capability reported missing,
 * and §7.2 forbids presenting one as the other (`platform.ts` says a status of `unverified` is
 * "so a host cannot report a capability as present while quietly substituting something").
 * Both refuse the control; only the words differ, and the words come from the host.
 */
function unavailability(capability: PetCapability): string | null {
  // Through the shared reader, because a host that answered something which is not a report has
  // reported nothing — and "nothing" is the arm below, not a throw while the page renders.
  const finding = reportedCapabilities(props.context).find((entry) => entry.capability === capability)
  if (finding === undefined) return t('settings.pet.capabilityUnknown')
  if (finding.finding.status === 'available') return null
  return t('settings.pet.unavailable', { detail: finding.finding.detail })
}

const roamChoices = computed<SelectOption[]>(() =>
  ROAM_MODES.map((mode) => {
    const capability = MODE_CAPABILITY[mode]
    return {
      value: mode,
      label: t(ROAM_LABEL_KEYS[mode]),
      disabled: capability !== undefined && unavailability(capability) !== null,
    }
  }),
)

/** The reasons for the gated modes, each naming the mode it is about. */
const roamRestrictions = computed(() =>
  ROAM_MODES.flatMap((mode) => {
    const capability = MODE_CAPABILITY[mode]
    if (capability === undefined) return []
    const text = unavailability(capability)
    return text === null ? [] : [{ mode, text }]
  }),
)

const alwaysOnTopRestriction = computed(() => unavailability('always-on-top'))

function setEnabled(value: boolean): void {
  general.edit('enabled', value)
}
function setMotion(value: string | number): void {
  general.edit('motion', value === 'reduced' ? 'reduced' : 'system')
}
function setOpacity(percent: number): void {
  view.edit('opacity', percent / 100)
}
function setAlwaysOnTop(value: boolean): void {
  view.edit('alwaysOnTop', value)
}
function setRoam(value: string | number): void {
  const mode = ROAM_MODES.find((candidate) => candidate === value)
  if (mode !== undefined) view.edit('roam', mode)
}
function resetPage(): void {
  general.resetDomain()
  view.resetDomain()
}
</script>

<template>
  <section class="settings-section">
    <p
      v-if="locked"
      class="settings-note"
    >
      {{ t('settings.pet.readOnly') }}
    </p>
    <template v-else>
      <label class="settings-field settings-toggle">
        <span>{{ t('settings.pet.general.enabled') }}</span>
        <input
          class="checkbox"
          type="checkbox"
          :checked="generalValues.enabled"
          @change="setEnabled(($event.target as HTMLInputElement).checked)"
        >
      </label>
      <span class="settings-note">{{ t('settings.pet.general.enabledNote') }}</span>

      <label
        class="settings-field"
        for="pet-general-motion"
      >
        <span>{{ t('settings.pet.general.motion') }}</span>
        <SelectMenu
          id="pet-general-motion"
          class="input"
          :model-value="generalValues.motion"
          :options="motionChoices"
          @update:model-value="setMotion"
        />
      </label>
      <span class="settings-note">{{ t('settings.pet.general.motionNote') }}</span>

      <span class="settings-label">{{ t('settings.pet.general.window') }}</span>

      <label
        class="settings-field"
        for="pet-general-opacity"
      >
        <span>{{ t('settings.pet.general.opacity', { pct: opacityPercent }) }}</span>
        <input
          id="pet-general-opacity"
          class="input range"
          type="range"
          :min="Math.round(OPACITY_RULE.min * 100)"
          :max="Math.round(OPACITY_RULE.max * 100)"
          step="1"
          :value="opacityPercent"
          @input="setOpacity(Number(($event.target as HTMLInputElement).value))"
        >
      </label>

      <label class="settings-field settings-toggle">
        <span>{{ t('settings.pet.general.alwaysOnTop') }}</span>
        <input
          class="checkbox"
          type="checkbox"
          :disabled="alwaysOnTopRestriction !== null"
          :checked="viewValues.alwaysOnTop"
          @change="setAlwaysOnTop(($event.target as HTMLInputElement).checked)"
        >
      </label>
      <span
        v-if="alwaysOnTopRestriction !== null"
        class="settings-note"
      >{{ alwaysOnTopRestriction }}</span>

      <label
        class="settings-field"
        for="pet-general-roam"
      >
        <span>{{ t('settings.pet.general.roam') }}</span>
        <SelectMenu
          id="pet-general-roam"
          class="input"
          :model-value="viewValues.roam"
          :options="roamChoices"
          @update:model-value="setRoam"
        />
      </label>
      <span
        v-for="restriction in roamRestrictions"
        :key="restriction.mode"
        class="settings-note"
      >{{ t(ROAM_LABEL_KEYS[restriction.mode]) }} — {{ restriction.text }}</span>

      <button
        class="btn btn-secondary btn-sm pet-general__reset"
        type="button"
        @click="resetPage"
      >
        {{ t('settings.pet.reset') }}
      </button>
      <span class="settings-note">{{ t('settings.pet.resetNote') }}</span>
    </template>
  </section>
</template>

<style scoped>
.settings-section { display: flex; flex-direction: column; gap: 8px; }
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
.checkbox:disabled { opacity: 0.5; cursor: not-allowed; }
.pet-general__reset { align-self: flex-start; margin-top: 6px; }
.pet-general__reset:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
