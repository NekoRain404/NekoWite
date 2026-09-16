<script setup lang="ts">
/**
 * §5.1's 通知与声音: which of §6.2's endings reaches the user, and in what manner.
 *
 * The four event switches are §6.2's five rows minus the two that are not a choice: a runtime
 * that died and a run that is still working are states, not events anybody opted into. What is
 * left is exactly the rows a user can have an opinion about — the turn finished, the run stopped
 * at a limit or was refused, the run failed, and the run is waiting for an answer.
 *
 * **This page cannot deliver a notification, and that is the design rather than a gap.** The
 * gateway has no delivery method (§6.3 gives delivery to one backend ledger so that two windows
 * cannot both sound off), so the reminder below is drawn *in this window* and the test beside
 * this file asserts that the only calls this page makes are a settings read and a settings
 * write. §5.2 asks for a 测试提醒; a button that raised a real one from a settings page would be
 * a second notifier, which is the thing the recipe exists to prevent.
 *
 * Where the machine cannot raise system notifications at all, that is said in the host's own
 * words rather than papered over with a switch that would not work (§7.2). The switches stay
 * live: the unread list is a surface in its own right, and §7.2 keeps it available precisely
 * when the toast is not.
 */
import { computed } from 'vue'
import { t } from '../../../i18n'
import type { PetSettingsContext } from './DesktopPetSettings.vue'

const props = defineProps<{
  /** The container's sessions. This page never creates one of its own. */
  context: PetSettingsContext
}>()

const notification = props.context.sessions.notification
const values = computed(() => notification.values.value)

/** §10.2's read-only arm: see `PetGeneralSettings` — the form is not drawn rather than dead. */
const locked = computed(() => notification.status.value === 'read-only')

/** The four endings §6.2 lets a user choose about, as the fields they are stored in. */
const EVENT_FIELDS = ['onTurnFinished', 'onStopped', 'onFailed', 'onWaitingInput'] as const
type NotificationEvent = (typeof EVENT_FIELDS)[number]

const EVENT_LABEL_KEYS: { [E in NotificationEvent]: string } = {
  onTurnFinished: 'settings.pet.notification.onTurnFinished',
  onStopped: 'settings.pet.notification.onStopped',
  onFailed: 'settings.pet.notification.onFailed',
  onWaitingInput: 'settings.pet.notification.onWaitingInput',
}

/** Every switch on this page: §6.2's four endings, and the three that shape how they arrive. */
type NotificationField = NotificationEvent | 'sound' | 'doNotDisturb' | 'showTaskTitle'

function setField(field: NotificationField, value: boolean): void {
  notification.edit(field, value)
}

/**
 * Whether this desktop can raise a notification, in the host's words (§7.2).
 *
 * A report that never arrived is not the same claim as one that came back unavailable, and
 * `platform.ts` keeps the two apart on purpose — so a missing report says only that nothing has
 * been checked, which is the truth on a machine D13 has not measured yet.
 */
const deliveryNotice = computed(() => {
  const report = props.context.capabilities.value.find(
    (entry) => entry.capability === 'system-notification',
  )
  if (report === undefined) return t('settings.pet.capabilityUnknown')
  if (report.finding.status === 'available') return null
  return t('settings.pet.notification.noSystemNotification', { detail: report.finding.detail })
})

/** The task name a notification would carry, per `showTaskTitle` (§6.3's privacy default). */
const sampleTitle = computed(() =>
  values.value.showTaskTitle
    ? t('settings.pet.notification.sampleTitleNamed')
    : t('settings.pet.notification.sampleTitle'),
)

/** What the current switches would do with that same reminder, said in one line. */
const sampleStatus = computed(() => {
  if (values.value.doNotDisturb) return t('settings.pet.notification.sampleSilent')
  if (!values.value.onTurnFinished) return t('settings.pet.notification.sampleQuiet')
  return t('settings.pet.notification.sampleShown')
})

function resetPage(): void {
  notification.resetDomain()
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
      <span class="settings-label">{{ t('settings.pet.notification.events') }}</span>
      <label
        v-for="field in EVENT_FIELDS"
        :key="field"
        class="settings-field settings-toggle"
      >
        <span>{{ t(EVENT_LABEL_KEYS[field]) }}</span>
        <input
          class="checkbox"
          type="checkbox"
          :checked="values[field]"
          @change="setField(field, ($event.target as HTMLInputElement).checked)"
        >
      </label>

      <label class="settings-field settings-toggle">
        <span>{{ t('settings.pet.notification.sound') }}</span>
        <input
          class="checkbox"
          type="checkbox"
          :checked="values.sound"
          @change="setField('sound', ($event.target as HTMLInputElement).checked)"
        >
      </label>
      <span class="settings-note">{{ t('settings.pet.notification.soundsNote') }}</span>

      <label class="settings-field settings-toggle">
        <span>{{ t('settings.pet.notification.doNotDisturb') }}</span>
        <input
          class="checkbox"
          type="checkbox"
          :checked="values.doNotDisturb"
          @change="setField('doNotDisturb', ($event.target as HTMLInputElement).checked)"
        >
      </label>
      <span class="settings-note">{{ t('settings.pet.notification.doNotDisturbNote') }}</span>

      <label class="settings-field settings-toggle">
        <span>{{ t('settings.pet.notification.showTaskTitle') }}</span>
        <input
          class="checkbox"
          type="checkbox"
          :checked="values.showTaskTitle"
          @change="setField('showTaskTitle', ($event.target as HTMLInputElement).checked)"
        >
      </label>
      <span class="settings-note">{{ t('settings.pet.notification.showTaskTitleNote') }}</span>

      <span class="settings-label">{{ t('settings.pet.notification.sample') }}</span>
      <div class="pet-reminder">
        <span class="pet-reminder__title">{{ sampleTitle }}</span>
        <span class="pet-reminder__body">{{ t('settings.pet.notification.sampleBody') }}</span>
      </div>
      <span class="settings-note">{{ sampleStatus }}</span>
      <span class="settings-note">{{ t('settings.pet.notification.sampleNote') }}</span>
      <span
        v-if="deliveryNotice !== null"
        class="settings-note"
      >{{ deliveryNotice }}</span>

      <button
        class="btn btn-secondary btn-sm pet-notify__reset"
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
/* The reminder as the desktop would draw it, drawn here instead: a sample of the shape and the
   wording, with nothing leaving the window. */
.pet-reminder {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 9px;
  border: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
  border-radius: var(--app-radius-lg);
  background: var(--app-elevated);
}
.pet-reminder__title { font-size: 11px; font-weight: 600; color: var(--app-text); }
.pet-reminder__body { font-size: 11px; line-height: 1.4; color: var(--app-muted); }
.pet-notify__reset { align-self: flex-start; margin-top: 6px; }
</style>
