<script setup lang="ts">
/**
 * §5.1's 气泡与消息 — the bubble's appearance, and nothing this build cannot save.
 *
 * The ledger's inventory for this page is eighteen keys (`docs/architecture/desktop-pet-port-ledger.md`
 * §5, the 气泡与消息 rows). This page and the layout block below it render every one of them that
 * this build's schema can act on, and state the one that it cannot:
 *
 *  - `ap_theme` → the theme control. Upstream's control is a three-way segment
 *    (`settings.html:161-165`, default `dark`); this page renders the same three-way choice the
 *    way the app's own theme control does (`AppearanceSettings.vue:75-95`), and the default is
 *    `system` — 「默认跟随宿主主题」 — because the pet follows the theme it is drawn in unless
 *    overridden here. **`system` is the machine's preference on the desktop and the app's in the
 *    preview above**, and that is one rule rather than two: the bubble takes the palette of the
 *    page it is drawn in, the desktop is a page of its own whose engine answers for the system,
 *    and the preview is drawn inside the app's page. The note under the control says exactly that,
 *    because a user who has pinned the app to light on a dark desktop would otherwise be told
 *    something this build cannot do — the app's theme lives in the app window's store, and §7.1
 *    keeps the pet's page from reading it. See `pet-bubble-theme.ts` for the whole argument.
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
 *    `ap_bub_filter` (`:383`), `ap_bub_sep` (`:184`) and `ap_bub_tokens` (`:403`) → the layout
 *    controls below. **These six used to be a paragraph saying they were not in this build**, and
 *    the sentence was accurate: the schema held them and the bubble took no layout from settings,
 *    so a control would have saved values nothing acted on. What made them reachable is the
 *    `message` payload on `desktop_pet_appearance` (`desktop_pet/character_view.rs`,
 *    `PetBubbleRead`) — the window may not read a settings domain, so the host reads one for it —
 *    and the reader chain `pet-appearance.ts` → `usePetWindow` → `DesktopPetRoot.vue`.
 *  - `ap_quick_bubbles` (`:215`) and `ap_idle` (`:176`, the idle-chatter switch) → the phrases
 *    control below. The same sentence was here, and the same payload closed it: the lines reach the
 *    bubble as its `line` prop, picked from the user's list by `usePetWindow`.
 *
 *  - `ap_font_size` (`settings.html:166-170`) → the font-size control, and `ap_bub_dot` (`:190-194`)
 *    → the state-dot control on the layout page. Both were **stored and read by nobody**, and both
 *    are the same fix as the theme's: the field rides the `message` payload and the surface that
 *    draws with it takes a prop. `message.dot` is filed with the row's own furniture because that
 *    is where upstream draws it (its Separator / Dot group), not because the value goes that way.
 *  - `ap_bub_hidden` (`:394`, the per-agent visibility list) and `ap_icon_<agentKind>` (`:425`):
 *    both are keyed by the agent registry, and a control for a list of agents has to be generated
 *    「从当前 Agent 注册表」 (§5.2) rather than from upstream's fixed names — which is the registry's
 *    data and not this page's. **These two stay in the schema and are the whole of what the page
 *    states in words**: the control is a later piece of work and the field is what it will read, so
 *    this is §5.2's own 「说明原因」 arm rather than a value with no reader.
 *  - `ap_font_family` is read by the bubble window (`main.ts:105`) and upstream ships no control
 *    that writes it, so there is none to port.
 *
 * **Three keys left the schema with this change**, and each is named here because the paragraph at
 * the foot of the page used to list it: `ap_bub_sortkind` (`:382`), `ap_theme_phrases` (`:441`) and
 * `ap_left_click_action` (`:202`). None of the three could be given a reader *or* a control — see
 * `pet-contracts/config.ts`'s `message` type, where each removal carries its own reason — and a
 * field that no surface can ever act on is the schema claiming a feature that is not here. A record
 * that still carries one is read by `settings::values`, which drops a key it does not know; the
 * next write never persists it again.
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
import PetBubbleLayoutSettings from './PetBubbleLayoutSettings.vue'
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
 * The three sizes upstream's own control offers, from the schema's rule rather than from a table
 * written here.
 *
 * Upstream is three buttons — S/M/L at 10, 12 and 14 (`settings.html:166-170`) — and the rule the
 * store validates a write against is the same span, so the ends are read off it and the middle is
 * the rule's own fallback, which is the schema's default. A member that stopped being legal here
 * would stop compiling, because the buttons are built from these three numbers and `setFontSize`
 * applies the rule at the boundary that submits.
 */
const FONT_SIZE_RULE = PET_NUMBER_RULES['message.fontSize']
const FONT_SIZES = [FONT_SIZE_RULE.min, FONT_SIZE_RULE.fallback, FONT_SIZE_RULE.max] as const

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
 * The rule's ends, applied where the write is submitted — the same second half `setDuration` and
 * `setOpacity` carry, and for the same reason: the button set is built from the rule, but the
 * submit path is where the write is trusted from.
 */
function setFontSize(size: number): void {
  if (!Number.isFinite(size)) return
  message.edit('fontSize', Math.min(FONT_SIZE_RULE.max, Math.max(FONT_SIZE_RULE.min, Math.round(size))))
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

/**
 * The phrase list as the textarea shows it: one line per entry, upstream's own shape
 * (`references/desktop-pet/windows/src/settings.ts:1793-1797`: `ta.value = lines.join("\n")`).
 */
const phraseText = computed(() => values.value.quickBubbles.join('\n'))

/**
 * The textarea's text as the stored list.
 *
 * Blank lines are dropped here rather than stored, and that is not a second rule: the schema's
 * `isLine` refuses a blank member and its list fields are all-or-nothing, so a submission carrying
 * one would be refused *whole* and the user's other lines with it. Dropping them is how the write
 * is made to succeed, not a policy about what a phrase may be. The trim is the same rule read the
 * other way: a line a user indented is the phrase without the indent.
 */
function onPhrasesInput(text: string): void {
  message.edit('quickBubbles', phrasesOf(text))
}

/** One phrase per line, blanks dropped — see {@link phraseText}'s own note for why. */
function phrasesOf(text: string): readonly string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
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

      <span class="settings-label">{{ t('settings.pet.bubble.fontSize') }}</span>
      <div class="view-modes">
        <button
          v-for="size in FONT_SIZES"
          :key="size"
          class="switch-option"
          :class="{ 'is-active': values.fontSize === size }"
          type="button"
          :data-test="`pet-bubble-font-size-${size}`"
          @click="setFontSize(size)"
        >
          {{ t('settings.pet.bubble.fontSizeOption', { size }) }}
        </button>
      </div>
      <span class="settings-note">{{ t('settings.pet.bubble.fontSizeNote') }}</span>

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

      <PetBubbleLayoutSettings :context="props.context" />

      <span class="settings-label">{{ t('settings.pet.bubble.phrases') }}</span>
      <label
        class="settings-field"
        for="pet-bubble-phrases"
      >
        <span>{{ t('settings.pet.bubble.phrasesHint') }}</span>
        <textarea
          id="pet-bubble-phrases"
          class="input pet-bubble__phrases"
          rows="4"
          :value="phraseText"
          data-test="pet-bubble-phrases"
          @change="onPhrasesInput(($event.target as HTMLTextAreaElement).value)"
        />
      </label>
      <span class="settings-note">{{ t('settings.pet.bubble.phrasesNote') }}</span>

      <label
        class="settings-field pet-bubble__switch"
        for="pet-bubble-idle"
      >
        <span>{{ t('settings.pet.bubble.idle') }}</span>
        <input
          id="pet-bubble-idle"
          type="checkbox"
          :checked="values.idle"
          data-test="pet-bubble-idle"
          @change="message.edit('idle', ($event.target as HTMLInputElement).checked)"
        >
      </label>

      <!-- The one key on this page with no control, stated rather than drawn (§5.2). It is the
           per-engine icon list, and the reason it has none is a fact about the page rather than
           about the value: §5.2 requires the list to be built from the agent registry that is
           installed right now, and this window has no registry. -->
      <p
        class="settings-note pet-absent"
        data-test="pet-bubble-unwired"
      >
        {{ t('settings.pet.bubble.agentsUnavailable') }}
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

/* The phrase list: one line per phrase, so it is a text box and not a single-line input, and it
   keeps the page's own width rather than the user's longest line deciding it. */
.pet-bubble__phrases {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  font: inherit;
}

.pet-bubble__switch {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.pet-bubble__switch > span {
  color: var(--app-text);
  font-size: 12px;
}
</style>
