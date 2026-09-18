<script setup lang="ts">
/**
 * §5.1's 常规与交互, less the fields that belong to another page.
 *
 * §4's rollback is this page's to state: 「回退通过关闭桌宠功能开关和移除装配引用，不影响 Agent 工作、
 * 笔记保存或原设置页。已导入的角色/养成保留」. The 功能开关 is the pair of window switches below —
 * both off is what "the pet is off" means — and the page records that upstream has no standalone
 * master switch either (「不存在上游能力：独立的启用/禁用桌宠总开关」). So the switches are settings
 * writes like any other, and what they must *not* do is stated where the user can read it rather
 * than left to be discovered.
 *
 * It writes two domains, because §5.1's page does and because the schemas are what a page is
 * allowed to be about: `general` for 启用, the motion policy and §5.1's 悬浮球, `view` for
 * 窗口行为. The restored-defaults action is the two of them together and nothing else (§5.3
 * 「恢复本页默认只影响当前域」).
 *
 * **不透明度 is not one of its rows, and that is a correction.** The control this page used to draw
 * was filed as a *window* opacity, which is a setting upstream never had and this build cannot
 * honour — no crate in its tree exposes a window-opacity call. Upstream's `ap_opacity` is the
 * bubble's background alpha (`windows/src/main.ts:88-100`, control at `settings.html:172-173`), and
 * the ledger and the plan both file it under 气泡与消息, so the control lives on that page and
 * `message.opacity` carries it.
 *
 * The pet has two windows and each has its own switch, which is what 「悬浮球和桌宠可以单独开关」 asks
 * for: 显示角色窗口 governs the window the character is drawn in, 显示悬浮球 governs the ball, and
 * neither is subordinate to the other — off-with-the-ball-on is the state 「只开悬浮球」 names. That is
 * upstream's own shape, ported rather than invented: upstream's 「Show main pet」 row
 * (`references/desktop-pet/windows/settings.html:69-71`) hides the pet while its 「Show floating
 * ball」 row (`:50-52`) is a separate flag, and its ball is spawned from that flag alone
 * (`windows/src-tauri/src/lib.rs:884-887`), so upstream can show the ball without the character too.
 *
 * Neither switch is ever drawn *disabled*, in any state this page can render: a control that cannot
 * be operated is the defect 「我希望桌宠和悬浮球可以分别打开分别关闭」 names, and 「分别打开分别关闭」
 * is exactly the ability to reach all four combinations — including turning one window back on while
 * the other is off. §5.2's rule about a control that looks like it should do something and cannot
 * is why *the pair is the whole of the state*: there is nothing left over for a third switch to
 * speak for.
 *
 * 显示桌宠 used to sit above them as that third switch, and it is gone. `general.enabled` is
 * *derived* — `enabled == characterWindow || ball`, recomputed by the store on every read and every
 * write (`desktop_pet/settings/values.rs`'s `derive_master`) — so a control for it could only ever
 * contradict the pair, and one that was off left both real switches disabled, which is how the
 * state 「两只都关掉」 became unreachable. The field is still declared and still written; it is just
 * not the user's to set. That is also why each setter below makes *two* `edit` calls: `dirty` in
 * `use-pet-settings.ts` compares the draft with the record the store answers with, and the store
 * answers with `enabled` recomputed, so writing only the switch the user touched would leave the
 * draft disagreeing with every record from then on and show 「未保存」 for a save that landed.
 *
 * 悬浮球大小 is the ball's own size, and it is the same kind of port as the switches: upstream keeps
 * the orb's diameter in one place (`--ball-size`) and derives the window around it
 * (`windows/src/styles.css:227-236`), which is what this build does with `general.ballSize` — the
 * host sizes the ball's window from it and the ball draws its orb from it. The slider is drawn in
 * the stored unit from the schema's own rule, so it can only produce a value the write accepts
 * (§5.3 「界面和后端使用同一规则」).
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

/**
 * The two window switches, each of them writing the master it derives as well.
 *
 * The second `edit` in each is not a second decision — it is the same `enabled == characterWindow
 * || ball` the store applies, stated in the draft. It is here because `dirty` compares the draft
 * against the record the store answers with, and a record's `enabled` is always the derived one:
 * a page that wrote only the switch the user touched would be permanently, invisibly unsaved, and
 * a page that read `enabled` back from the store instead would be a second authority on a value
 * only these two fields decide.
 *
 * The other field is read once, before either write, so the derivation is over the state the user
 * is looking at rather than over the half-updated draft.
 */
function setBall(value: boolean): void {
  const characterWindow = generalValues.value.characterWindow
  general.edit('ball', value)
  general.edit('enabled', value || characterWindow)
}
function setCharacterWindow(value: boolean): void {
  const ball = generalValues.value.ball
  general.edit('characterWindow', value)
  general.edit('enabled', value || ball)
}

/** The schema's own rule for the ball's diameter, not a bound picked here (§5.3). */
const BALL_SIZE_RULE = PET_NUMBER_RULES['general.ballSize']

/**
 * The rule's own ends, applied at the boundary that submits — the same second half of one rule the
 * character's size slider carries (`PetCharacterSettings.vue`'s `setSize`). The input declares the
 * same two ends, so no gesture can leave the rule; this is here because the submit path is where
 * the write is trusted from, and without it the page would be asking the store to refuse what it
 * could have prevented (`pet-settings-values.ts` refuses it either way).
 */
function setBallSize(raw: number): void {
  if (!Number.isFinite(raw)) return
  const rounded = Math.round(raw)
  general.edit('ballSize', Math.min(BALL_SIZE_RULE.max, Math.max(BALL_SIZE_RULE.min, rounded)))
}
function setMotion(value: string | number): void {
  general.edit('motion', value === 'reduced' ? 'reduced' : 'system')
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
      <!-- The two window switches are peers and neither is ever disabled: 「分别打开分别关闭」 is
           the reach of all four combinations, and the one where the other window is off is the
           one a switch that locked itself would have taken away. -->
      <label class="settings-field settings-toggle">
        <span>{{ t('settings.pet.general.ball') }}</span>
        <input
          class="checkbox"
          type="checkbox"
          data-test="pet-general-ball"
          :checked="generalValues.ball"
          @change="setBall(($event.target as HTMLInputElement).checked)"
        >
      </label>
      <span class="settings-note">{{ t('settings.pet.general.ballNote') }}</span>

      <!-- The ball's own size, drawn in the stored unit the way the character's is, and filed
           here rather than on 角色与动画 because the ball is a window of its own with no character
           behind it at all. -->
      <span class="settings-label">{{ t('settings.pet.general.ballSize', { px: generalValues.ballSize }) }}</span>
      <input
        id="pet-general-ball-size"
        class="input range"
        type="range"
        :min="BALL_SIZE_RULE.min"
        :max="BALL_SIZE_RULE.max"
        step="1"
        :value="generalValues.ballSize"
        data-test="pet-general-ball-size"
        @input="setBallSize(Number(($event.target as HTMLInputElement).value))"
      >
      <span class="settings-note">{{ t('settings.pet.general.ballSizeNote') }}</span>

      <label class="settings-field settings-toggle">
        <span>{{ t('settings.pet.general.characterWindow') }}</span>
        <input
          class="checkbox"
          type="checkbox"
          data-test="pet-general-character-window"
          :checked="generalValues.characterWindow"
          @change="setCharacterWindow(($event.target as HTMLInputElement).checked)"
        >
      </label>
      <span class="settings-note">{{ t('settings.pet.general.characterWindowNote') }}</span>

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
      <!-- **The row's own statement of what it cannot do yet, which is the half §7.2 does not
           reach.** §7.2's notes above refuse the two modes this machine was not verified to run;
           this one is about the value itself. `view.roam` is written here and read by nothing: the
           engine it was ported for (`features/desktop-pet/motion/`, D11a) is complete, tested, and
           imported by no page — its own header names what a caller would have to supply — so
           `off`, `stay` and every gated mode end in the same behaviour today. Stating that is
           §5.2's 「不显示可点击但无效果的控件」 applied to a control that is *stored* rather than
           acted on, and the reason the control stays enabled is the same section's other half:
           §5.3 keeps the choice as a preference that follows the user between machines.
           The removal is a contract with a mechanism: the day the engine is imported from this
           window's root, `desktop-pet-entry.test.ts` refuses the new imports until somebody writes
           down why the pet needs them (its list is the pet window's graph) — and this note and the
           case that asserts it are what that change deletes. -->
      <span
        class="settings-note"
        data-test="pet-general-roam-not-wired"
      >{{ t('settings.pet.general.roamNote') }}</span>

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
