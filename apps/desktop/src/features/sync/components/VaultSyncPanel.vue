<script setup lang="ts">
import { ref, watch } from 'vue'
import { ArrowDownToLine, ArrowUpFromLine, Check, GitBranch, RefreshCw } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { vaultGitClient, type GitAction, type GitReadout, type VaultGitClient } from '../services/vault-git-client'

const props = withDefaults(defineProps<{ vault: string; client?: VaultGitClient }>(), { client: () => vaultGitClient })
const readout = ref<GitReadout | null>(null)
const origin = ref('')
const message = ref('')
const error = ref('')
const pending = ref(false)
let revision = 0

async function run(action: GitAction): Promise<void> {
  if (pending.value) return
  const current = ++revision
  const vault = props.vault
  pending.value = true
  error.value = ''
  try {
    const result = await props.client.run(vault, action)
    if (current !== revision || vault !== props.vault) return
    readout.value = result
    if (action.kind === 'status' || action.kind === 'setOrigin') origin.value = result.origin
    if (action.kind === 'commit') message.value = ''
  } catch (cause) {
    if (current === revision && vault === props.vault) error.value = String(cause)
  } finally {
    if (current === revision) pending.value = false
  }
}

watch(() => props.vault, () => {
  revision++
  pending.value = false
  readout.value = null
  error.value = ''
  origin.value = ''
  message.value = ''
  void run({ kind: 'status' })
}, { immediate: true })
</script>

<template>
  <section
    class="vault-sync"
    :aria-label="t('sync.title')"
  >
    <header class="sync-head">
      <GitBranch
        :size="16"
        aria-hidden="true"
      />
      <strong>{{ readout?.branch || t('sync.title') }}</strong>
      <button
        class="icon-button"
        type="button"
        :title="t('sync.refresh')"
        :disabled="pending"
        @click="run({ kind: 'status' })"
      >
        <RefreshCw
          :size="15"
          aria-hidden="true"
        />
      </button>
    </header>
    <p
      v-if="error"
      class="sync-error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-if="!readout && !error"
      class="sync-muted"
    >
      {{ t('sync.loading') }}
    </p>
    <template v-if="readout && !readout.initialized">
      <p class="sync-muted">
        {{ t('sync.notInitialized') }}
      </p>
      <button
        type="button"
        class="sync-command"
        :disabled="pending"
        data-test="git-init"
        @click="run({ kind: 'init' })"
      >
        {{ t('sync.init') }}
      </button>
    </template>
    <template v-else-if="readout?.initialized">
      <label class="sync-field">
        <span>{{ t('sync.origin') }}</span>
        <input
          v-model="origin"
          type="text"
          :placeholder="t('sync.originHint')"
          data-test="git-origin"
        >
      </label>
      <button
        type="button"
        class="sync-command"
        :disabled="pending || !origin.trim() || origin === readout.origin"
        data-test="git-save-origin"
        @click="run({ kind: 'setOrigin', url: origin.trim() })"
      >
        <Check
          :size="14"
          aria-hidden="true"
        /> {{ t('sync.saveOrigin') }}
      </button>
      <div class="sync-changes">
        <span class="sync-heading">{{ t('sync.changes') }}</span>
        <pre
          v-if="readout.changes"
          data-test="git-changes"
        >{{ readout.changes }}</pre>
        <p
          v-else
          class="sync-muted"
        >
          {{ t('sync.clean') }}
        </p>
      </div>
      <label class="sync-field">
        <span>{{ t('sync.message') }}</span>
        <input
          v-model="message"
          :placeholder="t('sync.messageHint')"
          maxlength="240"
          data-test="git-message"
        >
      </label>
      <button
        type="button"
        class="sync-command"
        :disabled="pending || !message.trim() || !readout.changes"
        data-test="git-commit"
        @click="run({ kind: 'commit', message: message.trim() })"
      >
        <Check
          :size="14"
          aria-hidden="true"
        /> {{ t('sync.commit') }}
      </button>
      <div class="sync-transport">
        <button
          type="button"
          class="sync-command"
          :disabled="pending || !readout.origin || !!readout.changes"
          data-test="git-pull"
          @click="run({ kind: 'pull' })"
        >
          <ArrowDownToLine
            :size="14"
            aria-hidden="true"
          /> {{ t('sync.pull') }}
        </button>
        <button
          type="button"
          class="sync-command"
          :disabled="pending || !readout.origin"
          data-test="git-push"
          @click="run({ kind: 'push' })"
        >
          <ArrowUpFromLine
            :size="14"
            aria-hidden="true"
          /> {{ t('sync.push') }}
        </button>
      </div>
      <p class="sync-muted">
        {{ t('sync.localOnly') }}
      </p>
    </template>
  </section>
</template>

<style scoped>
.vault-sync { display: flex; flex-direction: column; gap: 12px; padding: 14px; overflow-y: auto; min-height: 0; font-size: 12px; color: var(--app-text); }
.sync-head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.sync-head strong { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.sync-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.sync-field span, .sync-heading { color: var(--app-muted); font-size: 11px; }
.sync-field input { width: 100%; min-width: 0; padding: 7px; border: 1px solid var(--app-border); border-radius: 5px; background: var(--app-elevated); color: var(--app-text); font: inherit; }
.sync-command { display: inline-flex; align-items: center; justify-content: center; gap: 5px; align-self: flex-start; min-height: 28px; border: 1px solid var(--app-border); border-radius: 5px; padding: 4px 9px; background: var(--app-elevated); color: var(--app-text); font: inherit; cursor: pointer; }
.sync-command:disabled, .icon-button:disabled { opacity: .45; cursor: default; }
.sync-command:hover:not(:disabled), .icon-button:hover:not(:disabled) { background: var(--app-accent-soft); }
.sync-transport { display: flex; gap: 7px; flex-wrap: wrap; }
.sync-changes { border-top: 1px solid var(--app-border); padding-top: 12px; }
.sync-changes pre { max-height: 200px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.5 var(--app-mono-font); }
.sync-muted { margin: 0; color: var(--app-muted); line-height: 1.5; }
.sync-error { color: var(--app-danger); overflow-wrap: anywhere; }
.icon-button { display: grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: 5px; background: transparent; color: var(--app-muted); cursor: pointer; }
</style>
