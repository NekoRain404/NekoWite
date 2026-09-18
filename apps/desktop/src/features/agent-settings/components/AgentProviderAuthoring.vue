<script setup lang="ts">
/**
 * The provider form: the fields the engine's provider block is built from, and the calls a save
 * makes — two of them when the key moves, and one when it does not.
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
 *    already has byte for byte. `agent-provider-block.ts` builds the value, and the rules about ids
 *    and names live there too, so the form and the write cannot disagree about them.
 *  - **the profile's credential file**, through `agent_credentials_write`, for the key this save
 *    sets, replaces or removes. The block carries `{env:NWK_<ID>_API_KEY}` and never a value.
 *  - **nowhere else.** The key is a draft here: handed to the client, dropped, cleared from the
 *    field once a save lands. No sentence, log or preview renders it — the preview is the same
 *    function's output as the write, with a reference in it rather than a key.
 *
 * ## The blank field, and the two states it used to be read as one
 *
 * This form clears the draft once a save lands and never puts a stored value back, so blank is what
 * the user meets on *every* provider that has a key. Read as "no key", that wrote a block naming
 * none while the credential stayed in the file, and the engine then authenticated with nothing. So
 * the field does not answer the question — {@link stored} does: the profile's own credential
 * *names*, read at every save. A typed value and {@link removing} are the user's own answers and
 * outrank it, and nothing here guesses: a credential set that could not be read is a save that
 * writes nothing and says why.
 *
 * ## Order, and why it is not always the same order
 *
 * One invariant, stated in full at {@link providerWriteOrder}: **the block never names a key the
 * store does not hold.** A reference to a variable nothing sets is not a request without a key —
 * the engine substitutes an empty string, and the adapter then sends no `Authorization` header —
 * so it lands as an authentication error on the endpoint, with nothing here to read. A set
 * therefore stores the value first and stops if that fails, and a removal writes the block first
 * and leaves the credential alone if *that* fails: what a half-finished save may leave behind is a
 * credential no block points at — invisible and harmless — and never the other way round.
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
import { computed, onMounted, reactive, ref, watch } from 'vue'

import {
  addTypedModel,
  mergeListedModels,
  providerBlock,
  providerCredentialName,
  providerDraftProblem,
  providerEdits,
  providerKey,
  providerWriteOrder,
  type ModelRow,
  type ProviderDraft,
  type ProviderKey,
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

const props = defineProps<{
  /** The document's client, bound to the same pair this page is showing. */
  client: AgentConfigClient
  /**
   * Everything else a save needs, bound to the same pair: the endpoint's model list, the credential
   * a save sets or removes, and the names the profile stores — the answer this form cannot read off
   * its own field.
   */
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

/**
 * The credential *names* this profile stores, or `null` when they could not be read.
 *
 * `null` is not "none": it is the state this page refuses to write from, because both readings of
 * it are facts nobody established. Read on mount and again at every save — which is what makes the
 * second save of a form see the key the first one stored.
 */
const stored = ref<readonly string[] | null>(null)

/** Whether the user asked for the stored credential to go. Reset per id, and after a save. */
const removing = ref(false)

const busy = ref(false)
const fetching = ref(false)
/** The fetch's own state, kept apart from the save's: a failed fetch is not a failed save. */
const fetchState = ref<'idle' | 'loading' | 'ok' | 'need-key' | 'failed'>('idle')
const fetchDetail = ref('')
const fetchedCount = ref(0)
const outcome = ref<'idle' | 'problem' | 'credential-failed' | 'removal-failed' | 'failed' | 'applied' | 'conflict'>('idle')
const message = ref('')

/** The models that will be written: the rows the user ticked. */
const chosen = computed<ProviderModel[]>(() =>
  rows.value.filter((row) => row.checked).map((row) => ({ id: row.id, name: row.name })),
)

/** The credential variable this provider's key will live under — shown, so the user can check it. */
const credentialName = computed(() =>
  form.id.trim() === '' ? '' : providerCredentialName(form.id),
)

/** Whether the profile stores a key under that name; `null` while that is not known. */
const keyStored = computed<boolean | null>(() =>
  stored.value === null || credentialName.value === ''
    ? null
    : stored.value.includes(credentialName.value),
)

/** What this save does about the key. The precedence is `providerKey`'s, not a second one here. */
const key = computed<ProviderKey>(() =>
  providerKey({ field: form.apiKey, stored: keyStored.value, removing: removing.value }),
)

/**
 * The sentence under the key field, its tone, and the id a test drives it by.
 *
 * Four states, each a different next move: a value about to replace the stored one, a stored key
 * this block will keep naming, no key at all, and the one state where this page does not know —
 * which is a save that refuses rather than a guess. One table rather than four template branches,
 * so the tone and the id cannot drift from their sentence. `null` is the id nobody has typed yet,
 * where there is nothing to say about a credential that has no name.
 */
const keyNote = computed<{ test: string; tone: string; text: string } | null>(() => {
  if (form.apiKey.trim() !== '') {
    return { test: 'provider-form-key-typed', tone: '', text: labels.value.keyTyped }
  }
  if (credentialName.value === '') return null
  if (keyStored.value === true) {
    return removing.value
      ? {
          test: 'provider-form-key-removing',
          tone: 'is-warn',
          text: labels.value.keyRemoving(credentialName.value),
        }
      : {
          test: 'provider-form-key-stored',
          tone: '',
          text: labels.value.keyStored(credentialName.value),
        }
  }
  return keyStored.value === false
    ? { test: 'provider-form-key-none', tone: 'is-warn', text: labels.value.keyNone }
    : { test: 'provider-form-key-unread', tone: 'is-error', text: labels.value.keyUnread }
})

/** What a save would submit — the value of `provider.<id>`, and nothing else. */
const draft = computed<ProviderDraft>(() => ({
  id: form.id.trim(),
  name: form.name,
  baseUrl: form.baseUrl,
  key: key.value,
  models: chosen.value,
}))

/** Reads the credential names, and keeps the last answer's `null` when the read does not land. */
async function readStored(): Promise<void> {
  try {
    stored.value = await props.authoring.storedCredentials()
  } catch {
    stored.value = null
  }
}

// A different provider is a different credential, so a pending removal does not travel with the id.
watch(credentialName, () => {
  removing.value = false
})

onMounted(readStored)

/**
 * The block as it will be written.
 *
 * The same function the submission calls, so the preview and the write cannot say different things:
 * there is no second rendering of the value to drift from the first.
 */
const preview = computed(() => JSON.stringify(providerBlock(draft.value), null, 2))

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
    rows.value = mergeListedModels(rows.value, ids)
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
  rows.value = addTypedModel(rows.value, manual.value)
  manual.value = ''
}

async function save(): Promise<void> {
  if (busy.value) return
  outcome.value = 'idle'
  message.value = ''
  // The whole of a save is busy, the read included: a second press during it cannot start a second
  // one, and the store's answer — read *now* rather than as it was when this form mounted, because
  // both pages of this dialog are on screen at once and the credential can move next door — is what
  // the draft below is built from.
  busy.value = true
  try {
    await readStored()
    const value = draft.value
    const problem = providerDraftProblem(value)
    if (problem !== null) {
      outcome.value = 'problem'
      message.value = problem
      return
    }
    // The one state this page may not write from. Guessing here is the defect in either direction:
    // "no key" drops a reference the store still backs, "a key" writes one nothing backs — so the
    // save stops and says which read has to land first.
    if (value.key.kind === 'none' && keyStored.value === null) {
      outcome.value = 'problem'
      message.value = labels.value.keyUnread
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
    const order = providerWriteOrder(value.key)
    if (order === 'key-first' && value.key.kind === 'set') {
      try {
        await props.authoring.setCredential(providerCredentialName(value.id), value.key.value)
      } catch (error) {
        outcome.value = 'credential-failed'
        message.value = failureText(error)
        return
      }
      // The store moved, and the fact the next save is built on is what it holds now.
      await readStored()
    }
    const answer = await props.client.edit(write.path, write.revision, decision.edits)
    if (answer.status === 'conflict') {
      outcome.value = 'conflict'
    } else {
      if (order === 'key-last') {
        try {
          await props.authoring.removeCredential(providerCredentialName(value.id))
        } catch (error) {
          // The document half landed and the credential half did not, and that order is the one
          // that leaves a key nothing points at rather than a block pointing at nothing. Said as
          // what it is: the removal is still there to be asked for again, and the control for it
          // is still on screen because the credential is.
          outcome.value = 'removal-failed'
          message.value = failureText(error)
          emit('reload')
          return
        }
        await readStored()
      }
      outcome.value = 'applied'
      // The value is stored; a field still holding it would be a second copy of a credential on
      // screen for as long as the dialog is open.
      form.apiKey = ''
      removing.value = false
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
      <!-- What the field cannot say, and the table that decides it is `keyNote`'s. -->
      <span
        v-if="keyNote"
        class="settings-note"
        :class="keyNote.tone"
        :data-test="keyNote.test"
      >{{ keyNote.text }}</span>
      <!-- The one way a provider stops carrying a key, and it is a control rather than the meaning
           an untouched field would otherwise have had. Drawn where the key it is about is, and only
           where there is one to remove. -->
      <button
        v-if="keyStored === true"
        type="button"
        class="config-button provider-key-button"
        data-test="provider-form-key-remove"
        @click="removing = !removing"
      >
        {{ removing ? labels.keyKeep : labels.keyRemove }}
      </button>
      <!-- The state this page may not write from, and the gesture that ends it. -->
      <button
        v-if="keyStored === null && credentialName !== ''"
        type="button"
        class="config-button provider-key-button"
        data-test="provider-form-key-retry"
        @click="readStored"
      >
        {{ labels.keyRetry }}
      </button>
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
      <span
        v-else-if="outcome === 'removal-failed'"
        class="settings-note is-error"
        data-test="provider-form-removal-failed"
      >
        {{ labels.removalFailed(message) }}
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
/* The key's own two controls sit under the field they are about, and are narrow: they are about one
   member of the key's state, not about the provider the save button writes. */
.provider-key-button { align-self: flex-start; padding: 2px 8px; font-size: 10px; }
</style>
