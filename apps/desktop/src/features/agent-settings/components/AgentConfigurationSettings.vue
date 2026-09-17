<script lang="ts">
/**
 * The compatibility surface for this section's copy: the table lives in `agent-config-labels.ts`
 * and the type is re-exported here, for the reason `AgentSkillsSettings.vue` gives — the specifier
 * callers already name is *this file*, and an SFC's named type exports are what such a specifier
 * resolves against.
 */
export type { AgentConfigLabels } from './agent-config-labels'
</script>

<script setup lang="ts">
/**
 * The engine's own configuration — §8.1's 配置归属, and the page `agent_config_document` /
 * `agent_config_edit` were built for.
 *
 * ## What this page is, and what it is not
 *
 * It is the document an engine reads: where it is, what is in it, and one member changed at a
 * revision. It is **not** a form over a schema. §3.4.5 leaves an engine's configuration format to a
 * verified adapter, and this window is not one — so there is no list of members here, no default
 * block, and no name of any engine's settings. Everything drawn comes from the answer: the relative
 * path (the engine's layout, reported on the profile readout), whether the file exists, whether this
 * host may write it, the revision, and the text.
 *
 * ## The text is shown, and the value is the only thing parsed
 *
 * The file is JSONC — comments and unknown members survive the backend's splice byte for byte — and
 * nothing in this window can read it as JSON without losing exactly those parts. So the document is
 * drawn as text, and the *value* a user types into the form is the only thing that goes through
 * `JSON.parse`. The category error this avoids is a page that parsed the file, dropped a comment,
 * and wrote the result back as if it had read the document.
 *
 * ## Four states, and only one of them has a control
 *
 * `configEditor` decides, and its arms are the honest answers rather than degrees of the same
 * thing: a document this host may write (a form), a document that is not on disk yet (a sentence —
 * `agent_config_edit` cannot create one, so a form would be a control that cannot work), a document
 * this host may not write (a sentence), and no document for this pair at all (a different sentence,
 * because the next move is different). §5.2's 「不可用选项要说明原因」 read as a design rule: the three
 * absences are three paragraphs, not one greyed-out button.
 *
 * ## A conflict is not a failure
 *
 * The backend answers `conflict` when the document is not the one that was read — with the document
 * that is there instead. This page says so, reloads, and **does not retry**: merging an edit into a
 * document nobody read is how a change made elsewhere gets undone, which is why the backend's answer
 * carries the current text rather than a merge. The form keeps what the user typed, so the next
 * submit is against the revision on screen.
 */
import { computed, onMounted, ref } from 'vue'

import { configLabels, type AgentConfigLabels } from './agent-config-labels'
import {
  configEditor,
  configRefusalMessage,
  decideConfigWrite,
  parseConfigValue,
  type ConfigRead,
  type ConfigRefusal,
} from '../services/agent-settings-policy'
import type { AgentConfigClient, AgentConfigReadout } from '../services/agent-config-ipc'

const props = defineProps<{
  client: AgentConfigClient
  labels?: AgentConfigLabels
}>()

const labels = computed<AgentConfigLabels>(() => props.labels ?? configLabels())
const readout = ref<AgentConfigReadout | null>(null)
const state = ref<'loading' | 'ready' | 'unreadable'>('loading')

/** The member being set, and its value as the user typed it. */
const member = ref('')
const value = ref('')

const busy = ref(false)
/** Whether the value field holds something that is not a JSON value. The backend is not asked. */
const invalidValue = ref(false)
/** A write the policy refused before it was sent. */
const refusal = ref<ConfigRefusal | null>(null)
const applied = ref(false)
const conflict = ref(false)
const failed = ref(false)

/** The document, when there is one to draw. */
const document = computed<ConfigRead | null>(() =>
  readout.value?.state === 'document' ? readout.value.document : null,
)

/** Which arm the page is in. The rule is `agent-settings-policy.ts`'s, not a second copy here. */
const editor = computed(() => configEditor(document.value))

/**
 * A refusal's sentence.
 *
 * The one refusal this form can produce — a member that was not named — has a sentence of its own in
 * the catalogue. The other three are arms in which this page draws no form at all, so they cannot
 * arrive from here; if a later change makes one reachable, the policy's own sentence is drawn rather
 * than a key invented for a state nobody has thought about.
 */
function refusalText(reason: ConfigRefusal): string {
  return reason === 'malformed-edit' ? labels.value.edit.noMember : configRefusalMessage(reason)
}

async function load(): Promise<void> {
  state.value = 'loading'
  try {
    readout.value = await props.client.read()
    state.value = 'ready'
  } catch {
    // "This host owns no document for this profile" is a fact about the profile; a failed read is a
    // fact about the connection. The two lead to different next moves, so they are different states.
    state.value = 'unreadable'
  }
}

async function submit(): Promise<void> {
  const read = document.value
  if (read === null || editor.value.kind !== 'editable') return
  applied.value = false
  conflict.value = false
  failed.value = false
  invalidValue.value = false
  refusal.value = null
  // The value is parsed here because parsing JSON is this form's job; everything else — whether the
  // document may be written at all, whether the revision still holds, whether a member was named —
  // is `decideConfigWrite`'s, so the page and the backend cannot disagree about it.
  const parsed = parseConfigValue(value.value)
  if (parsed.kind === 'invalid') {
    invalidValue.value = true
    return
  }
  // One member, as one path segment: §3.4.3's rule read one layer in — a name and its parent are
  // never joined, and a key containing a dot is a key like any other.
  const write = {
    path: read.path,
    // `''` only satisfies the type here: the decision below refuses with `absent` whenever the
    // revision is `null`, so a write with no revision never reaches the backend.
    revision: read.revision ?? '',
    edits: [{ path: [member.value.trim()], value: parsed.value }],
  }
  const decision = decideConfigWrite(read, write)
  if (decision.status === 'refused') {
    refusal.value = decision.reason
    return
  }
  if (decision.status === 'conflict') {
    conflict.value = true
    // Reloaded so the revision on screen is the one an edit may be built from. What the user typed
    // stays in the form: it is their edit, and it is not this page's to discard.
    await load()
    return
  }
  busy.value = true
  try {
    const outcome = await props.client.edit(write.path, write.revision, decision.edits)
    if (outcome.status === 'conflict') {
      conflict.value = true
      await load()
      return
    }
    applied.value = true
    member.value = ''
    value.value = ''
    await load()
  } catch {
    failed.value = true
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="settings-section config">
    <span class="settings-label">{{ labels.section.title }}</span>
    <span class="settings-note">{{ labels.section.hint }}</span>

    <span v-if="state === 'loading'" class="settings-note" data-test="config-loading">
      {{ labels.loading }}
    </span>
    <template v-else-if="state === 'unreadable'">
      <span class="settings-note is-error" data-test="config-unreadable">{{ labels.unreadable }}</span>
      <button type="button" class="config-button" data-test="config-retry" @click="load">
        {{ labels.retry }}
      </button>
    </template>

    <!-- The arm with no document at all: this pair's engine reads the user's own installation. Text
         and no control — there is nothing here this window may open. -->
    <span
      v-else-if="editor.kind === 'none'"
      class="settings-note"
      data-test="config-none"
    >
      {{ labels.none }}
    </span>

    <template v-else-if="document">
      <span class="settings-note" data-test="config-location">
        {{ labels.document.path }}: <code class="config-path">{{ document.resolved }}</code>
      </span>
      <span class="settings-note" data-test="config-exists">
        {{ document.exists ? labels.document.exists : labels.document.absent }}
      </span>

      <div class="config-document">
        <span class="settings-label">{{ labels.document.title }}</span>
        <span class="settings-note">{{ labels.document.textHint }}</span>
        <!-- The engine's own file, as the engine wrote it. Shown whenever the backend sent text,
             including when the document is one this host may not write: §8.1 asks a page to say
             what is actually in effect, and a file a user cannot see is not that. -->
        <pre v-if="document.text !== null" class="config-text" data-test="config-text">{{ document.text }}</pre>
        <span v-else class="settings-note" data-test="config-no-text">{{ labels.document.text }}</span>
      </div>

      <!-- Not on disk. `agent_config_edit` cannot create one, so the sentence is the whole of it. -->
      <span v-if="editor.kind === 'absent'" class="settings-note is-warn" data-test="config-unwritten">
        {{ labels.unwritten }}
      </span>
      <!-- There is a document and this host may not write it. Drawn as words, never as a disabled
           form: §8.2's 「不能仅隐藏 UI 项目而声称已禁用」 is about a control that does nothing. -->
      <span v-else-if="editor.kind === 'not-editable'" class="settings-note is-warn" data-test="config-read-only">
        {{ labels.readOnly }}
      </span>

      <form
        v-else-if="editor.kind === 'editable'"
        class="config-edit"
        data-test="config-edit"
        @submit.prevent="submit"
      >
        <span class="settings-label">{{ labels.edit.title }}</span>
        <span class="settings-note">{{ labels.edit.hint }}</span>
        <label class="config-field">
          <span>{{ labels.edit.member }}</span>
          <input v-model="member" class="config-input" data-test="config-member">
          <span class="settings-note">{{ labels.edit.memberHint }}</span>
        </label>
        <label class="config-field">
          <span>{{ labels.edit.value }}</span>
          <textarea v-model="value" class="config-input config-value" rows="3" data-test="config-value" />
          <span class="settings-note">{{ labels.edit.valueHint }}</span>
        </label>
        <div class="config-actions">
          <button type="submit" class="config-button" :disabled="busy" data-test="config-save">
            {{ labels.edit.save }}
          </button>
          <span v-if="refusal" class="settings-note is-error" data-test="config-no-member">
            {{ refusalText(refusal) }}
          </span>
          <span v-else-if="invalidValue" class="settings-note is-error" data-test="config-invalid-value">
            {{ labels.edit.invalidValue }}
          </span>
          <span v-if="applied" class="settings-note config-ok" data-test="config-applied">
            {{ labels.edit.applied }}
          </span>
          <span v-if="conflict" class="settings-note is-warn" data-test="config-conflict">
            {{ labels.edit.conflict }}
          </span>
          <span v-if="failed" class="settings-note is-error" data-test="config-failed">
            {{ labels.edit.failed }}
          </span>
        </div>
      </form>
    </template>
  </section>
</template>

<style scoped>
/* `.settings-section`, `.settings-label` and `.settings-note` are restated here, as every section
   in this dialog restates them: a scoped block belongs to the component that renders the element. */
.settings-section { display: flex; flex-direction: column; gap: 8px; }
.settings-label { margin-top: 6px; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; color: var(--app-muted); }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.settings-note.is-warn { color: var(--app-warn); }
.settings-note.is-error { color: var(--app-danger); }
.config-ok { color: var(--app-accent); }
.config-path { font-family: var(--app-mono-font); overflow-wrap: anywhere; }
.config-document, .config-edit { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--app-border); }
/* The document, scrollable in both directions rather than wrapped: a member's line structure is
   part of what a user is reading, and a wrapped line is a different document. */
.config-text {
  max-height: 240px;
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
.config-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.config-field > span:first-child { color: var(--app-muted); font-size: 11px; }
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
.config-value { resize: vertical; }
.config-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
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
</style>
