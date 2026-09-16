<script setup lang="ts">
/**
 * §5.1's 角色与动画 — the character on screen, its size, and nothing this build cannot save.
 *
 * The ledger's inventory for this page is nine keys (`docs/architecture/desktop-pet-port-ledger.md`
 * §5, the 角色与动画 rows). Exactly two of them are reachable through this build's settings schema,
 * and this page renders those two and no others:
 *
 *  - `ap_pet_size` → the size slider. Upstream's control is a 70–130% slider with S/M/L presets
 *    (`settings.html:129-130`, `settings.ts:1063-1077`); the schema stores px in a ruled range
 *    (`PET_NUMBER_RULES['character.size']`), so the slider is drawn in the stored unit and the
 *    presets are upstream's percentages of the schema's default. Its ends come from the rule, so
 *    the control can only produce a value the write accepts (§5.3 「界面和后端使用同一规则」).
 *  - `ap_pet_url` / `ap_pet_custom` → `character.characterId`. Upstream's `pet-deselect` link
 *    (`settings.html:62`, first `display:none` until a pet is chosen) clears the chosen pet; this
 *    page does the same and shows it under the same condition, which is the whole of the
 *    selection this build can offer.
 *
 * The other seven are *stated* rather than drawn — §5.2's 「不可用选项要说明原因，不显示可点击但无
 * 效果的控件」, and the reason this page has no placeholder picker:
 *
 *  - `ap_library` and the browse/create/rename actions belong to the character library, which is
 *    `pet-library-policy.ts` plus the managed resource directory (D8). `PetGateway` has no method
 *    that lists one, so there is nothing to choose between. `DesktopPetRoot.vue` states the same
 *    thing from the window's side ("No character is selected.").
 *  - `ap_bind_<mood>`, `ap_idle_mode`, `ap_idle_interval` and `ap_idle_clips` belong to the
 *    animation mapping. `pet-settings-values.ts` validates four value kinds — boolean, ruled
 *    number, closed-set string, string-or-null — and the schema declares no field for a clip
 *    binding, a playlist of indices or an interval. (The ledger files `ap_idle` here too;
 *    upstream renders it on the bubble page as 「Show idle message」, `settings.html:176`.) A
 *    picker drawn here would save nothing, which is the failure this page exists to not be.
 *
 * The session is the container's (`DesktopPetSettings.vue` creates one per domain), so this page
 * never creates one and never calls `load()`: a page that is not on screen should not read. It
 * does flush on the way out — §5.3's 「防抖写入不得丢掉关闭设置前最后一次修改」 — because the
 * container swaps pages by unmounting them and a closed dialog unmounts the container with the
 * debounce still holding the last edit.
 *
 * A store written by a newer build is read-only (§10.2). The session answers a refused read with
 * *this build's* defaults, so the controls are replaced by the container's sentence rather than
 * drawn: a form here would show numbers the user never chose and offer to save them.
 */
import { computed, onBeforeUnmount } from 'vue'
import { t } from '../../../i18n'
import { PET_NUMBER_RULES, PET_SETTINGS_DEFAULTS } from '../../../platform/gateways/pet-contracts'
import type { PetSettingsSaveStatus } from '../composables/use-pet-settings'
import type { PetSettingsContext } from './DesktopPetSettings.vue'

const props = defineProps<{
  /** The container's sessions. This page creates none of its own. */
  context: PetSettingsContext
}>()

const character = props.context.sessions.character

const values = computed(() => character.values.value)
const status = computed(() => character.status.value)
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

/** The schema's own rule for the field, not a bound picked here (§5.3). */
const SIZE_RULE = PET_NUMBER_RULES['character.size']

/** Upstream's presets (`settings.html:130`): 80/100/125% of the size upstream calls 100%. */
const SIZE_PRESETS = [80, 100, 125] as const

function presetPx(percent: number): number {
  return Math.round((PET_SETTINGS_DEFAULTS.character.size * percent) / 100)
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
function setSize(raw: number): void {
  if (!Number.isFinite(raw)) return
  const rounded = Math.round(raw)
  character.edit('size', Math.min(SIZE_RULE.max, Math.max(SIZE_RULE.min, rounded)))
}

function clearCharacter(): void {
  character.edit('characterId', null)
}

function retry(): void {
  // Retried with the values it failed on: a failed write never replaced the draft.
  void character.save()
}

const { settle } = character
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
      data-test="pet-character-read-only"
    >
      {{ t('settings.pet.readOnly') }}
    </p>

    <template v-else>
      <span class="settings-label">{{ t('settings.pet.character.character') }}</span>
      <span
        class="settings-note"
        data-test="pet-character-current"
      >{{ values.characterId === null
        ? t('settings.pet.character.none')
        : t('settings.pet.character.selected', { id: values.characterId }) }}</span>
      <!-- Upstream's `pet-deselect`: only reachable when there is a choice to undo, so it is
           never a button that would write the value it already holds. -->
      <button
        v-if="values.characterId !== null"
        class="btn btn-secondary btn-sm"
        type="button"
        data-test="pet-character-clear"
        @click="clearCharacter"
      >
        {{ t('settings.pet.character.clear') }}
      </button>
      <p
        class="settings-note pet-absent"
        data-test="pet-character-library"
      >
        {{ t('settings.pet.character.libraryUnavailable') }}
      </p>

      <span class="settings-label">{{ t('settings.pet.character.size', { px: values.size }) }}</span>
      <input
        id="pet-character-size"
        class="input range"
        type="range"
        :min="SIZE_RULE.min"
        :max="SIZE_RULE.max"
        step="1"
        :value="values.size"
        data-test="pet-character-size"
        @input="setSize(Number(($event.target as HTMLInputElement).value))"
      >
      <div class="size-presets">
        <button
          v-for="percent in SIZE_PRESETS"
          :key="percent"
          class="btn btn-secondary btn-sm"
          type="button"
          :title="t('settings.pet.character.preset', { pct: percent, px: presetPx(percent) })"
          :data-test="`pet-character-preset-${percent}`"
          @click="setSize(presetPx(percent))"
        >
          {{ t(`settings.pet.character.preset${percent}`) }}
        </button>
      </div>
      <span class="settings-note">{{ t('settings.pet.character.sizeNote') }}</span>

      <p
        class="settings-note pet-absent"
        data-test="pet-character-animations"
      >
        {{ t('settings.pet.character.animationsUnavailable') }}
      </p>

      <span
        v-if="statusKey !== null"
        class="settings-note pet-character__state"
        data-test="pet-character-status"
      >{{ t(statusKey) }}</span>
      <button
        v-if="status === 'failed'"
        class="btn btn-secondary btn-sm pet-character__retry"
        type="button"
        data-test="pet-character-retry"
        @click="retry"
      >
        {{ t('settings.pet.retry') }}
      </button>

      <button
        class="btn btn-secondary btn-sm pet-character__reset"
        type="button"
        data-test="pet-character-reset"
        @click="character.resetDomain()"
      >
        {{ t('settings.pet.reset') }}
      </button>
      <span class="settings-note">{{ t('settings.pet.resetNote') }}</span>
    </template>
  </section>
</template>

<style scoped>
/* `.settings-section`, `.settings-field`, `.settings-note`, `.settings-label` and `.input` are
   restated in the pages that render them, the way `PetGeneralSettings.vue` restates its own:
   a scoped block belongs to the component that renders the element. */
.settings-section { display: flex; flex-direction: column; gap: 8px; }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.settings-label {
  margin-top: 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}
.settings-section .settings-label:first-child { margin-top: 0; }

.size-presets { display: flex; gap: 6px; flex-wrap: wrap; }

.pet-character__state { min-height: 16px; }
.pet-character__retry,
.pet-character__reset { align-self: flex-start; }

/* A statement about what is missing, marked the way the care page marks one: a bar at the
   reading edge, not a toast. */
.pet-absent {
  border-left: 2px solid var(--app-warn);
  padding-left: 8px;
}
</style>
