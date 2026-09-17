<script setup lang="ts">
/**
 * The credential section — what a profile holds, and the control `agent_credentials_write` was
 * built for.
 *
 * The read half states the credential *names* and the storage they live in; the write half is the
 * form under it. Neither could be completed without the other: the command existed, was registered
 * in `lib.rs` and declared in `build.rs`'s manifest, and no window called it, so a profile whose
 * engine needed a new key could show the user the name of the key it wanted and offer nothing to
 * put there.
 *
 * It is one component rather than the read half on the page and the write half beside it, because
 * both are about the same list: the names the form's fields are built from are the names the rows
 * above it state, and two components would be two copies of one readout — the shape §8.1's
 * 「列出实际生效源」 exists to prevent one directory over.
 *
 * ## What it draws, and what it refuses to draw
 *
 * One field per credential the readout names — the backend's names, not a list invented here,
 * because which variables an engine reads is the adapter's answer (§3.4.5). Every field is
 * `type="password"`: the value being typed is a key, and it is masked on screen for the same
 * reason the AI section's own key field is. The field's placeholder is the *only* thing shown
 * about a stored value, and it is the placeholder — `credentialFields` replaces the readout's
 * value with it, so no path from the readout to this template renders a key.
 *
 * The form is drawn only when the profile is editable, exactly as the record's write controls are:
 * a form that can only be refused is a form whose refusal the user has to discover by trying.
 *
 * ## The two rules that keep the value from becoming the value-in-the-field
 *
 * `draft: null` means the user did not touch that field, and `credentialWrite` sends nothing for
 * it. That is what stops a form saved without an edit from re-submitting the placeholder as the
 * credential — which would replace a working key with the string `<redacted>` and surface much
 * later as an authentication failure. Clearing a field is `draft: ''`, which is a *value* the user
 * typed, and it means remove: an empty string sent as a value would store an empty credential,
 * which a provider rejects far less obviously.
 *
 * ## Where the value goes
 *
 * Into `client.write`'s argument, and nowhere else. The submission is built by the policy
 * (`credentialWrite`), the drafts are refs of this component rather than of any store, they are
 * replaced the moment a write answers, and nothing here logs, toasts or persists them. The value
 * the backend answers with is a readout whose credentials are names and the placeholder.
 */
import { computed, ref, watch } from 'vue'
import {
  credentialFields,
  credentialRows,
  type AgentProfileReadout,
  type CredentialField,
} from '../services/agent-settings-policy'
import type { AgentCredentialClient } from '../services/agent-credential-ipc'

/**
 * The sentences this section renders, built by the page that mounts it.
 *
 * Structural against `AgentProviderLabels.credentials` rather than imported from the page: the
 * page's labels are one object built in one place, and this is the slice of it this component
 * needs — a prop typed as the whole page's labels would be this component claiming to read
 * sentences it does not.
 */
export interface AgentCredentialLabels {
  title: string
  hint: string
  none: string
  hostFile: string
  notEncrypted: string
  placeholder: string
  form: {
    editHint: string
    save: string
    saved: string
    failed: string
  }
}

const props = defineProps<{
  client: AgentCredentialClient
  /** The profile as the page last read it. Its credential names are this form's fields. */
  readout: AgentProfileReadout
  labels: AgentCredentialLabels
}>()

const emit = defineEmits<{
  /** A write landed: the readout the backend answered with, already re-read through the profile client. */
  (e: 'updated', readout: AgentProfileReadout): void
}>()

/**
 * The rows above the form: names, and the placeholder in every value.
 *
 * Built by the policy from the readout, so the value the backend sent is replaced rather than
 * rendered — the readout really does carry one when a page's double sends it, and this is the
 * template that would otherwise print it.
 */
const rows = computed(() => credentialRows(props.readout))

const fields = ref<CredentialField[]>(credentialFields(props.readout))
const busy = ref(false)
const outcome = ref<'idle' | 'saved' | 'refused' | 'failed'>('idle')
const message = ref('')

// A readout that moved — a reload, or the page's own re-read after a record write — rebuilds the
// fields, which is what drops every draft. Carrying a draft across would apply a value the user
// typed against a different set of names.
watch(
  () => props.readout,
  (readout) => {
    fields.value = credentialFields(readout)
  },
)

/** What the field shows: the draft once it has been touched, and the placeholder before that. */
function shown(field: CredentialField): string {
  return field.draft ?? ''
}

function type(field: CredentialField, value: string): void {
  field.draft = value
  outcome.value = 'idle'
}

async function save(): Promise<void> {
  if (busy.value) return
  busy.value = true
  outcome.value = 'idle'
  try {
    const answer = await props.client.write(fields.value)
    if (answer.status === 'refused') {
      // A pre-flight refusal — the placeholder submitted as a value — which never left this
      // window. Its sentence is the policy's, and it is about the form rather than the backend.
      outcome.value = 'refused'
      message.value = answer.message
      return
    }
    outcome.value = 'saved'
    emit('updated', answer.readout)
    fields.value = credentialFields(answer.readout)
  } catch (e) {
    // A rejection is a call that did not complete. The backend's sentence names the profile or
    // the field and never quotes a credential (`refusal_message` in `agent_settings.rs`), so it
    // is shown rather than replaced by one this page would have to invent.
    outcome.value = 'failed'
    message.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="credential-section">
    <span class="settings-label">{{ labels.title }}</span>
    <span class="settings-note">{{ labels.hint }}</span>
    <span
      v-if="rows.length === 0"
      class="settings-note"
      data-test="provider-no-credentials"
    >{{ labels.none }}</span>
    <ul
      v-else
      class="credential-rows"
    >
      <li
        v-for="row in rows"
        :key="row.name"
        class="credential-row"
        :data-test="`provider-credential-${row.name}`"
      >
        <span class="credential-name">{{ row.name }}</span>
        <span class="settings-note">
          {{ row.value === '' ? labels.none : labels.placeholder }}
        </span>
      </li>
    </ul>
    <!-- Where the values live, stated rather than implied (§8.1: 不宣称已经使用系统钥匙串或加密). -->
    <span
      v-if="readout.credentialStorage.kind === 'host-file'"
      class="settings-note credential-name"
      data-test="provider-credential-storage"
    >
      {{ labels.hostFile }} {{ readout.credentialStorage.path }}
      ({{ readout.credentialStorage.mode }})
    </span>
    <span
      v-if="readout.credentialStorage.kind === 'host-file'"
      class="settings-note is-warn"
      data-test="provider-credential-warning"
    >
      {{ labels.notEncrypted }}
    </span>

    <!-- The write half, under the read half it is about, and absent when the profile is not
         editable — for the reason the record's own write controls are: a form that can only be
         refused is a form whose refusal the user has to discover by trying. -->
    <template v-if="readout.editable && rows.length > 0">
      <span class="settings-note">{{ labels.form.editHint }}</span>
      <label
        v-for="field in fields"
        :key="field.name"
        class="settings-field"
      >
        <span>{{ field.name }}</span>
        <input
          class="provider-input"
          type="password"
          autocomplete="off"
          spellcheck="false"
          :placeholder="field.display"
          :value="shown(field)"
          :data-test="`credential-field-${field.name}`"
          @input="type(field, ($event.target as HTMLInputElement).value)"
        >
      </label>
      <div class="credential-actions">
        <button
          type="button"
          class="provider-button"
          :disabled="busy"
          data-test="credential-save"
          @click="save"
        >
          {{ labels.form.save }}
        </button>
        <span
          v-if="outcome === 'saved'"
          class="settings-note provider-ok"
          data-test="credential-saved"
        >{{ labels.form.saved }}</span>
        <span
          v-else-if="outcome === 'refused' || outcome === 'failed'"
          class="settings-note is-error"
          data-test="credential-failed"
        >{{ labels.form.failed }} {{ message }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* `.settings-label`, `.settings-note`, `.settings-field`, `.provider-input` and
   `.provider-button` are restated in the sections that render them, for the reason
   `AiSettings.vue` gives: a scoped block belongs to the component that renders the element. The
   layout classes below are this section's own. */
.credential-section { display: flex; flex-direction: column; gap: 4px; padding-top: 8px; border-top: 1px solid var(--app-border); }
.settings-label { margin-top: 6px; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; color: var(--app-muted); }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.settings-note.is-warn { color: var(--app-warn); }
.settings-note.is-error { color: var(--app-danger); }
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.settings-field > span:first-child { color: var(--app-muted); font-size: 11px; }
.credential-rows { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.credential-row { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); }
.credential-name { font-family: var(--app-mono-font); font-size: 11px; color: var(--app-text); overflow-wrap: anywhere; }
.provider-input { font: inherit; font-size: 12px; padding: 4px 6px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); color: var(--app-text); }
.provider-ok { color: var(--app-accent); }
.credential-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.provider-button { align-self: flex-start; font: inherit; font-size: 11px; padding: 4px 10px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-accent); color: var(--app-accent-contrast); cursor: pointer; }
.provider-button:disabled { opacity: 0.5; cursor: default; }
</style>
