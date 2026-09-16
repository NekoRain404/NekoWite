<script setup lang="ts">
/**
 * 养成与统计 — §5.1's care page, and the local half of §5.2's Care row: 等级、成就、角色名称和
 * 数据 stay local, while 登录、恢复、同步、排行榜 go to the integration page and stay off
 * (「默认关闭 …… 不能借用原项目 OAuth 身份」).
 *
 * What this page renders, and what it deliberately does not:
 *
 *  - The two settings of the `care` domain, through the session the container owns. A page
 *    never creates one: two sessions on one domain are two revisions, and the second write
 *    comes back as a conflict against the first (`DesktopPetSettings.vue` says the same from
 *    its side).
 *  - **What the ledger settled, read once when this page is opened** — the ledger that settles
 *    rewards (`R/src/desktop_pet/care_ledger.rs`) through the host's own read
 *    (`PetGateway.care`), drawn by the pet's care surface (`PetCarePanel.vue`, D10) with this
 *    page's wording as its labels. The read is a read: no control here settles anything, and the
 *    panel it feeds has no control on it at all (§5.2 sends signing in, syncing and the
 *    leaderboard to the Advanced page).
 *  - **A sentence where there is nothing to draw, and no numbers.** The host answers `empty` for
 *    a ledger nothing has settled into — not a summary of zeroes — and the sentence below says so
 *    in words. That distinction is the whole reason the read has two arms: `Level 0 · 0 completed`
 *    is what a summary of zeroes would put on screen for a user who has completed five hundred
 *    runs, and §8's 「token 未知不是 0」 is the same rule one level down.
 *
 * The sentence this page used to carry said the page *could not* read the ledger ("the host
 * connection carries settings and tasks, and no care"). That was true when D7c wrote it and
 * stopped being true here, where the read landed: the sentence, the header and the test that pins
 * them were corrected together, because a page's whole value is that what it says about itself can
 * be believed.
 *
 * A store written by a newer build keeps the page's controls off the screen (§10.2): the
 * session answers a refused read with *this build's* defaults, so a form here would be showing
 * numbers the user never chose and offering to save them over their own.
 */
import { computed, onMounted, ref } from 'vue'
import { t } from '../../../i18n'
// The care surface comes from the feature's public entry (§13.11: nothing outside the pet imports
// one of its files by path), and the summary it is handed is the contract's — the same split
// `DesktopPetSettingsSection.vue` uses for the pages it composes.
import { PetCarePanel } from '../../desktop-pet'
import type { PetCareSummary } from '../../../platform/gateways/pet-contracts'
import type { PetSettingsSaveStatus } from '../composables/use-pet-settings'
import { carePanelLabels } from './pet-care-labels'
import type { PetSettingsContext } from './DesktopPetSettings.vue'

const props = defineProps<{
  /** The container's sessions and capability report. This page creates neither. */
  context: PetSettingsContext
}>()

const care = props.context.sessions.care

const values = computed(() => care.values.value)
const status = computed(() => care.status.value)
const locked = computed(() => status.value === 'read-only')

/**
 * The save states a page states in words, by the codes the session reports. The two arms that
 * are missing are missing on purpose: `ready` has nothing to report, and `read-only` replaces
 * the controls above instead of annotating them beside.
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

/**
 * What the ledger settled, as this page read it.
 *
 * `null` while nothing has been read yet, and the two ways of having nothing to draw are kept
 * apart rather than folded into one: `empty` is a fact — nothing has settled — while a refusal
 * means this page cannot tell, which is a different sentence to the user and a different thing to
 * do about it. Neither is turned into a summary of zeroes.
 */
/** The chrome the panel draws with, read once per locale change rather than per render. */
const labels = computed(() => carePanelLabels())

const settled = ref<PetCareSummary | null>(null)
/** The host's own words when the read was refused, or `null` when it answered. */
const readProblem = ref<string | null>(null)
/** The clock the read was taken at, handed to the panel so "today" is the day the caller is in. */
const readAt = ref(0)

onMounted(() => {
  props.context.gateway.care().then(
    (read) => {
      // Both arms are the host's to choose and neither is defaulted here: a page that turned
      // `empty` into a zeroed summary would be inventing the numbers this whole design keeps off
      // the screen.
      settled.value = read.status === 'current' ? read.summary : null
      readAt.value = Date.now()
    },
    (error: unknown) => {
      // A diagnostic, shown rather than swallowed: "no progress" and "could not ask" look the
      // same on screen otherwise, and the host's sentence is what tells them apart.
      readProblem.value = error instanceof Error ? error.message : String(error)
    },
  )
})

function setEnabled(value: boolean): void {
  care.edit('enabled', value)
}

function setRestReminders(value: boolean): void {
  care.edit('restReminders', value)
}

function retry(): void {
  // §5.3 「保存失败展示错误并保持可重试状态」: the draft was never replaced by an outcome, so
  // the same write is still the right one to retry — nothing has to be entered again.
  void care.save()
}
</script>

<template>
  <section class="settings-section">
    <p
      v-if="locked"
      class="settings-note"
      data-test="pet-care-read-only"
    >
      {{ t('settings.pet.readOnly') }}
    </p>

    <template v-else>
      <label class="settings-field settings-toggle">
        <span>{{ t('settings.pet.care.enabled') }}</span>
        <input
          class="checkbox"
          type="checkbox"
          data-test="pet-care-enabled"
          :checked="values.enabled"
          @change="setEnabled(($event.target as HTMLInputElement).checked)"
        >
      </label>
      <span class="settings-note">{{ t('settings.pet.care.enabledNote') }}</span>

      <label class="settings-field settings-toggle">
        <span>{{ t('settings.pet.care.restReminders') }}</span>
        <input
          class="checkbox"
          type="checkbox"
          data-test="pet-care-rest-reminders"
          :checked="values.restReminders"
          @change="setRestReminders(($event.target as HTMLInputElement).checked)"
        >
      </label>
      <span class="settings-note">{{ t('settings.pet.care.restRemindersNote') }}</span>
      <span class="settings-note">{{ t('settings.pet.care.scopeNote') }}</span>

      <span
        v-if="statusKey !== null"
        class="settings-note pet-care__state"
        data-test="pet-care-status"
      >{{ t(statusKey) }}</span>
      <button
        v-if="status === 'failed'"
        class="btn btn-secondary btn-sm pet-care__retry"
        type="button"
        data-test="pet-care-retry"
        @click="retry"
      >
        {{ t('settings.pet.retry') }}
      </button>
    </template>

    <!-- What the ledger settled. Drawn only when there is something to draw: the panel's own
         `absent` arm is reached by passing it no progress at all, and the sentence below is this
         page's telling of the same fact in the settings surface's own voice.
         The note's `data-test` is `pet-care-progress-note` and not `pet-care-progress`: the panel
         owns that name for the level bar, and two elements answering to one selector is how a
         later assertion ends up about the wrong one. -->
    <PetCarePanel
      v-if="settled"
      :progress="settled"
      :now="readAt"
      :labels="labels"
    />
    <p
      v-else-if="readProblem !== null"
      class="settings-note pet-absent"
      data-test="pet-care-progress-note"
    >
      {{ t('settings.pet.care.progressUnreadable', { msg: readProblem }) }}
    </p>
    <p
      v-else
      class="settings-note pet-absent"
      data-test="pet-care-progress-note"
    >
      {{ t('settings.pet.care.progressEmpty') }}
    </p>

    <p
      class="settings-note"
      data-test="pet-care-online"
    >
      {{ t('settings.pet.care.onlineNote') }}
    </p>
  </section>
</template>

<style scoped>
/* `.settings-section`, `.settings-field`, `.settings-note`, `.settings-label`, `.settings-toggle`
   and `.checkbox` are restated in the pages that render them, the way `PetGeneralSettings.vue`
   restates its own: a scoped block belongs to the component that renders the element. */
.settings-section { display: flex; flex-direction: column; gap: 8px; }
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.settings-field > span { color: var(--app-muted); font-size: 11px; }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
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

.pet-care__state { min-height: 16px; }
.pet-care__retry { align-self: flex-start; }

/* A statement about what is missing, marked the way the plugin section marks a build that
   cannot run plugins: a bar at the reading edge, not a toast. */
.pet-absent {
  border-left: 2px solid var(--app-warn);
  padding-left: 8px;
}
</style>
