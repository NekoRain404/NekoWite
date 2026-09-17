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
 * ## Four states, and two of them have a control
 *
 * `configEditor` decides, and its arms are the honest answers rather than degrees of the same
 * thing: a document this host may write (a form), a document that is not on disk yet (the same form,
 * with a sentence saying that saving creates the file — `agent_config_edit` takes the absence as the
 * claim a create is built on), a document this host may not write (a sentence), and no document for
 * this pair at all (a different sentence, because the next move is different). §5.2's
 * 「不可用选项要说明原因」 read as a design rule: the two arms with no control are two paragraphs, not
 * one greyed-out button.
 *
 * ## The claim the form carries is the one the read answered
 *
 * `read.revision` goes back to the backend untouched — a hash for a document that is there, and
 * `null` for one that is not. That is the whole of the create rule and the whole of the conflict
 * rule, and it is why neither is decided here: the backend compares the claim with the disk under
 * its own lock, so a document that appeared between this page's read and the user's save loses the
 * race here rather than being overwritten by it.
 *
 * ## A conflict is not a failure
 *
 * The backend answers `conflict` when the document is not the one that was read — with the document
 * that is there instead. This page says so, reloads, and **does not retry**: merging an edit into a
 * document nobody read is how a change made elsewhere gets undone, which is why the backend's answer
 * carries the current text rather than a merge. The form keeps what the user typed, so the next
 * submit is against the revision on screen. The sentence is not the same for a create that lost its
 * race as for a revision that moved — "the file changed" and "something else created this file" are
 * two different things for the user to check — so the page remembers which claim it sent.
 */
import { computed, onMounted, ref } from 'vue'

import { configLabels, type AgentConfigLabels } from './agent-config-labels'
import AgentProviderAuthoring from './AgentProviderAuthoring.vue'
import type { AgentProviderAuthoringClient } from '../services/agent-provider-authoring'
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
  /**
   * The provider form's other two calls: the endpoint's model list, and the credential write.
   *
   * A second client rather than two more methods on the document's, for the reason
   * `AgentProviderSettings.vue` gives for its own pair — a model list is a request to somebody else's
   * server and a credential is a different resource with a different answer, and neither is a
   * document edit. It is built for the same (engine, profile) pair at the composition site, so this
   * page never decides which profile it is writing into.
   *
   * Required, so a caller that forgets it is a compile error at the composition site rather than a
   * page that quietly draws one control fewer; the template checks it at runtime because a test may
   * mount this page with the document's client alone.
   */
  authoring: AgentProviderAuthoringClient
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
/**
 * Why the last submission came back as a conflict, or `null` when it did not.
 *
 * Two ids rather than a flag, because the two are different facts about the file: a revision that
 * moved (someone edited a document that was there) and an absence that was filled (something
 * created it first). §5.2's rule read one layer in — the user's next check is a different one.
 */
const conflict = ref<'moved' | 'created' | null>(null)
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

/**
 * Re-read the document after a write, without the first read's loading state.
 *
 * The reason is the one `AgentProviderSettings.vue` gives for its own `refresh`: the pages below are
 * on screen, and a read for a revision nobody asked about must not blank them. Here it is not only
 * cosmetic — the loading arm replaces the document's whole block, so the provider form is unmounted
 * and comes back with empty fields, which would lose the address and the model list the user had
 * just saved. A read that does not complete falls back to the unreadable state, which is this page's
 * answer to exactly that: the values on screen are then the ones from before the write, and saying
 * so is better than leaving them looking current.
 */
async function refresh(): Promise<void> {
  try {
    readout.value = await props.client.read()
    state.value = 'ready'
  } catch {
    state.value = 'unreadable'
  }
}

async function submit(): Promise<void> {
  const read = document.value
  if (read === null || (editor.value.kind !== 'editable' && editor.value.kind !== 'creatable')) return
  applied.value = false
  conflict.value = null
  failed.value = false
  invalidValue.value = false
  refusal.value = null
  // Which claim this submission carries, and therefore which conflict it can come back as. Read
  // before the write, because the reload below replaces the document it came from.
  const creates = read.revision === null
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
    // The revision as read, `null` included: that is the claim the backend checks, and for a
    // document that is not there it is what makes this save its creation rather than a refusal.
    revision: read.revision,
    edits: [{ path: [member.value.trim()], value: parsed.value }],
  }
  const decision = decideConfigWrite(read, write)
  if (decision.status === 'refused') {
    refusal.value = decision.reason
    return
  }
  if (decision.status === 'conflict') {
    conflict.value = creates ? 'created' : 'moved'
    // Reloaded so the revision on screen is the one an edit may be built from. What the user typed
    // stays in the form: it is their edit, and it is not this page's to discard.
    await load()
    return
  }
  busy.value = true
  try {
    const outcome = await props.client.edit(write.path, write.revision, decision.edits)
    if (outcome.status === 'conflict') {
      conflict.value = creates ? 'created' : 'moved'
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

      <!-- The document, when there is one to show. Not drawn for a file that is not there: there is
           no text to show, and "no text was returned" over a file nobody has written yet reads as a
           failure rather than as the state it is. -->
      <div v-if="document.exists" class="config-document">
        <span class="settings-label">{{ labels.document.title }}</span>
        <span class="settings-note">{{ labels.document.textHint }}</span>
        <!-- The engine's own file, as the engine wrote it. Shown whenever the backend sent text,
             including when the document is one this host may not write: §8.1 asks a page to say
             what is actually in effect, and a file a user cannot see is not that. -->
        <pre v-if="document.text !== null" class="config-text" data-test="config-text">{{ document.text }}</pre>
        <span v-else class="settings-note" data-test="config-no-text">{{ labels.document.text }}</span>
      </div>

      <!-- Not on disk yet, and that is a state the form may act on: saving a member creates the
           file, and this sentence is what says so before the user presses anything. -->
      <span v-if="editor.kind === 'creatable'" class="settings-note is-warn" data-test="config-creates">
        {{ labels.creates }}
      </span>
      <!-- There is a document and this host may not write it. Drawn as words, never as a disabled
           form: §8.2's 「不能仅隐藏 UI 项目而声称已禁用」 is about a control that does nothing. -->
      <span v-else-if="editor.kind === 'not-editable'" class="settings-note is-warn" data-test="config-read-only">
        {{ labels.readOnly }}
      </span>

      <!-- One form for both writable arms: what differs is the claim it carries and the sentence
           above it, not the fields. -->
      <form
        v-if="editor.kind === 'editable' || editor.kind === 'creatable'"
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
          <span v-if="conflict === 'moved'" class="settings-note is-warn" data-test="config-conflict">
            {{ labels.edit.conflict }}
          </span>
          <span v-else-if="conflict === 'created'" class="settings-note is-warn" data-test="config-conflict-created">
            {{ labels.edit.conflictCreated }}
          </span>
          <span v-if="failed" class="settings-note is-error" data-test="config-failed">
            {{ labels.edit.failed }}
          </span>
        </div>
      </form>

      <!-- The structured half, over the same document and behind the same arm: the one member a raw
           editor is genuinely bad at is a provider block, which is a nest of members whose names the
           engine owns. It writes the same thing this form's member editor would — one member at the
           revision that was read — and the two cannot disagree, because the value it shows is the
           value it submits (`agent-provider-block.ts` builds both). It is absent when there is no
           client for the calls it makes, which is a page mounted without a composition site rather
           than a state a user reaches. -->
      <AgentProviderAuthoring
        v-if="(editor.kind === 'editable' || editor.kind === 'creatable') && authoring && document"
        :client="props.client"
        :authoring="authoring"
        :document="document"
        @reload="refresh"
      />
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
