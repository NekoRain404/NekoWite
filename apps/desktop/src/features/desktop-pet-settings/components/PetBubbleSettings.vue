<script setup lang="ts">
/**
 * §5.1's 气泡与消息 — the bubble's appearance, and nothing this build cannot save.
 *
 * The ledger's inventory for this page is eighteen keys (`docs/architecture/desktop-pet-port-ledger.md`
 * §5, the 气泡与消息 rows). Two of them are reachable through this build's settings schema, and
 * this page renders those two and no others:
 *
 *  - `ap_theme` → the theme control. Upstream's control is a three-way segment
 *    (`settings.html:161-165`, default `dark`); this page renders the same three-way choice the
 *    way the app's own theme control does (`AppearanceSettings.vue:75-95`), and the default is
 *    `system` — 「默认跟随宿主主题」 — because the pet follows the app unless overridden here.
 *    The third option is «follow the app» rather than the system: NekoWite already made that
 *    choice for itself, and a bubble that made it a second time could disagree with the window
 *    it is drawn in.
 *  - `ap_opacity` → the opacity control: the bubble's *background alpha*
 *    (`windows/src/main.ts:88-100`, control at `settings.html:172-173`). It used to be drawn on
 *    常规与交互 as a window opacity, which is a setting upstream never had and this build could not
 *    have honoured — no crate in its tree exposes a window-opacity call — so the control wrote a
 *    value nothing read. The ledger (`desktop-pet-port-ledger.md:112`) and the plan (「Bubble：主题、
 *    透明度、字体……」) both file the key here, which is where upstream drew it.
 *  - `message.bubbleSeconds` → how long a bubble stays. This one is ours rather than upstream's
 *    (§6.3's suggested 6 seconds); its ends and its whole-number requirement come from
 *    `PET_NUMBER_RULES`, so the control can only produce a value the write accepts (§5.3
 *    「界面和后端使用同一规则」).
 *
 * The rest are *stated* rather than drawn — §5.2's 「不可用选项要说明原因，不显示可点击但无效果的
 * 控件」, and the reason this page has no placeholder row builder:
 *
 *  - `ap_bub_mode` (`settings.html:367`), `ap_bub_max` (`:380`), `ap_bub_grouping` (`:374`),
 *    `ap_bub_sortkind` (`:382`), `ap_bub_filter` (`:383`), `ap_bub_hidden` (`:394`), `ap_bub_dot`
 *    (`:191`), `ap_bub_sep` (`:184`), `ap_bub_tokens` (`:403`), `ap_icon_<agentKind>` (`:425`):
 *    the multi-agent row. The schema holds all ten since D7d — the two that are lists and the one
 *    that is a map included, which is the validator's structured kind — so what is missing here is
 *    a *reader*, not a field: `PetBubble`/`PetTaskList` take their layout as a `layout` prop
 *    (`resolvePetBubbleLayout` reads no settings) and nothing draws an agent icon at all. A
 *    control here would save values nothing acts on. §5.2's further requirement stands as well:
 *    the visible rows must be generated 「从当前 Agent 注册表」 rather than from a fixed upstream
 *    list, which is the agent registry's data and not a settings field.
 *  - `ap_theme_phrases` (`settings.html:441`, a five-word vocabulary), `ap_quick_bubbles`
 *    (`:215`, now one bubble per entry rather than free text) and `ap_idle` (`:176`, the
 *    idle-chatter switch): the schema holds all three since D7d, and the phrase *vocabulary* is
 *    still a set of words chosen elsewhere (`pet-message-template.ts`, D9) with no pool per theme
 *    to choose between — so once more a stored value and nothing that reads it.
 *  - `ap_font_size` is `message.fontSize`, stored but not drawn: nothing reads it yet, and the
 *    sentence above it says so rather than offering a control that would save a number no surface
 *    acts on. `ap_font_family` is read by the bubble window (`main.ts:105`) and upstream ships no
 *    control that writes it, so there is none to port. Neither is duplicated here: one setting gets
 *    one control, and no other page draws a `message` field.
 *
 * The session is the container's (`DesktopPetSettings.vue` creates one per domain), so this page
 * never creates one and never calls `load()`: a page that is not on screen should not read. It
 * does flush on the way out — §5.3's 「防抖写入不得丢掉关闭设置前最后一次修改」 — because the
 * container swaps pages by unmounting them and a closed dialog unmounts the container with the
 * debounce still holding the last edit.
 *
 * A store written by a newer build is read-only (§10.2). The session answers a refused read with
 * *this build's* defaults, so the controls are replaced by the container's sentence rather than
 * drawn: a form here would show choices the user never made and offer to save them.
 */
import { computed, onBeforeUnmount } from 'vue'
import { t } from '../../../i18n'
import { PET_NUMBER_RULES } from '../../../platform/gateways/pet-contracts'
import type { PetSettingsValues } from '../../../platform/gateways/pet-contracts'
import type { PetSettingsSaveStatus } from '../composables/use-pet-settings'
import type { PetSettingsContext } from './DesktopPetSettings.vue'

type BubbleTheme = PetSettingsValues['message']['theme']

const props = defineProps<{
  /** The container's sessions. This page creates none of its own. */
  context: PetSettingsContext
}>()

const message = props.context.sessions.message

const values = computed(() => message.values.value)
const status = computed(() => message.status.value)
const locked = computed(() => status.value === 'read-only')

/**
 * The save states a page states in words, by the codes the session reports — the same table the
 * other pages use, with the same two arms missing: `ready` has nothing to report, and `read-only`
 * is the notice above instead.
 */
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

/** The members the schema declares, typed against it: a fourth would be a compile error here. */
const THEMES: readonly BubbleTheme[] = ['light', 'dark', 'system']

const THEME_KEYS: { [T in BubbleTheme]: string } = {
  light: 'settings.pet.bubble.themeLight',
  dark: 'settings.pet.bubble.themeDark',
  system: 'settings.pet.bubble.themeSystem',
}

/** The schema's own rule for the field, not a bound picked here (§5.3). */
const DURATION_RULE = PET_NUMBER_RULES['message.bubbleSeconds']

/**
 * The opacity control's rule, and the same one the store will apply (§5.3).
 *
 * The stored value is the *alpha* — upstream's control is a 60–100 percent slider and the value it
 * saves is `percent / 100` (`main.ts:93`) — so the control and the write meet at the percentage the
 * user reads, and the ends come from the rule rather than from this page.
 */
const OPACITY_RULE = PET_NUMBER_RULES['message.opacity']
const opacityPercent = computed(() => Math.round(values.value.opacity * 100))

function setTheme(theme: BubbleTheme): void {
  message.edit('theme', theme)
}

/**
 * The ends are applied here as well as on the input, for the reason `setDuration` states: this is
 * the submit path, and it is where the write is trusted from.
 */
function setOpacity(percent: number): void {
  if (!Number.isFinite(percent)) return
  const rounded = Math.round(percent) / 100
  message.edit('opacity', Math.min(OPACITY_RULE.max, Math.max(OPACITY_RULE.min, rounded)))
}

/**
 * The rule's own ends, applied at the boundary that submits.
 *
 * The input declares the same two ends, so no gesture can leave the rule: this is the second half
 * of one rule, not a second rule. It is here because the submit path is where the write is trusted
 * from — a future control (a number field, a preset list, a keyboard step) would replace the
 * input's own clamping and keep the same rule, and without this the page would be asking the
 * store to refuse what it could have prevented. (`pet-settings-values.ts` refuses it either way.)
 */
function setDuration(raw: number): void {
  if (!Number.isFinite(raw)) return
  const rounded = Math.round(raw)
  message.edit('bubbleSeconds', Math.min(DURATION_RULE.max, Math.max(DURATION_RULE.min, rounded)))
}

function retry(): void {
  // Retried with the values it failed on: a failed write never replaced the draft.
  void message.save()
}

const { settle } = message
onBeforeUnmount(() => {
  // Nobody awaits this one — the page is already leaving — so the path that *can* await it is
  // the exposed `settle`, for a container that owns the close (§5.3).
  void settle()
})
defineExpose({ settle })
</script>

<template>
  <section class="settings-section">
    <p
      v-if="locked"
      class="settings-note"
      data-test="pet-bubble-read-only"
    >
      {{ t('settings.pet.readOnly') }}
    </p>

    <template v-else>
      <span class="settings-label">{{ t('settings.pet.bubble.theme') }}</span>
      <div class="view-modes">
        <button
          v-for="theme in THEMES"
          :key="theme"
          class="switch-option"
          :class="{ 'is-active': values.theme === theme }"
          type="button"
          :data-test="`pet-bubble-theme-${theme}`"
          @click="setTheme(theme)"
        >
          {{ t(THEME_KEYS[theme]) }}
        </button>
      </div>
      <span class="settings-note">{{ t('settings.pet.bubble.themeNote') }}</span>

      <label
        class="settings-field"
        for="pet-bubble-opacity"
      >
        <span>{{ t('settings.pet.bubble.opacity', { pct: opacityPercent }) }}</span>
        <input
          id="pet-bubble-opacity"
          class="input range"
          type="range"
          :min="Math.round(OPACITY_RULE.min * 100)"
          :max="Math.round(OPACITY_RULE.max * 100)"
          step="1"
          :value="opacityPercent"
          data-test="pet-bubble-opacity"
          @input="setOpacity(Number(($event.target as HTMLInputElement).value))"
        >
      </label>
      <span class="settings-note">{{ t('settings.pet.bubble.opacityNote') }}</span>

      <span class="settings-label">{{ t('settings.pet.bubble.duration', { seconds: values.bubbleSeconds }) }}</span>
      <input
        id="pet-bubble-seconds"
        class="input range"
        type="range"
        :min="DURATION_RULE.min"
        :max="DURATION_RULE.max"
        step="1"
        :value="values.bubbleSeconds"
        data-test="pet-bubble-duration"
        @input="setDuration(Number(($event.target as HTMLInputElement).value))"
      >
      <span class="settings-note">{{ t('settings.pet.bubble.durationNote') }}</span>

      <p
        class="settings-note pet-absent"
        data-test="pet-bubble-layout"
      >
        {{ t('settings.pet.bubble.layoutUnavailable') }}
      </p>
      <p
        class="settings-note pet-absent"
        data-test="pet-bubble-phrases"
      >
        {{ t('settings.pet.bubble.phrasesUnavailable') }}
      </p>

      <span
        v-if="statusKey !== null"
        class="settings-note pet-bubble__state"
        data-test="pet-bubble-status"
      >{{ t(statusKey) }}</span>
      <button
        v-if="status === 'failed'"
        class="btn btn-secondary btn-sm pet-bubble__retry"
        type="button"
        data-test="pet-bubble-retry"
        @click="retry"
      >
        {{ t('settings.pet.retry') }}
      </button>

      <button
        class="btn btn-secondary btn-sm pet-bubble__reset"
        type="button"
        data-test="pet-bubble-reset"
        @click="message.resetDomain()"
      >
        {{ t('settings.pet.reset') }}
      </button>
      <span class="settings-note">{{ t('settings.pet.resetNote') }}</span>
    </template>
  </section>
</template>

<style scoped>
/* `.settings-section`, `.settings-note`, `.settings-label`, `.input` and `.view-modes` are
   restated in the pages that render them, the way `PetGeneralSettings.vue` restates its own:
   a scoped block belongs to the component that renders the element. */
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

.view-modes { display: flex; gap: 6px; flex-wrap: wrap; }

.pet-bubble__state { min-height: 16px; }
.pet-bubble__retry,
.pet-bubble__reset { align-self: flex-start; }

/* A statement about what is missing, marked the way the care page marks one: a bar at the
   reading edge, not a toast. */
.pet-absent {
  border-left: 2px solid var(--app-warn);
  padding-left: 8px;
}
</style>
