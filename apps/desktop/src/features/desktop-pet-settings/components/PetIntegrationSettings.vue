<script setup lang="ts">
/**
 * 高级与集成 — §5.1's page for 外部监控、诊断、配置导入/导出、可选在线服务, and the one page where
 * this port's acceptance clause (「未验证网络能力明确不可用」) is the whole design.
 *
 * It renders two things and has no controls at all. That is the point:
 *
 *  - **What the host reported** for the capabilities of D1's vocabulary (§7.2). The report is
 *    read once by the container, not here: `context.capabilities` is the same object every page
 *    under it reads, so two pages cannot disagree about what the machine can do. Each line is
 *    D1's own arm — `available`, or `degraded`/`unavailable`/`unverified` *with* the fallback
 *    and the reason, because a finding that could not say what happens instead is not
 *    representable in that contract. Nothing renames those states: the status word and the
 *    fallback are composed into a catalogue key from the value the contract gave, so a new arm
 *    reads as its own name rather than falling into a default. A capability the host did not
 *    report is stated as unchecked, which is not the same claim as "not available" (D7a's
 *    `capabilityUnknown` is the same reading in `PetGeneralSettings.vue`).
 *    On a machine nothing has been measured on, every finding is `unverified` — the honest
 *    default (§12) — and this page says so rather than rendering the settings that would be
 *    available if it were `available`.
 *  - **What this build does not have**, from §5.2 and the ledger's dependency review: the
 *    upstream plugins for process control, autostart and updating, which were *rejected* rather
 *    than deferred; the online gallery; the care login/sync/leaderboard; external hooks and the
 *    local monitor bridge; and the DesktopPet configuration import. Each row carries its reason.
 *
 * Why there is not one switch on this page: an off switch says the feature exists and is merely
 * switched off, and the user then believes the app will do it once enabled. That belief is the
 * defect this page exists to avoid — a control that renders and saves but changes nothing is
 * worse than an absent one — and it is the same rule §7.2 states as 「不伪装已支持」. So an
 * unavailable capability is text, and the test asserts the absence of controls rather than only
 * asserting their labels.
 */
import { computed } from 'vue'
import { t } from '../../../i18n'
import { PET_CAPABILITIES } from '../../../platform/gateways/pet-contracts'
import type {
  PetCapability,
  PetCapabilityFinding,
  PetFallback,
} from '../../../platform/gateways/pet-contracts'
import type { PetSettingsContext } from './DesktopPetSettings.vue'

const props = defineProps<{
  /** The container's context. This page reads the capability report it carries and nothing else. */
  context: PetSettingsContext
}>()

/**
 * One capability's line, flattened so the template narrows nothing and so "nothing was
 * reported" stays a third state rather than being folded into a status.
 */
interface CapabilityRow {
  capability: PetCapability
  /** Null when the host said nothing about this capability. */
  status: PetCapabilityFinding['status'] | null
  /** Set only where a capability cannot be used: an available one substitutes nothing. */
  fallback: PetFallback | null
  /** The host's own words, rendered verbatim (D1: an actionable limit, not an error code). */
  detail: string
}

const rows = computed<CapabilityRow[]>(() =>
  PET_CAPABILITIES.map((capability) => {
    const finding = props.context.capabilities.value.find(
      (entry) => entry.capability === capability,
    )?.finding
    if (finding === undefined) return { capability, status: null, fallback: null, detail: '' }
    if (finding.status === 'available') {
      return { capability, status: finding.status, fallback: null, detail: '' }
    }
    return {
      capability,
      status: finding.status,
      fallback: finding.fallback,
      detail: finding.detail,
    }
  }),
)

/** An empty report is "the host has not answered", never "none of these work". */
const nothingReported = computed(() => props.context.capabilities.value.length === 0)

/**
 * §5.2's 高级与集成 rows, in the order they are read, each with the reason it is not offered.
 * Ids, not sentences: the wording lives in the catalogue (`settings.pet.integration.rows.<id>`),
 * so a row cannot quietly change what it claims here.
 */
const ONLINE_ROWS = ['catalog', 'care-sync', 'external-monitor'] as const
const SYSTEM_ROWS = ['update', 'autostart', 'process', 'import-export'] as const
</script>

<template>
  <section class="settings-section">
    <span class="settings-note">{{ t('settings.pet.integration.note') }}</span>

    <span class="settings-label">{{ t('settings.pet.integration.capabilities.title') }}</span>
    <span class="settings-note">{{ t('settings.pet.integration.capabilities.note') }}</span>

    <p
      v-if="nothingReported"
      class="settings-note pet-absent"
      data-test="pet-integration-no-report"
    >
      {{ t('settings.pet.integration.capabilities.noReport') }}
    </p>
    <div
      v-else
      class="pet-capability-list"
    >
      <div
        v-for="row in rows"
        :key="row.capability"
        class="pet-capability"
        :data-test="`pet-capability-${row.capability}`"
        :data-status="row.status ?? 'unreported'"
      >
        <span class="pet-capability__name">{{ t(`settings.pet.capability.${row.capability}`) }}</span>
        <span
          v-if="row.status === null"
          class="settings-note"
        >{{ t('settings.pet.capabilityUnknown') }}</span>
        <span
          v-else
          class="settings-note"
        >{{ t(`settings.pet.capabilityStatus.${row.status}`) }}</span>
        <span
          v-if="row.fallback !== null"
          class="settings-note"
        >{{ t('settings.pet.integration.capabilities.fallback', {
          fallback: t(`settings.pet.capabilityFallback.${row.fallback}`),
          detail: row.detail,
        }) }}</span>
      </div>
    </div>

    <span class="settings-label">{{ t('settings.pet.integration.onlineTitle') }}</span>
    <p
      class="settings-note"
      data-test="pet-integration-not-offered"
    >
      {{ t('settings.pet.integration.notOfferedNote') }}
    </p>
    <div
      class="pet-not-offered"
      data-test="pet-integration-online"
    >
      <div
        v-for="id in ONLINE_ROWS"
        :key="id"
        class="pet-absent-row"
        :data-test="`pet-integration-row-${id}`"
      >
        <span class="pet-capability__name">{{ t(`settings.pet.integration.rows.${id}.name`) }}</span>
        <span class="settings-note">{{ t(`settings.pet.integration.rows.${id}.reason`) }}</span>
      </div>
    </div>

    <span class="settings-label">{{ t('settings.pet.integration.systemTitle') }}</span>
    <div
      class="pet-not-offered"
      data-test="pet-integration-system"
    >
      <div
        v-for="id in SYSTEM_ROWS"
        :key="id"
        class="pet-absent-row"
        :data-test="`pet-integration-row-${id}`"
      >
        <span class="pet-capability__name">{{ t(`settings.pet.integration.rows.${id}.name`) }}</span>
        <span class="settings-note">{{ t(`settings.pet.integration.rows.${id}.reason`) }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
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

.pet-capability-list,
.pet-not-offered {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pet-capability,
.pet-absent-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-left: 2px solid color-mix(in srgb, var(--app-border) 80%, transparent);
  padding-left: 8px;
}
.pet-absent-row {
  /* The same bar the care and project pages use for a statement of absence. */
  border-left-color: var(--app-warn);
}
.pet-capability__name {
  font-size: 12px;
  color: var(--app-text);
}
.pet-absent {
  border-left: 2px solid var(--app-warn);
  padding-left: 8px;
}
</style>
