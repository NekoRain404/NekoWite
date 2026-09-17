<script lang="ts">
/**
 * The compatibility surface for this section's copy: the shape and the builder that reads the
 * catalogue now live in `agent-registry-labels.ts`, and the type is re-exported here.
 *
 * The re-export is not decoration. The specifier callers already name is *this file* — a caller that
 * imports this component and wants the shape of its `labels` prop names `AgentRegistrySettings.vue`
 * — and an SFC's named type exports are what such a specifier resolves against. A split keeps the
 * old path working: moving the definition is a change to where the copy lives, while moving the name
 * a caller imports would be a change to the caller.
 */
export type { AgentRegistryLabels } from './agent-registry-labels'
</script>

<script setup lang="ts">
/**
 * The optional external-agent settings: what is registered, what may be added, what failed, and
 * which engine a *new* session starts on.
 *
 * Three rules shape it, and each is the reason a line below is where it is:
 *
 *  - **The backend is authoritative, and this page has no second opinion.** Every decision is a
 *    call into `agent-registry-policy.ts`, which mirrors `registry.rs`: the page never checks
 *    whether a file is there, and never decides that an entry may be switched off — it asks
 *    {@link disableStanding} so a control that can only fail is not offered, and the backend
 *    refuses again anyway.
 *  - **A refusal is said, not summarised.** {@link refusalText} renders the backend's own kind and
 *    facts through the copy tree, so "no file there", "no executable bit" and "the handshake was
 *    refused" stay three answers on screen. There is no "could not add this agent" arm.
 *  - **Nothing here acts on a version, and nothing here opens a session.** The page states, per
 *    provenance, whether the app may replace a program or may only report on it; replacing one is
 *    `binary_registry`/`update` (T14). Choosing another engine emits, and the caller — which owns
 *    the gateway — starts the new session (§3.4.2: the old session keeps its engine, authorization
 *    and history).
 *
 * The session's engine arrives as a prop rather than being read from the panel's feature: this is
 * a settings section, and two features reach each other through their public entry points rather
 * than into their working parts (§13.11). The caller supplies the profile a new session would use
 * (T12's choice) and performs the switch (T16 wires the entry point).
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  disableStanding, fillTemplate, planEngineSwitch, readEnvForDisplay, refusedField, updateStanding, validateAgentDraft,
  type AgentDraft, type AgentRegistryClient, type AgentRegistryEntry, type AgentRegistryReadout, type DraftField, type RegistryRefusal,
} from '../services/agent-registry-policy'
import { registryLabels, type AgentRegistryLabels } from './agent-registry-labels'

const props = withDefaults(
  defineProps<{
    /** The backend, chosen at the composition site. */
    client: AgentRegistryClient
    /** The profile a new session would use; this page only reads which agent owns it. */
    profileId: string
    /** The engine the open session is on, or null when nothing is open. */
    sessionAgentId?: string | null
    /**
     * Whether this caller can open a session on the engine the user picks.
     *
     * The page's contract is that its caller owns the gateway — §3.4.2's switch *is* a new session
     * rather than a re-pointed one, so the page states the plan and the caller carries it out. The
     * settings dialog is not such a caller: it has no gateway, and `agent_start` takes a vault and
     * nothing else, so nothing in this app opens a session on a chosen engine today. Told `false`,
     * the page draws the facts it has and no control whose click nothing answers — the rule that
     * keeps a disabled switch off this tree.
     *
     * It defaults to `true` because that is the contract the page was written against: a caller
     * that owns a gateway says nothing and gets the switch (T13a's E4 mounts it that way), and a
     * caller that cannot act must say so rather than be assumed.
     */
    canStartSession?: boolean
    /**
     * An entry the catalogue browser chose, to fill the add form with.
     *
     * The catalogue's one control means "register this one", and it holds no `add` of its own: the
     * form is this page's, and duplicating it there would be two places a draft can be submitted
     * from. So the choice arrives as a value, and a `watch` writes it into the form — the form
     * stays the single source of what would be submitted, and a prefill is a prefill rather than a
     * second submit path.
     *
     * `args` is an **array** here and a newline-joined string in the form, which is the conversion
     * this prop exists to do: §3.4.3 forbids a command line, and a program and its arguments are
     * two facts that a `join` on this side would fuse.
     */
    prefill?: { agentId: string; displayName: string; program: string; args: readonly string[] } | null
    labels?: AgentRegistryLabels
  }>(),
  { sessionAgentId: null, canStartSession: true, prefill: null },
)

const emit = defineEmits<{ (event: 'new-session', agentId: string): void }>()

const labels = computed<AgentRegistryLabels>(() => props.labels ?? registryLabels())
const readout = ref<AgentRegistryReadout | null>(null)
const loadState = ref<'loading' | 'ready' | 'unreadable'>('loading')
const entries = computed(() => readout.value?.entries ?? [])
const rowRefusals = reactive<Record<string, RegistryRefusal | null>>({})
/** The entry being changed, or 'add': one action at a time, so a double submit cannot race. */
const busy = ref<string | null>(null)
const actionFailed = ref(false)

const form = reactive({ agentId: '', displayName: '', program: '', args: '', adapterId: '' })
const edited = reactive<Record<DraftField, boolean>>({ agentId: false, displayName: false, program: false, args: false, adapterId: false })
const submitted = ref(false)
const addRefusal = ref<RegistryRefusal | null>(null)
const addedAgentId = ref<string | null>(null)

/** One argument per line, so an argument containing spaces stays one argument (§3.4.3). */
const draft = computed<AgentDraft>(() => ({
  agentId: form.agentId.trim(),
  displayName: form.displayName.trim(),
  program: form.program.trim(),
  args: form.args.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line !== ''),
  adapterId: form.adapterId,
}))

/**
 * What the form refuses before the round trip.
 *
 * Empty until the registry has been read: two of these rules are about the *readout* (which
 * adapters exist, which ids are taken), and judging a draft against an empty one would refuse
 * every adapter id while the page is still loading.
 */
const problems = computed<RegistryRefusal[]>(() => {
  if (loadState.value !== 'ready' || readout.value === null) return []
  return validateAgentDraft(draft.value, {
    adapterIds: readout.value.adapterIds,
    entries: readout.value.entries,
  })
})

/** A field's problem, once the user has touched it or tried to submit — never before. */
function problem(field: DraftField): RegistryRefusal | null {
  if (!submitted.value && !edited[field]) return null
  return problems.value.find((refusal) => refusedField(refusal) === field) ?? null
}

async function load(): Promise<void> {
  loadState.value = 'loading'
  try {
    readout.value = await props.client.read()
    loadState.value = 'ready'
  } catch {
    // A rejection is the call not completing — a different thing from a refusal, which comes back
    // as data. Saying "no agents are registered" here would be a lie about the backend.
    loadState.value = 'unreadable'
  }
}

async function submit(): Promise<void> {
  submitted.value = true
  addRefusal.value = null
  addedAgentId.value = null
  actionFailed.value = false
  if (problems.value.length > 0) return
  busy.value = 'add'
  try {
    const refusal = await props.client.add(draft.value)
    if (refusal !== null) {
      addRefusal.value = refusal
      return
    }
  } catch {
    actionFailed.value = true
    return
  } finally {
    busy.value = null
  }
  addedAgentId.value = draft.value.agentId
  Object.assign(form, { agentId: '', displayName: '', program: '', args: '', adapterId: '' })
  for (const field of Object.keys(edited) as DraftField[]) edited[field] = false
  submitted.value = false
  await load()
}

async function toggle(entry: AgentRegistryEntry, event: Event): Promise<void> {
  // The checkbox is left to the browser while the call is in flight: a click flips `checked`, and
  // Vue only writes the property when the *vnode's* value changes. A refusal leaves the readout
  // identical, so without the write-back below the box would keep showing a state the backend did
  // not accept — the one place this page must not look like it succeeded.
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
  } catch {
    input.checked = entry.enabled
    actionFailed.value = true
    return
  } finally {
    busy.value = null
  }
  await load()
}

/** The disable direction's preconditions, so a control that could only be refused is not offered. */
function blocked(entry: AgentRegistryEntry): RegistryRefusal | null {
  if (readout.value === null) return null
  const standing = disableStanding(entry, readout.value)
  return standing.allowed ? null : standing.refusal
}

const selectedEngine = ref('')
const selectable = computed(() => entries.value.filter((entry) => entry.enabled))
const nameOf = (agentId: string): string =>
  entries.value.find((entry) => entry.agentId === agentId)?.displayName || agentId

/**
 * A choice made in the catalogue browser, written into the add form.
 *
 * Not `immediate`: a prefill that has not happened is `null`, and running this on mount would clear
 * a form nobody had touched. The `edited` flags are set with it because a prefilled field *is* the
 * user's — `refusedField` uses them to decide whether a refusal belongs beside a field, and a value
 * the user chose from the catalogue is as much their input as one they typed.
 */
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

/** Every refusal the page draws, in one place: the backend's kind and facts, the page's sentence. */
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

onMounted(load)
</script>

<template>
  <section class="settings-section registry">
    <span class="settings-label">{{ labels.section.title }}</span>
    <span class="settings-note">{{ labels.section.hint }}</span>

    <span v-if="loadState === 'loading'" class="settings-note" data-test="registry-loading">{{ labels.list.loading }}</span>
    <template v-else-if="loadState === 'unreadable'">
      <span class="settings-note is-error" data-test="registry-unreadable">{{ labels.list.unreadable }}</span>
      <button type="button" class="registry-button" data-test="registry-retry" @click="load">{{ labels.list.retry }}</button>
    </template>

    <template v-else>
      <span v-if="entries.length === 0" class="settings-note" data-test="registry-empty">{{ labels.list.empty }}</span>
      <ul class="registry-rows">
        <li v-for="entry in entries" :key="entry.agentId" class="registry-row" :data-test="`registry-row-${entry.agentId}`">
          <div class="registry-head">
            <span class="registry-name">{{ entry.displayName || entry.agentId }}</span>
            <span class="registry-badge registry-source">{{ labels.provenance[entry.source] }}</span>
          </div>
          <span class="registry-program">{{ entry.program }}</span>
          <span v-if="entry.args.length > 0" class="registry-args">
            <code v-for="(arg, index) in entry.args" :key="index">{{ arg }}</code>
          </span>
          <span v-if="entry.envExtra.length > 0" class="registry-args registry-env">
            <code v-for="variable in readEnvForDisplay(entry.envExtra)" :key="variable.name">{{ variable.name }}={{ variable.value }}</code>
          </span>
          <span class="settings-note registry-adapter">{{ labels.list.adapter }}: {{ entry.adapterId }}</span>
          <span class="settings-note registry-version">{{ versionText(entry) }}</span>
          <span class="settings-note registry-update">{{ labels.update[updateStanding(entry.source)] }}</span>
          <span class="settings-note registry-state" :class="{ 'is-warn': entry.programState !== 'launchable' }">
            {{ fillTemplate(labels.programState[entry.programState], { path: entry.program }) }}
          </span>
          <!-- Always drawn, whatever the state is and whatever an add just did: see `standing`. -->
          <span class="settings-note registry-standing">{{ labels.standing[entry.source] }}</span>
          <span v-if="rowRefusals[entry.agentId]" class="settings-note is-error registry-refusal">{{ refusalText(rowRefusals[entry.agentId]) }}</span>
          <label class="settings-field settings-toggle">
            <span>{{ entry.enabled ? labels.control.disable : labels.control.enable }}</span>
            <input
              type="checkbox"
              class="checkbox"
              :checked="entry.enabled"
              :disabled="blocked(entry) !== null"
              :data-test="`registry-toggle-${entry.agentId}`"
              @change="toggle(entry, $event)"
            >
          </label>
          <span v-if="blocked(entry)" class="settings-note registry-blocked">{{ refusalText(blocked(entry)) }}</span>
        </li>
      </ul>

      <form class="registry-form" @submit.prevent="submit">
        <span class="settings-label">{{ labels.add.title }}</span>
        <label class="settings-field">
          <span>{{ labels.fields.agentId }}</span>
          <input
            v-model="form.agentId"
            class="registry-input"
            data-test="registry-field-agentId"
            @input="edited.agentId = true"
          >
          <span v-if="problem('agentId')" class="settings-note is-error" data-test="registry-problem-agentId">{{ refusalText(problem('agentId')) }}</span>
        </label>
        <label class="settings-field">
          <span>{{ labels.fields.displayName }}</span>
          <input
            v-model="form.displayName"
            class="registry-input"
            data-test="registry-field-displayName"
            @input="edited.displayName = true"
          >
        </label>
        <label class="settings-field">
          <span>{{ labels.fields.program }}</span>
          <input
            v-model="form.program"
            class="registry-input"
            data-test="registry-field-program"
            @input="edited.program = true"
          >
          <span v-if="problem('program')" class="settings-note is-error" data-test="registry-problem-program">{{ refusalText(problem('program')) }}</span>
        </label>
        <label class="settings-field">
          <span>{{ labels.fields.args }}</span>
          <textarea
            v-model="form.args"
            class="registry-input registry-textarea"
            rows="3"
            data-test="registry-field-args"
            @input="edited.args = true"
          />
          <span class="settings-note">{{ labels.fields.argsHint }}</span>
          <span v-if="problem('args')" class="settings-note is-error" data-test="registry-problem-args">{{ refusalText(problem('args')) }}</span>
        </label>
        <label class="settings-field">
          <span>{{ labels.fields.adapter }}</span>
          <select
            v-model="form.adapterId"
            class="registry-input"
            data-test="registry-field-adapter"
            @change="edited.adapterId = true"
          >
            <option value="">
              —
            </option>
            <option v-for="adapterId in readout?.adapterIds ?? []" :key="adapterId" :value="adapterId">{{ adapterId }}</option>
          </select>
          <span v-if="problem('adapterId')" class="settings-note is-error" data-test="registry-problem-adapterId">{{ refusalText(problem('adapterId')) }}</span>
        </label>
        <div class="registry-actions">
          <button type="submit" class="registry-button" data-test="registry-add" :disabled="busy === 'add'">{{ labels.add.submit }}</button>
          <span v-if="addedAgentId" class="settings-note registry-added" data-test="registry-added">{{ fillTemplate(labels.add.added, { agentId: addedAgentId }) }}</span>
          <span v-if="actionFailed" class="settings-note is-error registry-failed" data-test="registry-action-failed">{{ labels.action.failed }}</span>
        </div>
        <span v-if="addRefusal" class="settings-note is-error registry-refusal" data-test="registry-add-refusal">{{ refusalText(addRefusal) }}</span>
      </form>

      <div class="registry-engine">
        <span class="settings-label">{{ labels.engine.title }}</span>
        <span class="settings-note registry-engine-current" data-test="registry-engine-current">
          {{ sessionAgentId === null ? labels.engine.none : fillTemplate(labels.engine.current, { engine: nameOf(sessionAgentId) }) }}
        </span>
        <!-- Said, not drawn, when the caller has no gateway: a select whose choice nothing carries
             out and a button that emits to nobody are the controls this page refuses to show. -->
        <span v-if="!canStartSession" class="settings-note" data-test="registry-engine-elsewhere">
          {{ labels.engine.elsewhere }}
        </span>
        <template v-else>
          <label class="settings-field">
            <span>{{ labels.engine.choose }}</span>
            <select v-model="selectedEngine" class="registry-input" data-test="registry-engine-select">
              <option v-for="entry in selectable" :key="entry.agentId" :value="entry.agentId">{{ entry.displayName || entry.agentId }}</option>
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
.settings-toggle { flex-direction: row; align-items: center; justify-content: space-between; gap: 8px; }
.registry-rows { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
/* One row per registration: a card, because a definition is several facts that belong together and
   the switch at its foot is about the entry above it. */
.registry-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-elevated);
}
.registry-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.registry-name { font-size: 12px; font-weight: 600; color: var(--app-text); }
.registry-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--app-border); color: var(--app-muted); white-space: nowrap; }
.registry-program { font-family: var(--app-mono-font); font-size: 11px; color: var(--app-text); overflow-wrap: anywhere; }
/* Chips, not a joined line: an argument is one element of an array, and a space inside it is part
   of it — the row must not draw what §3.4.3 forbids ever being built. */
.registry-args { display: flex; flex-wrap: wrap; gap: 4px; }
.registry-args code { font-family: var(--app-mono-font); font-size: 11px; padding: 1px 5px; border-radius: var(--app-radius-sm); background: var(--app-panel); color: var(--app-text); }
.registry-form, .registry-engine { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--app-border); }
.registry-input { font: inherit; font-size: 12px; padding: 4px 6px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); color: var(--app-text); }
.registry-textarea { font-family: var(--app-mono-font); resize: vertical; }
.registry-actions { display: flex; align-items: center; gap: 8px; }
.registry-button { align-self: flex-start; font: inherit; font-size: 11px; padding: 4px 10px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-accent); color: var(--app-accent-contrast); cursor: pointer; }
.registry-button:disabled { opacity: 0.5; cursor: default; }
</style>
