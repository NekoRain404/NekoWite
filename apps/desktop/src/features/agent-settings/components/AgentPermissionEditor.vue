<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RotateCcw, Save } from 'lucide-vue-next'
import SelectMenu from '../../../components/SelectMenu.vue'
import { t } from '../../../i18n'
import type { AgentConfigClient } from '../services/agent-config-ipc'
import type { ConfigRead } from '../services/agent-settings-policy'
import { permissionEditor, permissionEdits, type PermissionAction } from '../services/agent-permission-editor'

const props = defineProps<{ client: AgentConfigClient; verifiedOpenCode: boolean }>()
const emit = defineEmits<{ saved: [] }>()
const held = ref<ConfigRead | null>(null)
const draft = ref<Record<string, PermissionAction>>({})
const busy = ref(false)
const state = ref<'loading' | 'ready' | 'readonly' | 'failed' | 'conflict' | 'saved'>('loading')
const error = ref('')
const restartRequired = ref(false)
let generation = 0
const view = computed(() => held.value ? permissionEditor(held.value, props.verifiedOpenCode) : null)
const edits = computed(() => view.value?.kind === 'editable' ? permissionEdits(view.value, draft.value) : [])
const label = (key: string) => t(`agent.permissionEditor.${key}`)
const actionOptions = computed(() => (['ask', 'allow', 'deny'] as const).map(value => ({ value, label: label(value) })))

async function load(): Promise<void> {
  const token = ++generation
  const client = props.client
  held.value = null
  draft.value = {}
  busy.value = false
  error.value = ''
  state.value = 'loading'
  if (!props.verifiedOpenCode) return
  try {
    const answer = await client.read()
    if (token !== generation) return
    if (answer.state === 'no-document') { state.value = 'readonly'; return }
    held.value = answer.document
    const editor = permissionEditor(answer.document, props.verifiedOpenCode)
    if (editor.kind === 'editable') {
      draft.value = Object.fromEntries(editor.rules.filter(rule => rule.action !== null).map(rule => [rule.tool, rule.action!]))
    }
    state.value = 'ready'
  } catch (cause) {
    if (token !== generation) return
    state.value = 'failed'
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function save(): Promise<void> {
  if (busy.value || state.value === 'conflict' || state.value === 'saved' || !held.value || edits.value.length === 0) return
  const token = generation
  const client = props.client
  const document = held.value
  busy.value = true
  error.value = ''
  try {
    const answer = await client.edit(document.path, document.revision, edits.value)
    if (token !== generation) return
    state.value = answer.status === 'written' ? 'saved' : 'conflict'
    if (answer.status === 'written') { restartRequired.value = true; emit('saved') }
  } catch (cause) {
    if (token !== generation) return
    state.value = 'failed'
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (token === generation) busy.value = false
  }
}

// A late read or save belongs to the original profile, never the next mounted client.
watch(() => [props.client, props.verifiedOpenCode], () => {
  restartRequired.value = false
  void load()
}, { immediate: true })
onBeforeUnmount(() => { generation++ })
</script>

<template>
  <div
    class="permission-editor"
    data-test="permission-editor"
  >
    <strong>{{ label('title') }}</strong>
    <p
      v-if="verifiedOpenCode"
      data-test="permission-editor-scope"
    >
      {{ label('scope') }}
    </p>
    <p
      v-if="!verifiedOpenCode"
      data-test="permission-editor-unsupported"
    >
      {{ label('unsupported') }}
    </p>
    <p v-else-if="state === 'loading'">
      {{ label('loading') }}
    </p>
    <p
      v-else-if="state === 'readonly' || view?.kind === 'readonly'"
      data-test="permission-editor-readonly"
    >
      {{ label('readonly') }}
    </p>
    <template v-else>
      <code
        v-if="held"
        class="permission-path"
      >{{ held.resolved }}</code>
      <p v-if="view && view.kind !== 'editable'">
        {{ label(view.kind) }}
      </p>
      <template v-if="view?.kind === 'editable'">
        <div
          v-for="rule in view.rules"
          :key="rule.tool"
          class="permission-rule"
        >
          <label :for="`permission-action-${rule.tool}`">{{ rule.tool }}</label>
          <SelectMenu
            v-if="rule.action !== null"
            :id="`permission-action-${rule.tool}`"
            :model-value="draft[rule.tool]"
            :options="actionOptions"
            :disabled="busy || state === 'saved' || state === 'conflict'"
            :data-test="`permission-editor-${rule.tool}`"
            @update:model-value="draft[rule.tool] = $event as PermissionAction"
          />
          <span v-else>{{ label('preserved') }}</span>
        </div>
        <div class="permission-actions">
          <button
            type="button"
            :disabled="busy || !edits.length || state === 'conflict' || state === 'saved'"
            data-test="permission-editor-save"
            @click="save"
          >
            <Save :size="14" />{{ label('save') }}
          </button>
        </div>
      </template>
      <p
        v-if="restartRequired"
        role="status"
        data-test="permission-editor-saved"
      >
        {{ label('saved') }}
      </p>
      <p
        v-if="state === 'conflict'"
        role="alert"
        data-test="permission-editor-conflict"
      >
        {{ label('conflict') }}
      </p>
      <p
        v-if="state === 'failed'"
        role="alert"
        data-test="permission-editor-failed"
      >
        {{ label('failed') }} {{ error }}
      </p>
      <button
        type="button"
        :disabled="busy"
        data-test="permission-editor-reload"
        @click="load"
      >
        <RotateCcw :size="14" />{{ label('reload') }}
      </button>
    </template>
    <p>{{ label('temporary') }}</p>
    <p>{{ label('persistent') }}</p>
  </div>
</template>

<style scoped>
.permission-editor { display: flex; flex-direction: column; gap: 8px; padding-block: 12px; border-block: 1px solid var(--app-border); font-size: 12px; }
.permission-editor p { margin: 0; color: var(--app-muted); line-height: 1.5; }
.permission-path { font-size: 11px; overflow-wrap: anywhere; color: var(--app-muted); }
.permission-rule { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.permission-rule label { overflow-wrap: anywhere; min-width: 0; }
.permission-rule span { color: var(--app-muted); font-size: 11px; }
.permission-editor .select-trigger { background: var(--app-elevated); color: var(--app-text); padding: 4px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); }
.permission-editor button { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); padding: 5px 8px; color: var(--app-text); background: var(--app-elevated); cursor: pointer; }
.permission-editor button:disabled { opacity: .5; cursor: default; }
</style>
