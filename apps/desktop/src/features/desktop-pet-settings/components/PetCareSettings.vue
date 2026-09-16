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
 *  - **No progress.** The ledger that settles rewards (`R/src/desktop_pet/care_ledger.rs`) and
 *    the rules that compute them (`services/pet-care-rules.ts`) are D10 and do not exist yet,
 *    so there is nothing to show and nothing that earns. A level, an XP bar or a streak drawn
 *    here would be an invented number the user would believe — which §8 forbids in the same
 *    words it uses for an unknown token count (「token 未知不是 0」). The page says so instead,
 *    and `PetCareSettings.test.ts` asserts that statement rather than only asserting that the
 *    switches save.
 *
 * A store written by a newer build keeps the page's controls off the screen (§10.2): the
 * session answers a refused read with *this build's* defaults, so a form here would be showing
 * numbers the user never chose and offering to save them over their own.
 */
import { computed } from 'vue'
import { t } from '../../../i18n'
import type { PetSettingsSaveStatus } from '../composables/use-pet-settings'
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

    <p
      class="settings-note pet-absent"
      data-test="pet-care-progress"
    >
      {{ t('settings.pet.care.progressUnavailable') }}
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
