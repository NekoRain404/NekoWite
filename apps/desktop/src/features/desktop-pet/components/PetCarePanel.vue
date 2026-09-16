<script setup lang="ts">
/**
 * 养成与统计, on the pet's own surface: what the ledger settled, and what it means.
 *
 * The numbers all come from one place — `petCareProgress` over the ledger's summary — and the wording
 * all comes from `PET_CARE_PANEL_LABELS` and a `labels` prop, because §10.1 wires the pet's i18n
 * namespace in at the composition and a component that kept its strings to itself would be a
 * component the namespace cannot reach. Everything it draws arrives as a prop and it emits nothing:
 * it cannot settle a reward, cannot write a setting and cannot reach a gateway, so there is nowhere
 * for it to earn anything by accident.
 *
 * Four decisions here are the acceptance clauses rather than taste:
 *
 *  - **A missing ledger draws no numbers.** Not zeroes, not a level 0 — nothing. §8's 「token 未知不是
 *    0」 applied to the whole surface: a total nobody computed is not a small total, and a surface that
 *    drew one would leave the user believing it.
 *  - **A day nobody reported usage for says so.** `null` and `0` are different facts, so one gets
 *    words and the other a digit.
 *  - **There is no control here at all.** §5.2 sends signing in, syncing and the leaderboard to the
 *    Advanced page, off by default; §3.4's rule is that an unverified capability must not be *offered*
 *    as though it were there. So: no button, not even a disabled one, and a sentence that says why.
 *  - **An import is reported, never normalised.** The surface shows what a merge raised *and* what it
 *    kept, because the kept half is what tells the user their progress survived (§4).
 *
 * The clock is a prop, the way `PetTaskList`'s is: this component starts no timer. The one thing it
 * uses it for — marking the row that is today — goes through the caller's own local calendar
 * (`petCareDayKey`), which is the rule the ledger settled under in the first place.
 */
import { computed } from 'vue'
import { fillPetLabel } from '../services/pet-message-template'
import {
  PET_CARE_ACHIEVEMENTS,
  PET_CARE_PANEL_LABELS,
  petCareAchievementName,
  petCareDayKey,
  petCareEarnedAchievements,
  petCareHunger,
  petCareProgress,
  type PetCareDayTally,
  type PetCareImportResult,
  type PetCarePanelLabels,
  type PetCareProgress as PetCareFacts,
} from '../services/pet-care-rules'

const props = withDefaults(
  defineProps<{
    /** What the ledger settled, or nothing at all when this build has no ledger to ask. */
    progress?: Partial<PetCareFacts> | null
    /** A record from a newer build: drawn as it is, and never written over (§10.2). */
    readOnly?: boolean
    /** What the last import did, when the user ran one. */
    importResult?: PetCareImportResult | null
    /** A sample rather than a record: marked as one, and nothing on it was earned. */
    preview?: boolean
    /** The caller's clock in epoch ms, or 0 while the caller has none. Read, never started. */
    now?: number
    /** The chrome's own wording. */
    labels?: Partial<PetCarePanelLabels>
  }>(),
  {
    progress: null,
    readOnly: false,
    importResult: null,
    preview: false,
    now: 0,
    labels: () => ({}),
  },
)

const labels = computed<PetCarePanelLabels>(() => ({ ...PET_CARE_PANEL_LABELS, ...props.labels }))
const readout = computed(() => (props.progress ? petCareProgress(props.progress) : null))
const earned = computed(() => (readout.value ? petCareEarnedAchievements(readout.value) : []))
const earnedSet = computed(() => new Set(earned.value))
/** The vocabulary, plus any id the ledger recorded that this build cannot name — shown as itself. */
const badges = computed(() => {
  const known = new Set<string>(PET_CARE_ACHIEVEMENTS)
  const unnamed = (readout.value?.unlocked ?? []).filter((id) => !known.has(id))
  return [...PET_CARE_ACHIEVEMENTS, ...unnamed]
})
const hunger = computed(() =>
  readout.value
    ? petCareHunger(readout.value.lastSettledAt, props.now > 0 ? props.now : Date.now())
    : 'peckish',
)
const todayKey = computed(() => (props.now > 0 ? petCareDayKey(new Date(props.now)) : ''))
const percent = computed(() => (readout.value ? Math.round(readout.value.progress * 100) : 0))
const usage = computed(() => {
  if (!readout.value) return ''
  return readout.value.reportedTokens === null
    ? labels.value.usageUnknown
    : fillPetLabel(labels.value.usage, { tokens: String(readout.value.reportedTokens) })
})

/** One day's row: the day, its completions, and its usage — a digit only where one was reported. */
function dayText(day: PetCareDayTally): string {
  const pattern = day.day === todayKey.value ? labels.value.dayToday : labels.value.day
  return fillPetLabel(pattern, {
    day: day.day,
    count: String(day.completions),
    tokens: day.tokens === null ? labels.value.dayUnknown : String(day.tokens),
  })
}

/** One field of an import report, in the words this build has for it. */
function fieldWords(fields: readonly string[]): string {
  return fields.map((field) => labels.value.importFields[field] ?? field).join(', ')
}

/** The three arms of an import, in words — or null when there is nothing to report. */
const importText = computed(() => {
  const result = props.importResult
  if (!result) return null
  if (result.status === 'conflict') return labels.value.importConflict
  if (result.status === 'refused') {
    return fillPetLabel(labels.value.importRefused, { reason: result.detail })
  }
  const parts = [
    fillPetLabel(labels.value.importRaised, { fields: fieldWords(result.report.raised) }),
  ]
  if (result.report.kept.length > 0) {
    parts.push(fillPetLabel(labels.value.importKept, { fields: fieldWords(result.report.kept) }))
  }
  return parts.join(' ')
})
</script>

<template>
  <section
    class="pet-care"
    :aria-label="labels.panel"
    data-test="pet-care-panel"
  >
    <p
      v-if="preview"
      class="pet-care__note pet-care__preview"
      data-test="pet-care-preview"
    >
      {{ labels.preview }}
    </p>

    <p
      v-if="readOnly"
      class="pet-care__note"
      data-test="pet-care-read-only"
    >
      {{ labels.readOnly }}
    </p>

    <p
      v-if="readout === null && !readOnly"
      class="pet-care__note pet-care__absent"
      data-test="pet-care-absent"
    >
      {{ labels.absent }}
    </p>

    <template v-if="readout !== null">
      <p class="pet-care__level" data-test="pet-care-level">
        {{ fillPetLabel(labels.level, { level: String(readout.level) }) }}
      </p>
      <p class="pet-care__stage" data-test="pet-care-stage">{{ labels.stages[readout.stage] }}</p>
      <div
        class="pet-care__bar"
        role="progressbar"
        data-test="pet-care-progress"
        :aria-label="fillPetLabel(labels.progress, {
          level: String(readout.level),
          percent: String(percent),
        })"
        :aria-valuenow="percent"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="pet-care__bar-fill" :style="{ width: `${percent}%` }" />
      </div>

      <p class="pet-care__note" data-test="pet-care-hunger">
        {{ fillPetLabel(labels.hunger, { hunger: labels.hungerSteps[hunger] }) }}
      </p>
      <p class="pet-care__note" data-test="pet-care-streak">
        {{ fillPetLabel(labels.streak, { days: String(readout.streakDays) }) }}
      </p>
      <p class="pet-care__note" data-test="pet-care-meals">
        {{ fillPetLabel(labels.meals, { count: String(readout.meals) }) }}
      </p>

      <p class="pet-care__note" data-test="pet-care-achievements">
        {{ fillPetLabel(labels.achievements, {
          earned: String(earned.length),
          total: String(badges.length),
        }) }}
      </p>
      <ul class="pet-care__badges">
        <li
          v-for="id in badges"
          :key="id"
          class="pet-care__badge"
          data-test="pet-care-badge"
          :data-badge="id"
          :data-earned="earnedSet.has(id) ? 'yes' : 'no'"
        >
          <span class="pet-care__badge-name">{{ petCareAchievementName(id) }}</span>
          <span class="pet-care__badge-state">{{
            earnedSet.has(id) ? labels.earned : labels.locked
          }}</span>
        </li>
      </ul>

      <p class="pet-care__note" data-test="pet-care-usage">{{ usage }}</p>
      <p
        v-if="readout.unreportedRuns > 0 && readout.reportedTokens !== null"
        class="pet-care__note"
        data-test="pet-care-usage-partial"
      >
        {{ fillPetLabel(labels.usagePartial, { count: String(readout.unreportedRuns) }) }}
      </p>
      <ul class="pet-care__days">
        <li
          v-for="day in readout.days"
          :key="day.day"
          class="pet-care__day"
          data-test="pet-care-day"
          :data-day="day.day"
        >
          {{ dayText(day) }}
        </li>
      </ul>
    </template>

    <p
      v-if="importText"
      class="pet-care__note pet-care__import"
      data-test="pet-care-import"
    >
      <strong>{{ labels.importTitle }}</strong>
      {{ importText }}
    </p>

    <p class="pet-care__note" data-test="pet-care-online">{{ labels.online }}</p>
  </section>
</template>

<style scoped>
.pet-care {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  color: var(--app-text);
  background: var(--app-surface);
  border-radius: 8px;
}
.pet-care__note { margin: 0; font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.pet-care__level { margin: 0; font-size: 15px; font-weight: 600; }
.pet-care__stage { margin: 0; font-size: 12px; color: var(--app-muted); }
.pet-care__bar {
  height: 6px;
  overflow: hidden;
  background: var(--app-border);
  border-radius: 3px;
}
.pet-care__bar-fill { height: 100%; background: var(--app-accent); }
.pet-care__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.pet-care__badge { display: flex; flex-direction: column; font-size: 11px; }
.pet-care__badge[data-earned='no'] { color: var(--app-muted); }
.pet-care__days { margin: 0; padding: 0; list-style: none; font-size: 11px; color: var(--app-muted); }

/* A statement about something that is missing, marked the way the settings pages mark one: a bar at
   the reading edge, not a toast. */
.pet-care__absent,
.pet-care__import {
  border-left: 2px solid var(--app-warn);
  padding-left: 8px;
}
.pet-care__preview { border-left: 2px solid var(--app-accent); padding-left: 8px; }
</style>
