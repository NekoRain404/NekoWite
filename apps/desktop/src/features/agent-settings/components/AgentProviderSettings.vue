<script lang="ts">
/**
 * The provider section's copy: the keys a caller may replace, and the catalogue it defaults to.
 *
 * The sentences are in `src/i18n/namespaces/agent.ts` (`agent.settings.provider.*`), beside the panel's
 * and the registry page's — a translated build is a catalogue edit rather than a second place to
 * look. What stays here is the *shape* (the keys a caller may replace through the `labels` prop) and
 * the builder that reads the catalogue into it, because a page that reached for `t()` at every use
 * site could not be given a different set of sentences at all.
 *
 * The facts are *not* in here — a path, an environment variable and the engine's own words are
 * data, and data does not go through a translator.
 *
 * {@link AgentProviderLabels.changes} is keyed by `ModeChange`, so a change added to the policy
 * without a sentence here is a missing key rather than a line that goes blank.
 */
import { t } from '../../../i18n'
import type { ModeChange } from '../services/agent-settings-policy'

export interface AgentProviderLabels {
  section: { title: string; hint: string }
  loading: string
  unreadable: string
  retry: string
  identity: { agent: string; profile: string }
  /** Shown when the readout is not the pair this page believes it is showing. */
  mismatch: string
  mode: { label: string; appManaged: string; userConfig: string; readOnly: string }
  fields: { provider: string; modelId: string; empty: string }
  action: { save: string; applied: string; failed: string; unsaved: string }
  switchPlan: { title: string; movesNothing: string }
  changes: Record<ModeChange, string>
  sources: { title: string; hint: string; injected: string; engineDiscovery: string }
  credentials: {
    title: string
    hint: string
    none: string
    hostFile: string
    notEncrypted: string
    placeholder: string
  }
}

export function providerLabels(): AgentProviderLabels {
  return {
    section: {
      title: t('agent.settings.provider.section.title'),
      hint: t('agent.settings.provider.section.hint'),
    },
    loading: t('agent.settings.provider.loading'),
    unreadable: t('agent.settings.provider.unreadable'),
    retry: t('agent.settings.retry'),
    identity: {
      agent: t('agent.settings.provider.identity.agent'),
      profile: t('agent.settings.provider.identity.profile'),
    },
    mismatch: t('agent.settings.provider.mismatch'),
    mode: {
      label: t('agent.settings.provider.mode.label'),
      appManaged: t('agent.settings.provider.mode.appManaged'),
      userConfig: t('agent.settings.provider.mode.userConfig'),
      readOnly: t('agent.settings.provider.mode.readOnly'),
    },
    fields: {
      provider: t('agent.settings.provider.fields.provider'),
      modelId: t('agent.settings.provider.fields.modelId'),
      empty: t('agent.settings.provider.fields.empty'),
    },
    action: {
      save: t('agent.settings.provider.action.save'),
      applied: t('agent.settings.provider.action.applied'),
      failed: t('agent.settings.provider.action.failed'),
      unsaved: t('agent.settings.provider.action.unsaved'),
    },
    switchPlan: {
      title: t('agent.settings.provider.switchPlan.title'),
      movesNothing: t('agent.settings.provider.switchPlan.movesNothing'),
    },
    changes: {
      'roots-are-injected': t('agent.settings.provider.changes.roots-are-injected'),
      'roots-are-the-users': t('agent.settings.provider.changes.roots-are-the-users'),
      'host-starts-writing': t('agent.settings.provider.changes.host-starts-writing'),
      'host-stops-writing': t('agent.settings.provider.changes.host-stops-writing'),
      'credentials-move-to-the-engine': t('agent.settings.provider.changes.credentials-move-to-the-engine'),
    },
    sources: {
      title: t('agent.settings.provider.sources.title'),
      hint: t('agent.settings.provider.sources.hint'),
      injected: t('agent.settings.provider.sources.injected'),
      engineDiscovery: t('agent.settings.provider.sources.engineDiscovery'),
    },
    credentials: {
      title: t('agent.settings.provider.credentials.title'),
      hint: t('agent.settings.provider.credentials.hint'),
      none: t('agent.settings.provider.credentials.none'),
      hostFile: t('agent.settings.provider.credentials.hostFile'),
      notEncrypted: t('agent.settings.provider.credentials.notEncrypted'),
      placeholder: t('agent.settings.provider.credentials.placeholder'),
    },
  }
}

</script>

<script setup lang="ts">
/**
 * The provider section — §8.1, and the model half of §4.2.
 *
 * The acceptance clause this page carries is 「模型来源明确」, and it is met by drawing the *sources*
 * list rather than only the chosen values. A provider and a model id on their own are two strings a
 * user cannot act on: the same model can be in effect because this app wrote it, or because the
 * engine found a configuration file this app has never opened, and those two need different next
 * moves from the user. §8.1 states the requirement as 「列出实际生效源」 and names the mistake it
 * prevents — `OPENCODE_CONFIG_DIR` is not a complete isolation switch, so a page showing only the
 * injected roots would be describing a world with nothing else in it.
 *
 * Three rules come from the policy module rather than from here, and this page does not re-derive
 * any of them:
 *
 *  - **One rule, two enforcement points.** `profileProblem`, `planModeSwitch`, `decideProfileWrite`
 *    and `credentialRows` are `agent-settings-policy.ts`'s (T12), which mirrors `profile.rs`. The
 *    form asks that module what is allowed and sends only what it accepts; the backend decides again
 *    and its answer is the one that counts. A second set of rules here would be the drift that
 *    module exists to prevent.
 *  - **A credential's value is never on this page.** {@link credentialRows} replaces every value
 *    with a placeholder before anything renders, so there is no expression here that could print
 *    one even by accident.
 *  - **A mode switch moves nothing.** {@link planModeSwitch} has no word for a file operation, so
 *    the page cannot describe one; it states what changes and that no file moves.
 *
 * The write controls are absent when `readout.editable` is false, rather than present and refused:
 * a form that can only fail is a form whose failure the user has to discover by trying.
 */
import { computed, onMounted, reactive, ref } from 'vue'
import {
  credentialRows,
  decideProfileWrite,
  planModeSwitch,
  profileProblem,
  profileRefusalMessage,
  profileWrite,
  type AgentProfileReadout,
  type ConfigMode,
  type ProfileUpdate,
  type ProfileWrite,
} from '../services/agent-settings-policy'

/** The backend, chosen at the composition site. */
export interface AgentProviderClient {
  read(agentId: string, profileId: string): Promise<AgentProfileReadout>
  write(write: ProfileWrite): Promise<ProfileUpdate>
}

const props = defineProps<{
  client: AgentProviderClient
  /** The engine this page is showing a profile for. */
  agentId: string
  /** The profile, chosen by the caller (T12's decision, not this page's). */
  profileId: string
  labels?: AgentProviderLabels
}>()

const labels = computed<AgentProviderLabels>(() => props.labels ?? providerLabels())
const readout = ref<AgentProfileReadout | null>(null)
const state = ref<'loading' | 'ready' | 'unreadable'>('loading')
const busy = ref(false)
const outcome = ref<ProfileUpdate | null>(null)
const sendFailed = ref(false)
const dirty = ref(false)
const form = reactive<{ mode: ConfigMode; provider: string; modelId: string }>({
  mode: 'app-managed',
  provider: '',
  modelId: '',
})

/** The readout is only the pair this page believes it is showing; a mismatch is why it is not. */
const mismatch = computed(() =>
  readout.value === null ? null : profileProblem(readout.value, props.agentId, props.profileId),
)

const rows = computed(() => (readout.value === null ? [] : credentialRows(readout.value)))

/** What the user picked, as the record the policy takes — with blanks read as "nothing chosen". */
function fields(): { mode: ConfigMode; provider: string | null; modelId: string | null } {
  const trimmed = (value: string): string | null => (value.trim() === '' ? null : value.trim())
  return { mode: form.mode, provider: trimmed(form.provider), modelId: trimmed(form.modelId) }
}

/** The pre-flight: whatever the policy refuses is shown without a round trip. */
const refused = computed(() =>
  readout.value === null
    ? null
    : decideProfileWrite(readout.value, profileWrite(readout.value, fields())),
)

const switchChanges = computed(() => {
  if (readout.value === null || readout.value.mode === form.mode) return []
  return planModeSwitch(readout.value.mode, form.mode).changes
})

function rebuild(value: AgentProfileReadout): void {
  readout.value = value
  form.mode = value.mode
  form.provider = value.provider ?? ''
  form.modelId = value.modelId ?? ''
  dirty.value = false
}

async function load(): Promise<void> {
  state.value = 'loading'
  outcome.value = null
  try {
    rebuild(await props.client.read(props.agentId, props.profileId))
    state.value = 'ready'
  } catch {
    state.value = 'unreadable'
  }
}

async function save(): Promise<void> {
  if (readout.value === null) return
  const decided = refused.value
  // A refusal or a conflict is answered here, from the same rules the backend applies: sending it
  // anyway would only produce a second, later refusal of the same thing.
  if (decided !== null && decided.status !== 'applied') {
    outcome.value = decided
    if (decided.status === 'conflict') rebuild(decided.current)
    return
  }
  busy.value = true
  sendFailed.value = false
  try {
    const answered = await props.client.write(
      profileWrite(readout.value, fields()),
    )
    outcome.value = answered
    if (answered.status === 'applied') {
      rebuild({ ...readout.value, ...answered.fields })
    } else if (answered.status === 'conflict') {
      // Someone else's write landed first. The readout is replaced rather than merged, because a
      // merge is how a value the user changed elsewhere gets undone.
      rebuild(answered.current)
    }
  } catch {
    sendFailed.value = true
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="settings-section provider">
    <span class="settings-label">{{ labels.section.title }}</span>
    <span class="settings-note">{{ labels.section.hint }}</span>

    <span v-if="state === 'loading'" class="settings-note" data-test="provider-loading">
      {{ labels.loading }}
    </span>
    <template v-else-if="state === 'unreadable'">
      <span class="settings-note is-error" data-test="provider-unreadable">{{ labels.unreadable }}</span>
      <button type="button" class="provider-button" data-test="provider-retry" @click="load">
        {{ labels.retry }}
      </button>
    </template>

    <!-- A readout for another pair is not shown at all: rendering one engine's provider and
         credential names under another engine's heading is the confusion §3.4's Profile row
         exists to prevent. -->
    <span v-else-if="mismatch" class="settings-note is-error" data-test="provider-mismatch">
      {{ labels.mismatch }}
    </span>

    <template v-else-if="readout">
      <span class="settings-note" data-test="provider-identity">
        {{ labels.identity.agent }}: {{ readout.agentId }} — {{ labels.identity.profile }}:
        {{ readout.profileId }}
      </span>

      <span class="settings-note provider-mode" data-test="provider-mode">
        {{ labels.mode.label }}:
        {{ readout.mode === 'app-managed' ? labels.mode.appManaged : labels.mode.userConfig }}
      </span>

      <label class="settings-field">
        <span>{{ labels.fields.provider }}</span>
        <input
          v-model="form.provider"
          class="provider-input"
          :disabled="!readout.editable"
          data-test="provider-field-provider"
          @input="dirty = true"
        >
        <span class="settings-note">{{ readout.provider ?? labels.fields.empty }}</span>
      </label>
      <label class="settings-field">
        <span>{{ labels.fields.modelId }}</span>
        <input
          v-model="form.modelId"
          class="provider-input"
          :disabled="!readout.editable"
          data-test="provider-field-model"
          @input="dirty = true"
        >
        <span class="settings-note">{{ readout.modelId ?? labels.fields.empty }}</span>
      </label>
      <label class="settings-field">
        <span>{{ labels.mode.label }}</span>
        <select
          v-model="form.mode"
          class="provider-input"
          :disabled="!readout.editable"
          data-test="provider-field-mode"
          @change="dirty = true"
        >
          <option value="app-managed">{{ labels.mode.appManaged }}</option>
          <option value="user-config">{{ labels.mode.userConfig }}</option>
        </select>
      </label>

      <!-- The plan, drawn before the save, and never as a file operation: the policy's type has no
           word for one. -->
      <div v-if="switchChanges.length > 0" class="provider-plan" data-test="provider-switch-plan">
        <span class="settings-label">{{ labels.switchPlan.title }}</span>
        <span v-for="change in switchChanges" :key="change" class="settings-note">- {{ labels.changes[change] }}</span>
        <span class="settings-note is-warn">{{ labels.switchPlan.movesNothing }}</span>
      </div>

      <p v-if="!readout.editable" class="settings-note" data-test="provider-read-only">
        {{ labels.mode.readOnly }}
      </p>
      <div v-else class="provider-actions">
        <button
          type="button"
          class="provider-button"
          :disabled="busy || refused?.status !== 'applied'"
          data-test="provider-save"
          @click="save"
        >
          {{ labels.action.save }}
        </button>
        <span v-if="dirty" class="settings-note" data-test="provider-unsaved">{{ labels.action.unsaved }}</span>
        <span v-if="outcome?.status === 'applied'" class="settings-note provider-ok" data-test="provider-applied">
          {{ labels.action.applied }}
        </span>
        <span v-else-if="outcome?.status === 'refused'" class="settings-note is-error" data-test="provider-refused">
          {{ profileRefusalMessage(outcome.reason) }}
        </span>
        <span v-else-if="outcome?.status === 'conflict'" class="settings-note is-error" data-test="provider-conflict">
          {{ labels.action.unsaved }}
        </span>
        <span v-if="sendFailed" class="settings-note is-error" data-test="provider-failed">
          {{ labels.action.failed }}
        </span>
      </div>

      <div class="provider-sources">
        <span class="settings-label">{{ labels.sources.title }}</span>
        <span class="settings-note">{{ labels.sources.hint }}</span>
        <ul class="provider-rows">
          <li
            v-for="(source, index) in readout.sources"
            :key="index"
            class="provider-row"
            :data-test="`provider-source-${source.kind}`"
          >
            <span class="settings-note provider-origin">
              {{ source.kind === 'injected' ? labels.sources.injected : labels.sources.engineDiscovery }}
            </span>
            <span v-if="source.kind === 'injected'" class="provider-path">
              {{ source.variable }} = {{ source.path }}
            </span>
            <span v-else class="settings-note">{{ source.what }}</span>
          </li>
        </ul>
      </div>

      <div class="provider-credentials">
        <span class="settings-label">{{ labels.credentials.title }}</span>
        <span class="settings-note">{{ labels.credentials.hint }}</span>
        <span v-if="rows.length === 0" class="settings-note" data-test="provider-no-credentials">
          {{ labels.credentials.none }}
        </span>
        <ul v-else class="provider-rows">
          <li v-for="row in rows" :key="row.name" class="provider-row" :data-test="`provider-credential-${row.name}`">
            <span class="provider-path">{{ row.name }}</span>
            <span class="settings-note">
              {{ row.value === '' ? labels.credentials.none : labels.credentials.placeholder }}
            </span>
          </li>
        </ul>
        <span
          v-if="readout.credentialStorage.kind === 'host-file'"
          class="settings-note provider-path"
          data-test="provider-credential-storage"
        >
          {{ labels.credentials.hostFile }} {{ readout.credentialStorage.path }}
          ({{ readout.credentialStorage.mode }})
        </span>
        <span
          v-if="readout.credentialStorage.kind === 'host-file'"
          class="settings-note is-warn"
          data-test="provider-credential-warning"
        >
          {{ labels.credentials.notEncrypted }}
        </span>
      </div>
    </template>
  </section>
</template>

<style scoped>
.settings-section { display: flex; flex-direction: column; gap: 8px; }
.settings-label { margin-top: 6px; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; color: var(--app-muted); }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.settings-note.is-warn { color: var(--app-warn); }
.settings-note.is-error { color: var(--app-danger); }
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.settings-field > span:first-child { color: var(--app-muted); font-size: 11px; }
.provider-input { font: inherit; font-size: 12px; padding: 4px 6px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); color: var(--app-text); }
.provider-plan, .provider-sources, .provider-credentials { display: flex; flex-direction: column; gap: 4px; padding-top: 8px; border-top: 1px solid var(--app-border); }
.provider-rows { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.provider-row { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); }
.provider-origin { color: var(--app-text); }
.provider-path { font-family: var(--app-mono-font); font-size: 11px; color: var(--app-text); overflow-wrap: anywhere; }
.provider-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.provider-ok { color: var(--app-accent); }
.provider-button { align-self: flex-start; font: inherit; font-size: 11px; padding: 4px 10px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-accent); color: var(--app-accent-contrast); cursor: pointer; }
.provider-button:disabled { opacity: 0.5; cursor: default; }
</style>
