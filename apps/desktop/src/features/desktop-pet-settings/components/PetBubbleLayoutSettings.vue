<script setup lang="ts">
/**
 * §5.1's 气泡与消息, the half that decides what a row *is*.
 *
 * Split out of `PetBubbleSettings.vue` for two reasons, and neither is tidiness. That page was
 * already the domain's appearance (theme, opacity, duration) and this is the domain's content model
 * — two subjects, and the pair of them past the file budget in one file. And this is the block that
 * *used to be a paragraph*: the schema held `layoutMode`, `layoutMaxRows`, `grouping`, `filter`,
 * `separator` and `tokens` since D7d and the bubble took no layout from settings at all, so the
 * page said so instead of drawing controls. What made them real is the `message` payload on
 * `desktop_pet_appearance` — a pet window may not read a settings domain
 * (`capabilities/desktop-pet.json`), so the host reads one for it — and the reader chain
 * `pet-appearance.ts` → `usePetWindow.ts` → `DesktopPetRoot.vue` → `PetBubble.vue`.
 *
 * The container's session is what every control writes through (`context.sessions.message`), so the
 * write is the domain's own debounced path and §5.3's 「防抖写入不得丢掉关闭设置前最后一次修改」 stays
 * the container's `settle`. This page creates no session and never calls `load()`.
 */
import { computed } from 'vue'
import { t } from '../../../i18n'
import { PET_NUMBER_RULES } from '../../../platform/gateways/pet-contracts'
import type {
  PetBubbleDot,
  PetBubbleFilter,
  PetBubbleGrouping,
  PetBubbleMode,
  PetBubbleSeparator,
  PetBubbleTokenEntry,
} from '../../../platform/gateways/pet-contracts'
import {
  PET_BUBBLE_PRESETS,
  PET_BUBBLE_TOKENS,
  type PetBubblePreset,
  type PetBubbleToken,
} from '../../desktop-pet/services/pet-bubble-layout'
import type { PetSettingsContext } from './DesktopPetSettings.vue'

const props = defineProps<{
  /** The container's sessions. This page creates none of its own. */
  context: PetSettingsContext
}>()

const message = props.context.sessions.message

const values = computed(() => message.values.value)

/**
 * Every control below writes through `message.edit`, which is the same debounced path the opacity
 * and duration controls use — so the write is the domain's, whole, and §5.3's 「防抖写入不得丢掉关闭
 * 设置前最后一次修改」 is the container's `settle` on the way out.
 *
 * The member lists are typed against the schema (`readonly PetBubbleMode[]` and friends), so a
 * member added to a union and not to its control is a compile error rather than a choice nothing
 * can pick.
 */
const MODES: readonly PetBubbleMode[] = ['list', 'carousel', 'compact']
const MODE_KEYS: { [M in PetBubbleMode]: string } = {
  list: 'settings.pet.bubble.modeList',
  carousel: 'settings.pet.bubble.modeCarousel',
  compact: 'settings.pet.bubble.modeCompact',
}
const GROUPINGS: readonly PetBubbleGrouping[] = ['by-agent', 'flat']
const GROUPING_KEYS: { [G in PetBubbleGrouping]: string } = {
  'by-agent': 'settings.pet.bubble.groupingByAgent',
  flat: 'settings.pet.bubble.groupingFlat',
}
const FILTERS: readonly PetBubbleFilter[] = ['all', 'attention', 'active', 'working']
const FILTER_KEYS: { [F in PetBubbleFilter]: string } = {
  all: 'settings.pet.bubble.filterAll',
  attention: 'settings.pet.bubble.filterAttention',
  active: 'settings.pet.bubble.filterActive',
  working: 'settings.pet.bubble.filterWorking',
}
const SEPARATORS: readonly PetBubbleSeparator[] = ['dot', 'arrow', 'bar', 'space']
/**
 * The two state-dot styles (upstream `ap_bub_dot`, `settings.html:190-194`).
 *
 * On *this* page because that is where upstream draws it: its own two groups are Theme / Font size /
 * Opacity / Idle (the appearance, which is `PetBubbleSettings.vue`) and Separator / Dot (the row's
 * own furniture, which is here). The value does not travel this page's way — it is a `PetBubble`
 * prop rather than a layout field, because the layout is what a row *is* and the dot's shape is how
 * it is painted — but where a control lives is a question about the user's reading, not about the
 * wire.
 */
const DOTS: readonly PetBubbleDot[] = ['plain', 'claude']
const DOT_KEYS: { [D in PetBubbleDot]: string } = {
  plain: 'settings.pet.bubble.dotPlain',
  claude: 'settings.pet.bubble.dotClaude',
}
const SEPARATOR_KEYS: { [S in PetBubbleSeparator]: string } = {
  dot: 'settings.pet.bubble.separatorDot',
  arrow: 'settings.pet.bubble.separatorArrow',
  bar: 'settings.pet.bubble.separatorBar',
  space: 'settings.pet.bubble.separatorSpace',
}
const TOKEN_KEYS: { [K in PetBubbleToken]: string } = {
  dot: 'settings.pet.bubble.tokenDot',
  agent: 'settings.pet.bubble.tokenAgent',
  session: 'settings.pet.bubble.tokenSession',
  separator: 'settings.pet.bubble.tokenSeparator',
  message: 'settings.pet.bubble.tokenMessage',
  stateLabel: 'settings.pet.bubble.tokenStateLabel',
  elapsed: 'settings.pet.bubble.tokenElapsed',
}
const PRESETS: readonly PetBubblePreset[] = ['original', 'standard', 'detailed']
const PRESET_KEYS: { [P in PetBubblePreset]: string } = {
  original: 'settings.pet.bubble.presetOriginal',
  standard: 'settings.pet.bubble.presetStandard',
  detailed: 'settings.pet.bubble.presetDetailed',
}

/** The row cap's ends, from the schema's own rule rather than from the input (§5.3). */
const ROWS_RULE = PET_NUMBER_RULES['message.layoutMaxRows']

/**
 * The row fields as the bubble is drawing them.
 *
 * `message.tokens` empty is **not** "no fields": it is the renderer's own preset
 * (`PET_BUBBLE_LAYOUT_DEFAULTS.tokens` is `PET_BUBBLE_PRESETS.standard`), and a control that read
 * the empty list as seven unchecked boxes would show a layout no window has. So the stored list is
 * shown when it has one and the preset is shown when it does not, which is the same fallback
 * `readTokens` makes.
 */
const tokens = computed<readonly PetBubbleTokenEntry[]>(() =>
  values.value.tokens.length > 0 ? values.value.tokens : PET_BUBBLE_PRESETS.standard,
)

function tokenVisible(token: PetBubbleToken): boolean {
  return tokens.value.find((entry) => entry.token === token)?.visible ?? false
}

/**
 * Toggle one field, and write the *whole* list from the preset the page is showing.
 *
 * A whole list rather than a patch, because that is the shape the schema stores: `message.tokens`
 * is the row's field list, in order, and a write that sent one entry would be a list of one. The
 * order is `PET_BUBBLE_TOKENS`', which is upstream's own token order
 * (`references/desktop-pet/windows/src/bubble.ts:18-49`).
 */
function setToken(token: PetBubbleToken, visible: boolean): void {
  message.edit(
    'tokens',
    PET_BUBBLE_TOKENS.map((each) => ({
      token: each,
      visible: each === token ? visible : tokenVisible(each),
    })),
  )
}

/** One of upstream's three presets, written whole (`settings.html`'s 预设 row). */
function setPreset(preset: PetBubblePreset): void {
  message.edit(
    'tokens',
    PET_BUBBLE_PRESETS[preset].map((entry) => ({ token: entry.token, visible: entry.visible })),
  )
}

/** The ends applied at the submit boundary, for the reason {@link setDuration} states. */
function setMaxRows(raw: number): void {
  if (!Number.isFinite(raw)) return
  const rounded = Math.round(raw)
  message.edit('layoutMaxRows', Math.min(ROWS_RULE.max, Math.max(ROWS_RULE.min, rounded)))
}
</script>

<template>
    <span class="settings-label">{{ t('settings.pet.bubble.layout') }}</span>

    <span class="settings-label">{{ t('settings.pet.bubble.layoutMode') }}</span>
    <div class="view-modes">
      <button
        v-for="mode in MODES"
        :key="mode"
        class="switch-option"
        :class="{ 'is-active': values.layoutMode === mode }"
        type="button"
        :data-test="`pet-bubble-mode-${mode}`"
        @click="message.edit('layoutMode', mode)"
      >
        {{ t(MODE_KEYS[mode]) }}
      </button>
    </div>

    <label
      class="settings-field"
      for="pet-bubble-rows"
    >
      <span>{{ t('settings.pet.bubble.maxRows', { rows: values.layoutMaxRows }) }}</span>
      <input
        id="pet-bubble-rows"
        class="input range"
        type="range"
        :min="ROWS_RULE.min"
        :max="ROWS_RULE.max"
        step="1"
        :value="values.layoutMaxRows"
        data-test="pet-bubble-rows"
        @input="setMaxRows(Number(($event.target as HTMLInputElement).value))"
      >
    </label>

    <span class="settings-label">{{ t('settings.pet.bubble.grouping') }}</span>
    <div class="view-modes">
      <button
        v-for="grouping in GROUPINGS"
        :key="grouping"
        class="switch-option"
        :class="{ 'is-active': values.grouping === grouping }"
        type="button"
        :data-test="`pet-bubble-grouping-${grouping}`"
        @click="message.edit('grouping', grouping)"
      >
        {{ t(GROUPING_KEYS[grouping]) }}
      </button>
    </div>

    <span class="settings-label">{{ t('settings.pet.bubble.filter') }}</span>
    <div class="view-modes">
      <button
        v-for="filter in FILTERS"
        :key="filter"
        class="switch-option"
        :class="{ 'is-active': values.filter === filter }"
        type="button"
        :data-test="`pet-bubble-filter-${filter}`"
        @click="message.edit('filter', filter)"
      >
        {{ t(FILTER_KEYS[filter]) }}
      </button>
    </div>

    <span class="settings-label">{{ t('settings.pet.bubble.separator') }}</span>
    <div class="view-modes">
      <button
        v-for="separator in SEPARATORS"
        :key="separator"
        class="switch-option"
        :class="{ 'is-active': values.separator === separator }"
        type="button"
        :data-test="`pet-bubble-separator-${separator}`"
        @click="message.edit('separator', separator)"
      >
        {{ t(SEPARATOR_KEYS[separator]) }}
      </button>
    </div>

    <span class="settings-label">{{ t('settings.pet.bubble.dot') }}</span>
    <div class="view-modes">
      <button
        v-for="dot in DOTS"
        :key="dot"
        class="switch-option"
        :class="{ 'is-active': values.dot === dot }"
        type="button"
        :data-test="`pet-bubble-dot-${dot}`"
        @click="message.edit('dot', dot)"
      >
        {{ t(DOT_KEYS[dot]) }}
      </button>
    </div>
    <span class="settings-note">{{ t('settings.pet.bubble.dotNote') }}</span>

    <span class="settings-label">{{ t('settings.pet.bubble.fields') }}</span>
    <div class="pet-bubble__tokens">
      <label
        v-for="token in PET_BUBBLE_TOKENS"
        :key="token"
        class="pet-bubble__token"
      >
        <input
          type="checkbox"
          :checked="tokenVisible(token)"
          :data-test="`pet-bubble-token-${token}`"
          @change="setToken(token, ($event.target as HTMLInputElement).checked)"
        >
        <span>{{ t(TOKEN_KEYS[token]) }}</span>
      </label>
    </div>
    <span class="settings-note">{{ t('settings.pet.bubble.fieldsNote') }}</span>

    <div class="view-modes">
      <span class="settings-note">{{ t('settings.pet.bubble.preset') }}</span>
      <button
        v-for="preset in PRESETS"
        :key="preset"
        class="btn btn-secondary btn-sm"
        type="button"
        :data-test="`pet-bubble-preset-${preset}`"
        @click="setPreset(preset)"
      >
        {{ t(PRESET_KEYS[preset]) }}
      </button>
    </div>
</template>

<style scoped>
/* `.settings-section`, `.settings-note`, `.settings-label`, `.input` and `.view-modes` are
   restated in the pages that render them, the way `PetGeneralSettings.vue` restates its own:
   a scoped block belongs to the component that renders the element. */
.settings-label {
  margin-top: 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}
.settings-label:first-child { margin-top: 0; }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.settings-field > span { color: var(--app-muted); font-size: 11px; }
.view-modes { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }

/* The row's fields, as a wrapped run of checkboxes: seven of them, and a column would push the
   rest of the page off a 700px dialog. */
.pet-bubble__tokens {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}

.pet-bubble__token {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--app-text);
  cursor: pointer;
}
</style>
