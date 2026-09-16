<script setup lang="ts">
/**
 * §5.1's 角色与动画 — the character on screen, its size, and nothing this build cannot save.
 *
 * The ledger's inventory for this page is nine keys (`docs/architecture/desktop-pet-port-ledger.md`
 * §5, the 角色与动画 rows). Four of them are reachable now, and this page renders those:
 *
 *  - `ap_pet_size` → the size slider. Upstream's control is a 70–130% slider with S/M/L presets
 *    (`settings.html:129-130`, `settings.ts:1063-1077`); the schema stores px in a ruled range
 *    (`PET_NUMBER_RULES['character.size']`), so the slider is drawn in the stored unit and the
 *    presets are upstream's percentages of the schema's default. Its ends come from the rule, so
 *    the control can only produce a value the write accepts (§5.3 「界面和后端使用同一规则」).
 *  - `ap_pet_url` / `ap_pet_custom` → `character.characterId`, chosen from the host's library.
 *    Upstream's `pet-deselect` link (`settings.html:62`, first `display:none` until a pet is
 *    chosen) clears the choice; this page does the same and shows it under the same condition.
 *  - `ap_library`, and the import behind it → the rows below, read from `PetGateway.library()` and
 *    imported through `PetGateway.importCharacter()`. The rows, the selection and the notices come
 *    from `pet-library-policy.ts` (D8) rather than from this component, so the page cannot form a
 *    second opinion about what the library holds.
 *
 * What is still *stated* rather than drawn is the animation mapping — `ap_bind_<mood>`,
 * `ap_idle_mode`, `ap_idle_interval` and `ap_idle_clips`. The schema holds all four since D7d, and
 * the pet window now draws from them (`pet-appearance.ts` passes them to the sprite), so what is
 * missing here is only this page's own controls; the sentence below says that, which is §5.2's
 * 「不可用选项要说明原因」 with the reason it actually has. (The ledger files `ap_idle` here too;
 * upstream renders it on the bubble page as 「Show idle message」, `settings.html:176`.)
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
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { t } from '../../../i18n'
import { PET_NUMBER_RULES, PET_SETTINGS_DEFAULTS } from '../../../platform/gateways/pet-contracts'
import type { PetCharacterEntry } from '../../../platform/gateways/pet-contracts'
// The library's reading and its shapes come from the feature's public entry (§13.11): this page is
// outside the pet feature, and reaching into `services/` by path is what the barrel exists to
// stop.
import { readPetLibrary, type PetLibraryState } from '../../desktop-pet'
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
 * The library, as the host answered it — `null` until it has been asked, which is a different
 * state from an empty library and is said differently.
 */
const installed = shallowRef<PetCharacterEntry[] | null>(null)
const libraryError = ref<string | null>(null)
const importing = ref(false)
const importError = ref<string | null>(null)

/**
 * What the page shows, derived by the library's own policy rather than by this component.
 *
 * The state it is handed is the host's list plus *this page's draft* selection, which is what
 * makes the row light up the moment the user clicks it — before the debounced write — without the
 * page keeping a second copy of the choice. `names` is empty because this build has no rename
 * surface; a row therefore shows the pack's own name.
 */
const reading = computed(() =>
  readPetLibrary({
    installed: installed.value ?? [],
    names: {},
    selectedId: values.value.characterId,
  } satisfies PetLibraryState),
)

/**
 * The notices this page draws, out of the ones the policy reports.
 *
 * Deliberately three of them: `no-characters`, `selection-missing` and `characters-damaged` are
 * about *this app's* library, which is what this page is for. The catalogue notices belong to the
 * advanced page's subject — an online gallery this build has no endpoint for — and drawing them
 * here would put a sentence about the network on the page a user opens to pick a character.
 */
const notices = computed(() =>
  reading.value.notices.filter((notice) =>
    notice === 'no-characters' || notice === 'selection-missing' || notice === 'characters-damaged',
  ),
)

async function readLibrary(): Promise<void> {
  try {
    installed.value = await props.context.gateway.library()
    libraryError.value = null
  } catch (cause) {
    libraryError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

/**
 * Import one pack, then select what arrived.
 *
 * The selection is the *reason* the user imported one, so it follows the import rather than
 * leaving them to click the row that just appeared. `null` is the picker being closed, which is
 * not an outcome to report.
 */
async function importCharacter(): Promise<void> {
  importing.value = true
  importError.value = null
  try {
    const entry = await props.context.gateway.importCharacter()
    await readLibrary()
    if (entry !== null) character.edit('characterId', entry.characterId)
  } catch (cause) {
    importError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    importing.value = false
  }
}

// Read when the page opens, and only then: a page that is not on screen has nothing to show, and
// the container mounts a page when it is opened (`DesktopPetSettings.vue`).
onMounted(() => void readLibrary())

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

      <!-- The library. Every row is a real choice: it writes `character.characterId`, which is the
           value the pet window reads. A character whose files are not what the host recorded is
           listed and *not* selectable — it is the user's, and hiding it would make one that needs
           attention look like one that was never installed (D8's policy). -->
      <span class="settings-label">{{ t('settings.pet.character.library') }}</span>
      <p
        v-if="libraryError !== null"
        class="settings-note pet-absent"
        data-test="pet-character-library-error"
      >
        {{ t('settings.pet.character.libraryUnreadable', { msg: libraryError }) }}
      </p>
      <div
        v-else
        class="library"
        data-test="pet-character-library"
      >
        <button
          v-for="row in reading.characters"
          :key="row.characterId"
          class="library__row"
          :class="{ 'library__row--selected': row.selected }"
          type="button"
          :aria-pressed="row.selected"
          :disabled="!row.usable"
          :title="row.usable ? undefined : t('settings.pet.character.damaged')"
          :data-test="`pet-character-row-${row.characterId}`"
          :data-usable="row.usable"
          @click="character.edit('characterId', row.characterId)"
        >
          <span class="library__name">{{ row.name }}</span>
          <span class="library__id">{{ row.characterId }}</span>
          <span
            v-if="!row.usable"
            class="library__flag"
          >{{ t('settings.pet.character.damaged') }}</span>
        </button>
      </div>
      <p
        v-for="notice in notices"
        :key="notice"
        class="settings-note pet-absent"
        :data-test="`pet-character-notice-${notice}`"
      >
        {{ t(`settings.pet.character.notice.${notice}`) }}
      </p>
      <button
        class="btn btn-secondary btn-sm library__import"
        type="button"
        :disabled="importing"
        data-test="pet-character-import"
        @click="importCharacter"
      >
        {{ importing ? t('settings.pet.character.importing') : t('settings.pet.character.import') }}
      </button>
      <p
        v-if="importError !== null"
        class="settings-note pet-absent"
        data-test="pet-character-import-error"
      >
        {{ t('settings.pet.character.importFailed', { msg: importError }) }}
      </p>
      <span class="settings-note">{{ t('settings.pet.character.libraryNote') }}</span>

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

/* The library rows. A grid of one column, so a long pack name and its id wrap rather than push
   the row wider than the panel. */
.library { display: flex; flex-direction: column; gap: 4px; }
.library__row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius, 6px);
  background: var(--app-panel);
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.library__row:hover:not(:disabled) { border-color: var(--app-accent); }
.library__row:focus-visible { outline: 2px solid var(--app-accent); outline-offset: 1px; }
.library__row:disabled { cursor: not-allowed; opacity: 0.6; }
.library__row--selected {
  border-color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent-soft) 70%, var(--app-panel));
}
.library__name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.library__id {
  flex: 0 1 auto;
  min-width: 0;
  color: var(--app-muted);
  font-family: var(--app-mono-font, monospace);
  font-size: 10px;
  overflow-wrap: anywhere;
}
.library__flag { flex: 0 0 auto; color: var(--app-warn); font-size: 10px; }
.library__import { align-self: flex-start; }

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
