<script lang="ts">

export type { AgentRegistryLabels } from './agent-registry-labels'
</script>

<script setup lang="ts">

import { computed, reactive, ref, watch } from 'vue'
import { useAgentRegistryReadout } from './use-agent-registry-readout'
import AgentRegistrationRow from './AgentRegistrationRow.vue'
import AgentRegistrationForm from './AgentRegistrationForm.vue'
import { suggestRegistrationId } from '../services/agent-registration-id'
import {
  disableStanding, fillTemplate, planEngineSwitch, refusedField, validateAgentDraft,
  type AgentDraft, type AgentDiscoveryCandidate, type AgentRegistryClient, type AgentRegistryEntry,
  type DraftField, type RegistryRefusal,
} from '../services/agent-registry-policy'
import { registryLabels, type AgentRegistryLabels } from './agent-registry-labels'

const props = withDefaults(
  defineProps<{

    client: AgentRegistryClient

    profileId: string

    sessionAgentId?: string | null

    canStartSession?: boolean

    prefill?: { agentId: string; displayName: string; program: string; args: readonly string[] } | null
    labels?: AgentRegistryLabels
  }>(),
  { sessionAgentId: null, canStartSession: true, prefill: null },
)

const emit = defineEmits<{ (event: 'new-session', agentId: string): void }>()

const labels = computed<AgentRegistryLabels>(() => props.labels ?? registryLabels())
const { readout, loadState, load } = useAgentRegistryReadout(() => props.client)
const entries = computed(() => readout.value?.entries ?? [])
const rowRefusals = reactive<Record<string, RegistryRefusal | null>>({})

const busy = ref<string | null>(null)
const actionFailed = ref(false)
const deleting = ref<AgentRegistryEntry | null>(null)

const form = reactive({ agentId: '', displayName: '', program: '', args: '', adapterId: 'generic-acp' })
const edited = reactive<Record<DraftField, boolean>>({ agentId: false, displayName: false, program: false, args: false, adapterId: false })
const submitted = ref(false)
watch(() => [form.displayName, form.program], () => {
  if (!edited.agentId) form.agentId = suggestRegistrationId(form.displayName, form.program, entries.value)
})
const addRefusal = ref<RegistryRefusal | null>(null)
const addedAgentId = ref<string | null>(null)
const discovered = ref<readonly AgentDiscoveryCandidate[]>([])
const discoveryBusy = ref(false)
const discoveryFailed = ref(false)

const draft = computed<AgentDraft>(() => ({
  agentId: form.agentId.trim(),
  displayName: form.displayName.trim(),
  program: form.program.trim(),
  args: form.args.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line !== ''),
  adapterId: form.adapterId,
}))

const problems = computed<RegistryRefusal[]>(() => {
  if (loadState.value !== 'ready' || readout.value === null) return []
  return validateAgentDraft(draft.value, {
    adapterIds: readout.value.adapterIds,
    entries: readout.value.entries,
  })
})

function problem(field: DraftField): RegistryRefusal | null {
  if (!submitted.value && !edited[field]) return null
  return problems.value.find((refusal) => refusedField(refusal) === field) ?? null
}

function updateField(field: DraftField, value: string): void {
  form[field] = value
  edited[field] = true
}

async function submit(): Promise<void> {
  if (busy.value !== null || loadState.value !== 'ready') return
  submitted.value = true
  addRefusal.value = null
  addedAgentId.value = null
  actionFailed.value = false
  if (problems.value.length > 0) return
  busy.value = 'add'
  const submittedDraft = draft.value
  try {
    const refusal = await props.client.add(submittedDraft)
    if (refusal !== null) {
      addRefusal.value = refusal
      return
    }
    addedAgentId.value = submittedDraft.agentId
    Object.assign(form, { agentId: '', displayName: '', program: '', args: '', adapterId: 'generic-acp' })
    for (const field of Object.keys(edited) as DraftField[]) edited[field] = false
    submitted.value = false
    await load()
  } catch {
    actionFailed.value = true
  } finally {
    busy.value = null
  }
}

async function discover(): Promise<void> {
  discoveryBusy.value = true
  discoveryFailed.value = false
  try {
    discovered.value = await props.client.discover?.() ?? []
  } catch {
    discoveryFailed.value = true
  } finally {
    discoveryBusy.value = false
  }
}

function useCandidate(candidate: AgentDiscoveryCandidate): void {
  form.agentId = candidate.agentId
  form.displayName = candidate.displayName
  form.program = candidate.program
  form.args = candidate.args.join('\n')
  form.adapterId = candidate.adapterId
  for (const field of Object.keys(edited) as DraftField[]) edited[field] = true
  submitted.value = false
  addRefusal.value = null
}

async function toggle(entry: AgentRegistryEntry, event: Event): Promise<void> {
  if (busy.value !== null) return
  // A refusal leaves Vue's old value unchanged; restore the browser's optimistic checkbox.
  const input = event.target as HTMLInputElement
  const next = input.checked
  rowRefusals[entry.agentId] = null
  actionFailed.value = false
  busy.value = entry.agentId
  try {
    const refusal = await props.client.setEnabled(entry.agentId, next)
    if (refusal !== null) {
      input.checked = entry.enabled
      rowRefusals[entry.agentId] = refusal
      return
    }
    await load()
  } catch {
    input.checked = entry.enabled
    actionFailed.value = true
    return
  } finally {
    busy.value = null
  }
}

async function deleteRegistration(): Promise<void> {
  const entry = deleting.value
  if (entry === null || busy.value !== null || blocked(entry) !== null) return
  busy.value = entry.agentId
  actionFailed.value = false
  rowRefusals[entry.agentId] = null
  try {
    const refusal = await props.client.delete(entry.agentId)
    if (refusal !== null) {
      rowRefusals[entry.agentId] = refusal
      deleting.value = null
      return
    }
    deleting.value = null
    await load()
  } catch {
    actionFailed.value = true
  } finally {
    busy.value = null
  }
}

function blocked(entry: AgentRegistryEntry): RegistryRefusal | null {
  if (readout.value === null) return null
  const standing = disableStanding(entry, readout.value)
  return standing.allowed ? null : standing.refusal
}

const selectedEngine = ref('')
const selectable = computed(() => entries.value.filter((entry) => entry.enabled))
const nameOf = (agentId: string): string =>
  entries.value.find((entry) => entry.agentId === agentId)?.displayName || agentId

watch(
  () => props.prefill,
  (prefill) => {
    if (prefill === null) return
    form.agentId = prefill.agentId
    form.displayName = prefill.displayName
    form.program = prefill.program
    form.args = prefill.args.join('\n')
    edited.agentId = true
    edited.displayName = true
    edited.program = true
    edited.args = true
    // A prefill is a fresh start: the previous submission's answers do not belong to this draft.
    addRefusal.value = null
    addedAgentId.value = null
  },
  { immediate: true },
)

watch(
  [entries, () => props.sessionAgentId],
  () => {
    // The engine the user is on first, then the default: §3.4.1 makes the bundled engine the
    // answer for a first session, and the session in front of them is the answer for the next one.
    const preferred = props.sessionAgentId ?? readout.value?.defaultAgentId ?? ''
    if (selectable.value.some((entry) => entry.agentId === selectedEngine.value)) return
    selectedEngine.value = selectable.value.some((entry) => entry.agentId === preferred)
      ? preferred
      : (selectable.value[0]?.agentId ?? '')
  },
  { immediate: true },
)

const enginePlan = computed(() =>
  readout.value === null || selectedEngine.value === ''
    ? null
    : planEngineSwitch({
        sessionAgentId: props.sessionAgentId,
        agentId: selectedEngine.value,
        profileId: props.profileId,
        readout: readout.value,
      }),
)

function refusalText(refusal: RegistryRefusal | null): string {
  if (refusal === null) return ''
  const copy = labels.value
  // A program problem *is* one of the state sentences: the same five answers the row draws, so the
  // form and the list cannot come to disagree about what "missing" means.
  if (refusal.kind === 'program') {
    return fillTemplate(copy.programState[refusal.state], { path: refusal.path })
  }
  const facts: Record<string, string> = {}
  for (const [key, value] of Object.entries(refusal)) {
    if (typeof value === 'string' || typeof value === 'number') facts[key] = String(value)
    else if (key === 'owner') facts.owner = copy.ownerUnknown
  }
  return fillTemplate(copy.refusal[refusal.kind], facts)
}

function versionText(entry: AgentRegistryEntry): string {
  return entry.reportedVersion === null
    ? labels.value.list.versionUnknown
    : fillTemplate(labels.value.list.version, { version: entry.reportedVersion })
}

function engineText(): string {
  if (enginePlan.value === null) return labels.value.engine.none
  if (enginePlan.value.kind === 'refused') return refusalText(enginePlan.value.refusal)
  const engine = nameOf(enginePlan.value.agentId)
  return enginePlan.value.kind === 'keep-session'
    ? fillTemplate(labels.value.engine.keeps, { engine })
    : fillTemplate(labels.value.engine.creates, { engine })
}

</script>

<template>
  <section class="settings-section registry">
    <span class="settings-label">{{ labels.section.title }}</span>
    <span class="settings-note">{{ labels.section.hint }}</span>

    <span
      v-if="loadState === 'loading'"
      class="settings-note"
      data-test="registry-loading"
    >{{ labels.list.loading }}</span>
    <template v-else-if="loadState === 'unreadable'">
      <span
        class="settings-note is-error"
        data-test="registry-unreadable"
      >{{ labels.list.unreadable }}</span>
      <button
        type="button"
        class="registry-button"
        data-test="registry-retry"
        @click="load"
      >
        {{ labels.list.retry }}
      </button>
    </template>

    <template v-else>
      <span
        v-if="entries.length === 0"
        class="settings-note"
        data-test="registry-empty"
      >{{ labels.list.empty }}</span>
      <ul class="registry-rows">
        <AgentRegistrationRow
          v-for="entry in entries"
          :key="entry.agentId"
          :entry="entry"
          :labels="labels"
          :busy="busy"
          :blocked="blocked(entry) ? refusalText(blocked(entry)) : null"
          :refusal="refusalText(rowRefusals[entry.agentId] ?? null)"
          :version="versionText(entry)"
          @toggle="toggle(entry, $event)"
          @delete="deleting = entry"
        />
      </ul>

      <div
        v-if="deleting"
        class="registry-confirm"
        role="alertdialog"
        :aria-label="labels.deletion.title"
      >
        <strong>{{ deleting.displayName || deleting.agentId }}</strong>
        <span class="settings-note">{{ labels.deletion.hint }}</span>
        <div class="registry-actions">
          <button
            type="button"
            class="registry-button"
            data-test="registry-confirm-delete"
            :disabled="busy !== null"
            @click="deleteRegistration"
          >
            {{ labels.deletion.confirm }}
          </button>
          <button
            type="button"
            class="registry-button"
            data-test="registry-cancel-delete"
            :disabled="busy !== null"
            @click="deleting = null"
          >
            {{ labels.deletion.cancel }}
          </button>
        </div>
      </div>

      <AgentRegistrationForm
        :form="form"
        :labels="labels"
        :adapter-ids="readout?.adapterIds ?? []"
        :busy="busy"
        :added-agent-id="addedAgentId"
        :action-failed="actionFailed"
        :add-refusal="addRefusal"
        :problem="problem"
        :refusal-text="refusalText"
        @submit="submit"
        @update="updateField"
      />
      <div class="registry-discovery">
        <div class="registry-discovery-heading">
          <div>
            <span class="settings-label">发现已安装 Agent</span>
            <span class="settings-note">扫描 Linux PATH 中已知的 ACP 和终端 Agent，不会自动添加。</span>
          </div>
          <button
            type="button"
            class="registry-button"
            :disabled="discoveryBusy"
            data-test="registry-discover"
            @click="discover"
          >{{ discoveryBusy ? '扫描中…' : '扫描' }}</button>
        </div>
        <span v-if="discoveryFailed" class="settings-note is-error">扫描失败，请稍后重试。</span>
        <ul v-else-if="discovered.length" class="registry-discovery-list">
          <li v-for="candidate in discovered" :key="candidate.agentId" class="registry-discovery-row">
            <div>
              <strong>{{ candidate.displayName }}</strong>
              <span class="settings-note">{{ candidate.kind === 'acp' ? 'ACP' : '终端 CLI' }} · {{ candidate.program }}</span>
            </div>
            <button type="button" class="registry-button" @click="useCandidate(candidate)">填入</button>
          </li>
        </ul>
        <span v-else class="settings-note">尚未扫描。</span>
      </div>
      <div class="registry-engine">
        <span class="settings-label">{{ labels.engine.title }}</span>
        <span
          class="settings-note registry-engine-current"
          data-test="registry-engine-current"
        >
          {{ sessionAgentId === null ? labels.engine.none : fillTemplate(labels.engine.current, { engine: nameOf(sessionAgentId) }) }}
        </span>

        <span
          v-if="!canStartSession"
          class="settings-note"
          data-test="registry-engine-elsewhere"
        >
          {{ labels.engine.elsewhere }}
        </span>
        <template v-else>
          <label class="settings-field">
            <span>{{ labels.engine.choose }}</span>
            <select
              v-model="selectedEngine"
              class="registry-input"
              data-test="registry-engine-select"
            >
              <option
                v-for="entry in selectable"
                :key="entry.agentId"
                :value="entry.agentId"
              >{{ entry.displayName || entry.agentId }}</option>
            </select>
          </label>
          <span class="settings-note registry-engine-plan">{{ engineText() }}</span>
          <button
            v-if="enginePlan?.kind === 'new-session'"
            type="button"
            class="registry-button"
            data-test="registry-new-session"
            @click="emit('new-session', selectedEngine)"
          >
            {{ fillTemplate(labels.engine.start, { engine: nameOf(selectedEngine) }) }}
          </button>
        </template>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* The `.settings-*` classes are restated here, as they are in every section that renders them: a
   scoped block belongs to the component that renders the element, and these are too small to
   belong in the shared stylesheet. */
.settings-section { display: flex; flex-direction: column; gap: 8px; }
.settings-label { margin-top: 6px; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; color: var(--app-muted); }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.settings-note.is-warn { color: var(--app-warn); }
.settings-note.is-error { color: var(--app-danger); }
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.settings-field > span:first-child { color: var(--app-muted); font-size: 11px; }
.registry-rows { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.registry-form, .registry-engine { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--app-border); }
.registry-input { font: inherit; font-size: 12px; padding: 4px 6px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); color: var(--app-text); }
.registry-actions { display: flex; align-items: center; gap: 8px; }
.registry-button { align-self: flex-start; font: inherit; font-size: 11px; padding: 4px 10px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-accent); color: var(--app-accent-contrast); cursor: pointer; }
.registry-button:disabled { opacity: 0.5; cursor: default; }
.registry-confirm { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--app-danger); border-radius: var(--app-radius-sm); }
.registry-discovery { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px solid var(--app-border); }
.registry-discovery-heading, .registry-discovery-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.registry-discovery-heading > div, .registry-discovery-row > div { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.registry-discovery-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.registry-discovery-row { padding: 7px 8px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); }
</style>
