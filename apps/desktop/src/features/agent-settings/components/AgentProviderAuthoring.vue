<script setup lang="ts">
/**
 * The provider form: the fields the engine's provider block is built from, and the two calls a save
 * makes.
 *
 * ## What this exists for
 *
 * Until this landed, adding a provider to the bundled engine meant hand-writing a nested structure
 * into the member editor below — an `<input>` for `provider` and a `<textarea>` holding
 * `{"<id>":{"npm":…,"options":{…},"models":{…}}}`, in JSONC, from memory. This is the same operation
 * with the nest spelled out as fields, and it is the shape §8.1's 「结构化编辑器」 asks for over the
 * one member a raw editor is genuinely bad at.
 *
 * ## What it writes, and where every value goes
 *
 * Three destinations, and none of them is the document for the key:
 *
 *  - **the document**, one member, `provider.<id>`, spliced — plus the `provider` group itself when
 *    the document has none, through the backend's `if_absent` arm, which leaves a group the user
 *    already has byte for byte. `agent-provider-block.ts` builds the value; the rules about which ids
 *    and which names are legal live there too, so the form and the write cannot disagree about them.
 *  - **the profile's credential file**, through `agent_credentials_write`, for the key — and only when
 *    the field holds one. The block carries `{env:NWK_<ID>_API_KEY}` and never a value.
 *  - **nowhere else.** The key is a draft in this component: it is handed to the client and dropped,
 *    it is cleared from the field once a save lands, and no sentence, log or preview here renders it.
 *    The preview is built by the same function that builds the block, and the block has a reference in
 *    it rather than a key.
 *
 * ## Order, and why the key goes first
 *
 * A credential with no block pointing at it is invisible and harmless; a block pointing at a variable
 * nothing sets is an engine that fails authentication on its first request with a message about the
 * provider. So the credential write happens first and a failure there stops the save outright. A
 * document that then conflicts leaves the credential behind — deliberately: the next save re-writes
 * it, and the alternative is a block that names a key that was never stored.
 *
 * ## 「获取模型」, and what it does not do
 *
 * It fills the list below with the ids the endpoint reports, ticked. It writes nothing: the models
 * reach the document when the user saves, as the `models` member the engine addresses them by — the
 * engine can only use a model this block declares, so a list that stayed on screen would be a
 * control whose visible result the engine cannot see. Every failure leaves the fields alone and says
 * what happened, including the one the user cannot see: an empty key field is refused *before* a
 * request, because the command would otherwise fill it in with the key this app has stored for its
 * own AI and answer about a credential the engine never uses.
 */
import { computed, reactive, ref } from 'vue'

import {
  modelDisplayName,
  providerBlock,
  providerCredentialName,
  providerDraftProblem,
  providerEdits,
  type ProviderDraft,
  type ProviderModel,
} from '../services/agent-provider-block'
import type { AgentProviderAuthoringClient } from '../services/agent-provider-authoring'
import {
  decideConfigWrite,
  type ConfigRead,
} from '../services/agent-settings-policy'
import type { AgentConfigClient } from '../services/agent-config-ipc'
import {
  providerAuthoringLabels,
  type AgentProviderAuthoringLabels,
} from './agent-provider-authoring-labels'

/** One row of the model list: what the endpoint listed, or what the user typed. */
interface ModelRow extends ProviderModel {
  checked: boolean
  /** `listed` rows are replaced by a fetch; `typed` ones are not. */
  source: 'listed' | 'typed'
}

const props = defineProps<{
  /** The document's client, bound to the same pair this page is showing. */
  client: AgentConfigClient
  /** The model fetch and the credential write, bound to the same pair. */
  authoring: AgentProviderAuthoringClient
  /** The document as this page last read it — the revision a save is built on. */
  document: ConfigRead
  labels?: AgentProviderAuthoringLabels
}>()

const emit = defineEmits<{
  /** A write landed, or the file moved: the page re-reads, which is what refreshes this form's
      `document` prop and so the revision the next save will carry. */
  (e: 'reload'): void
}>()

const labels = computed<AgentProviderAuthoringLabels>(
  () => props.labels ?? providerAuthoringLabels(),
)

const form = reactive({ id: '', name: '', baseUrl: '', apiKey: '', allowPrivate: false })
const rows = ref<ModelRow[]>([])
const manual = ref('')

const busy = ref(false)
const fetching = ref(false)
/** The fetch's own state, kept apart from the save's: a failed fetch is not a failed save. */
const fetchState = ref<'idle' | 'loading' | 'ok' | 'need-key' | 'failed'>('idle')
const fetchDetail = ref('')
const fetchedCount = ref(0)
const outcome = ref<'idle' | 'problem' | 'credential-failed' | 'failed' | 'applied' | 'conflict'>('idle')
const message = ref('')

/** The models that will be written: the rows the user ticked. */
const chosen = computed<ProviderModel[]>(() =>
  rows.value.filter((row) => row.checked).map((row) => ({ id: row.id, name: row.name })),
)

/** What a save would submit — the value of `provider.<id>`, and nothing else. */
const draft = computed<ProviderDraft>(() => ({
  id: form.id.trim(),
  name: form.name,
  baseUrl: form.baseUrl,
  apiKey: form.apiKey.trim(),
  models: chosen.value,
}))

/**
 * The block as it will be written.
 *
 * The same function the submission calls, so the preview and the write cannot say different things:
 * there is no second rendering of the value to drift from the first.
 */
const preview = computed(() => JSON.stringify(providerBlock(draft.value), null, 2))

/** The credential variable this provider's key will live under — shown, so the user can check it. */
const credentialName = computed(() =>
  form.id.trim() === '' ? '' : providerCredentialName(form.id),
)

/** A rejection's sentence, as Tauri sends it: a string, not an `Error`. */
function failureText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error !== '') return error
  if (error && typeof error === 'object') {
    const held = (error as { message?: unknown }).message
    if (typeof held === 'string' && held !== '') return held
  }
  return String(error)
}

/**
 * The list with a fetch's ids merged in.
 *
 * A row that is already there keeps its tick — re-fetching after a failed first attempt must not
 * clear a choice the user made — and rows the user typed are kept beside the listed ones, because a
 * fetch is not a statement about what the endpoint *has*; it is a listing of what it answered with.
 */
function merge(ids: readonly string[]): void {
  const ticked = new Set(rows.value.filter((row) => row.checked).map((row) => row.id))
  const typed = rows.value.filter((row) => row.source === 'typed')
  const listed: ModelRow[] = ids.map((id) => ({
    id,
    name: modelDisplayName(id),
    checked: true,
    source: 'listed',
  }))
  // An id the user typed and the endpoint also lists is one row, and the listed spelling wins: the
  // id the endpoint reports is the one the engine will be asked for.
  const listedIds = new Set(ids)
  rows.value = [...listed, ...typed.filter((row) => !listedIds.has(row.id))]
  for (const row of rows.value) {
    if (row.source === 'typed' && ticked.has(row.id)) row.checked = true
  }
}

async function fetchModels(): Promise<void> {
  if (fetching.value) return
  // Before the call, not after: the request would carry whatever the vault holds for this app's own
  // AI provider if the field were empty, and the answer would be a list about that credential.
  if (form.apiKey.trim() === '') {
    fetchState.value = 'need-key'
    fetchDetail.value = ''
    return
  }
  fetching.value = true
  fetchState.value = 'loading'
  fetchDetail.value = ''
  try {
    const ids = await props.authoring.fetchModels({
      baseUrl: form.baseUrl,
      apiKey: form.apiKey.trim(),
      allowPrivate: form.allowPrivate,
    })
    merge(ids)
    fetchedCount.value = ids.length
    fetchState.value = 'ok'
  } catch (error) {
    // The endpoint's failure, in the backend's own words — the URL policy's refusal, an HTTP status,
    // a body that was not a model list. Summarising it would lose the one thing the user can act on.
    fetchState.value = 'failed'
    fetchDetail.value = failureText(error)
  } finally {
    fetching.value = false
  }
}

function addTyped(): void {
  const id = manual.value.trim()
  if (id === '') return
  const existing = rows.value.find((row) => row.id === id)
  if (existing) {
    existing.checked = true
  } else {
    rows.value = [...rows.value, { id, name: modelDisplayName(id), checked: true, source: 'typed' }]
  }
  manual.value = ''
}

async function save(): Promise<void> {
  if (busy.value) return
  outcome.value = 'idle'
  message.value = ''
  const value = draft.value
  const problem = providerDraftProblem(value)
  if (problem !== null) {
    outcome.value = 'problem'
    message.value = problem
    return
  }
  const write = {
    path: props.document.path,
    revision: props.document.revision,
    edits: providerEdits(value),
  }
  // The same rule the backend applies, asked before anything is sent: a stale revision or a
  // document this host may not write is a refusal here rather than a round trip that does nothing.
  const decision = decideConfigWrite(props.document, write)
  if (decision.status === 'refused') {
    outcome.value = 'problem'
    message.value = decision.message
    return
  }
  if (decision.status === 'conflict') {
    outcome.value = 'conflict'
    emit('reload')
    return
  }
  busy.value = true
  try {
    if (value.apiKey !== '') {
      try {
        await props.authoring.setCredential(providerCredentialName(value.id), value.apiKey)
      } catch (error) {
        outcome.value = 'credential-failed'
        message.value = failureText(error)
        return
      }
    }
    const answer = await props.client.edit(write.path, write.revision, decision.edits)
    if (answer.status === 'conflict') {
      outcome.value = 'conflict'
    } else {
      outcome.value = 'applied'
      // The value is stored; a field still holding it would be a second copy of a credential on
      // screen for as long as the dialog is open.
      form.apiKey = ''
    }
    emit('reload')
  } catch (error) {
    outcome.value = 'failed'
    message.value = failureText(error)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="provider-authoring" data-test="provider-authoring">
    <span class="settings-label">{{ labels.title }}</span>
    <span class="settings-note">{{ labels.hint }}</span>

    <label class="settings-field">
      <span>{{ labels.id }}</span>
      <input v-model="form.id" class="config-input" data-test="provider-form-id">
      <span class="settings-note">
        {{ labels.idHint(credentialName || 'NWK_…_API_KEY') }}
      </span>
    </label>
    <label class="settings-field">
      <span>{{ labels.name }}</span>
      <input v-model="form.name" class="config-input" data-test="provider-form-name">
      <span class="settings-note">{{ labels.nameHint }}</span>
    </label>
    <label class="settings-field">
      <span>{{ labels.baseUrl }}</span>
      <input v-model="form.baseUrl" class="config-input" data-test="provider-form-base-url">
      <span class="settings-note">{{ labels.baseUrlHint }}</span>
    </label>
    <label class="settings-field">
      <span>{{ labels.key }}</span>
      <input
        v-model="form.apiKey"
        class="config-input"
        type="password"
        autocomplete="off"
        spellcheck="false"
        data-test="provider-form-api-key"
      >
      <span class="settings-note">{{ labels.keyHint }}</span>
      <span v-if="form.apiKey.trim() === ''" class="settings-note is-warn" data-test="provider-form-key-blank">
        {{ labels.keyBlank }}
      </span>
    </label>

    <label class="settings-field settings-toggle">
      <span>{{ labels.allowPrivate }}</span>
      <input
        v-model="form.allowPrivate"
        type="checkbox"
        class="checkbox"
        data-test="provider-form-allow-private"
      >
    </label>
    <span class="settings-note">{{ labels.allowPrivateHint }}</span>

    <div class="provider-authoring-actions">
      <button
        type="button"
        class="config-button"
        :disabled="fetching"
        data-test="provider-form-fetch"
        @click="fetchModels"
      >
        {{ fetching ? labels.fetching : labels.fetch }}
      </button>
      <span v-if="fetchState === 'ok'" class="settings-note" data-test="provider-form-fetched">
        {{ labels.fetched(fetchedCount) }}
      </span>
      <!-- The one refusal this form makes before a request, and it is not "a field is empty": it is
           what the command would have done with an empty field. -->
      <span v-if="fetchState === 'need-key'" class="settings-note is-warn" data-test="provider-form-fetch-needs-key">
        {{ labels.fetchNeedsKey }}
      </span>
      <span v-else-if="fetchState === 'failed'" class="settings-note is-error" data-test="provider-form-fetch-failed">
        {{ labels.fetchFailed }} {{ fetchDetail }}
      </span>
    </div>

    <span class="settings-label">{{ labels.models }}</span>
    <span v-if="rows.length === 0" class="settings-note" data-test="provider-form-models-empty">
      {{ labels.modelsEmpty }}
    </span>
    <ul v-else class="provider-form-models" data-test="provider-form-models">
      <li v-for="row in rows" :key="row.id" class="provider-model">
        <label class="settings-toggle">
          <input
            v-model="row.checked"
            type="checkbox"
            class="checkbox"
            :data-test="`provider-form-model-${row.id}`"
          >
          <span class="provider-model-name">{{ row.name }}</span>
        </label>
        <span class="provider-model-id">{{ row.id }}</span>
      </li>
    </ul>
    <span class="settings-note">{{ labels.modelHint }}</span>
    <div class="provider-authoring-actions">
      <input
        v-model="manual"
        class="config-input provider-manual"
        :placeholder="labels.manual"
        :aria-label="labels.manual"
        data-test="provider-form-manual"
        @keyup.enter.prevent="addTyped"
      >
      <button type="button" class="config-button" data-test="provider-form-manual-add" @click="addTyped">
        {{ labels.manualAdd }}
      </button>
    </div>

    <span class="settings-label">{{ labels.preview }}</span>
    <span class="settings-note">
      {{ labels.previewHint(form.id.trim() || '<id>') }}
    </span>
    <pre class="config-text" data-test="provider-form-preview">{{ preview }}</pre>

    <div class="provider-authoring-actions">
      <button
        type="button"
        class="config-button"
        :disabled="busy"
        data-test="provider-form-save"
        @click="save"
      >
        {{ labels.save }}
      </button>
      <!-- What the block edit is: a plain `set` of one member, so a provider the file already has
           under this id is replaced. Said where the button is, because it is a fact about the file
           the user is changing and not a detail of the form. -->
      <span class="settings-note" data-test="provider-form-replaces">{{ labels.replaces }}</span>
      <span v-if="outcome === 'applied'" class="settings-note config-ok" data-test="provider-form-applied">
        {{ labels.applied }}
      </span>
      <span v-else-if="outcome === 'conflict'" class="settings-note is-warn" data-test="provider-form-conflict">
        {{ labels.conflict }}
      </span>
      <span v-else-if="outcome === 'problem'" class="settings-note is-error" data-test="provider-form-problem">
        {{ labels.problem(message) }}
      </span>
      <span
        v-else-if="outcome === 'credential-failed'"
        class="settings-note is-error"
        data-test="provider-form-credential-failed"
      >
        {{ labels.credentialFailed(message) }}
      </span>
      <span v-else-if="outcome === 'failed'" class="settings-note is-error" data-test="provider-form-failed">
        {{ labels.editFailed(message) }}
      </span>
    </div>
  </div>
</template>

<style scoped>
/* Restated here for the reason every section restates them: a scoped block belongs to the component
   that renders the element. `.config-text` wears the document's own look so the preview reads as the
   fragment of the file it is rather than as prose. */
.settings-label { margin-top: 6px; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; color: var(--app-muted); }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.settings-note.is-warn { color: var(--app-warn); }
.settings-note.is-error { color: var(--app-danger); }
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.settings-field > span:first-child { color: var(--app-muted); font-size: 11px; }
.settings-toggle { flex-direction: row; align-items: center; gap: 6px; }
.config-input {
  font: inherit;
  font-size: 12px;
  padding: 4px 6px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-elevated);
  color: var(--app-text);
  font-family: var(--app-mono-font);
}
.config-text {
  max-height: 200px;
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  font-family: var(--app-mono-font);
  font-size: 11px;
  line-height: 1.5;
  color: var(--app-text);
  background: var(--app-elevated);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  white-space: pre;
}
.config-button {
  align-self: flex-start;
  font: inherit;
  font-size: 11px;
  padding: 4px 10px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-accent);
  color: var(--app-accent-contrast);
  cursor: pointer;
}
.config-button:disabled { opacity: 0.5; cursor: default; }
.config-ok { color: var(--app-accent); }
.provider-authoring { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; border-top: 1px solid var(--app-border); }
.provider-authoring-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.provider-models { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.provider-model { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; padding: 4px 6px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); }
.provider-model-name { font-size: 12px; color: var(--app-text); }
.provider-model-id { font-family: var(--app-mono-font); font-size: 11px; color: var(--app-muted); overflow-wrap: anywhere; }
.provider-manual { flex: 1 1 12rem; }
</style>
