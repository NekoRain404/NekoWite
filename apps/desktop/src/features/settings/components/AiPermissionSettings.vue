<script setup lang="ts">
/**
 * What the AI is allowed to write, and the record of what it did.
 *
 * Split out of the AI section because the two answer different questions — the
 * provider block is "where do the requests go", this is "what may come back and
 * change the document" — and because the audit list alone is long enough that
 * one file holding both would have crossed the split threshold.
 *
 * It reads nothing itself: `useAiPermissionSettings` owns the store, and the
 * key tables beside it keep the template a lookup (§10.2).
 */
import { computed } from 'vue'
import SelectMenu, { type SelectOption } from '../../../components/SelectMenu.vue'
import { t } from '../../../i18n'
// Type-only, so the policy dropdown's cast is checked against the union the
// composable's writable computed accepts.
import type { AiWritePolicy } from '../../../services/ai-permissions'
import {
  AUDIT_KIND_KEYS,
  AUDIT_OUTCOME_KEYS,
  AUDIT_SOURCE_KEYS,
  useAiPermissionSettings,
} from '../composables/use-ai-permission-settings'

const {
  enabled,
  policy,
  writePolicies,
  recentAiAudit,
  auditSummary,
  sessionGrants,
  revokeGrants,
  forgetAudit,
  clockTime,
} = useAiPermissionSettings()

const policyChoices = computed<SelectOption[]>(() =>
  writePolicies.map((option) => ({ value: option.value, label: t(option.labelKey) })),
)
</script>

<template>
  <label class="settings-field settings-toggle">
    <span>{{ t('aiperm.enabled') }}</span>
    <input
      :checked="enabled"
      type="checkbox"
      class="checkbox"
      @change="enabled = ($event.target as HTMLInputElement).checked"
    >
  </label>
  <span class="settings-note">{{ t('aiperm.enabledHint') }}</span>
  <label
    class="settings-field"
    for="settings-ai-policy"
  >
    <span>{{ t('aiperm.policy') }}</span>
    <SelectMenu
      id="settings-ai-policy"
      class="input"
      :model-value="policy"
      :options="policyChoices"
      @update:model-value="policy = $event as AiWritePolicy"
    />
    <span class="settings-note">{{ t('aiperm.policyHint') }}</span>
  </label>
  <div class="settings-field settings-audit">
    <span>{{ t('aiperm.audit.title') }}</span>
    <span class="settings-note">{{ t('aiperm.audit.hint') }}</span>
    <span
      v-if="recentAiAudit.length"
      class="settings-note"
    >{{ t('aiperm.audit.counts', auditSummary) }}</span>
    <ul
      v-if="recentAiAudit.length"
      class="ai-audit-list"
    >
      <li
        v-for="entry in recentAiAudit"
        :key="entry.seq"
        class="ai-audit-row"
        :class="'is-' + entry.outcome"
      >
        <span class="ai-audit-time">{{ clockTime(entry.at) }}</span>
        <span class="ai-audit-source">{{ t(AUDIT_SOURCE_KEYS[entry.source]) }}</span>
        <span
          v-if="entry.kind"
          class="ai-audit-kind"
        >{{ t(AUDIT_KIND_KEYS[entry.kind]) }}</span>
        <span class="ai-audit-outcome">{{ t(AUDIT_OUTCOME_KEYS[entry.outcome]) }}</span>
        <span
          v-if="entry.detail"
          class="ai-audit-detail"
        >{{ entry.detail }}</span>
      </li>
    </ul>
    <span
      v-else
      class="settings-note"
    >{{ t('aiperm.audit.empty') }}</span>
    <button
      class="btn btn-secondary btn-sm"
      :disabled="!recentAiAudit.length"
      @click="forgetAudit()"
    >
      {{ t('aiperm.audit.clear') }}
    </button>
  </div>
  <div class="settings-field">
    <span>{{ t('aiperm.grants') }}</span>
    <span class="settings-note">
      {{ sessionGrants.size
        ? [...sessionGrants].join(', ')
        : t('aiperm.noGrants') }}
    </span>
    <button
      class="btn btn-secondary btn-sm"
      :disabled="sessionGrants.size === 0"
      @click="revokeGrants()"
    >
      {{ t('aiperm.revoke') }}
    </button>
  </div>
</template>

<style scoped>
/* `.settings-field`, `.settings-note`, `.settings-toggle` and `.checkbox` are
   restated in the sections that render them: a scoped block belongs to the
   component that renders the element, and the classes are too small to belong
   in the shared stylesheet. */
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

/* The AI activity list: one line per event, newest first. Outcomes are
 * colour-coded rather than icon-coded, because the whole list is read at a
 * glance to answer "did anything get through that I did not want?". */
.ai-audit-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
  max-height: 168px;
  overflow-y: auto;
}
.ai-audit-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--app-muted);
}
.ai-audit-time {
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
  flex: none;
}
.ai-audit-source {
  flex: none;
  color: var(--app-text);
}
.ai-audit-kind,
.ai-audit-detail {
  flex: none;
  opacity: 0.8;
}
.ai-audit-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-audit-outcome {
  flex: none;
  margin-left: auto;
}
.ai-audit-row.is-allowed .ai-audit-outcome {
  color: var(--app-accent);
}
.ai-audit-row.is-denied .ai-audit-outcome,
.ai-audit-row.is-blocked .ai-audit-outcome {
  color: var(--app-danger, #c0392b);
}
</style>
