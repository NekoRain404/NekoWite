<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Server, X } from 'lucide-vue-next'
import SelectMenu from '../../../components/SelectMenu.vue'
import { useFocusTrap } from '../../../composables/use-focus-trap'
import { useModalEscape } from '../../../composables/use-modal-escape'
import { t } from '../../../i18n'
import { remoteWorkspaceClient, type RemoteAuth, type RemoteConnection, type RemoteWorkspaceClient } from '../services/remote-workspace-client'

const props = withDefaults(defineProps<{ vault: string; client?: RemoteWorkspaceClient }>(), { client: () => remoteWorkspaceClient })
const emit = defineEmits<{ close: []; imported: [path: string] }>()
const dialog = ref<HTMLElement | null>(null)
const active = ref(true)
const user = ref('')
const host = ref('')
const port = ref(22)
const remotePath = ref('')
const folder = ref('')
const pending = ref(false)
const error = ref('')
const mode = ref<'live' | 'import'>('live')
const connections = ref<RemoteConnection[]>([])
const authMode = ref<'agent' | 'key' | 'password'>('agent')
const identityFile = ref('')
const password = ref('')
const authOptions = computed(() => [
  { value: 'agent', label: t('remote.authAgent') },
  { value: 'key', label: t('remote.authKey') },
  { value: 'password', label: t('remote.authPassword') },
])
function setAuthMode(value: string | number): void { authMode.value = value as typeof authMode.value }
watch(authMode, () => { password.value = '' })
useFocusTrap(dialog, active, { initialFocus: false })
useModalEscape('remote-import', () => { if (!pending.value) emit('close') })
onMounted(() => {
  void nextTick(() => dialog.value?.focus())
  void refreshConnections()
})

async function refreshConnections(): Promise<void> {
  try { connections.value = await props.client.connections(props.vault) }
  catch (cause) { error.value = String(cause) }
}

async function disconnect(path: string): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = ''
  try {
    await props.client.disconnect(props.vault, path.split('/').pop()!)
    await refreshConnections()
  } catch (cause) { error.value = String(cause) }
  finally { pending.value = false }
}

async function submit(): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = ''
  try {
    const spec = {
      user: user.value.trim(), host: host.value.trim(), port: Number(port.value),
      remotePath: remotePath.value.trim(), folder: folder.value.trim(),
      ...(authMode.value === 'agent' ? {} : { auth: authMode.value === 'key'
        ? { mode: 'key', identityFile: identityFile.value.trim() } as RemoteAuth
        : { mode: 'password', password: password.value } as RemoteAuth }),
    }
    const path = mode.value === 'live'
      ? await props.client.connect(props.vault, spec)
      : await props.client.import(props.vault, spec)
    emit('imported', path)
  } catch (cause) {
    error.value = String(cause)
  } finally {
    password.value = ''
    pending.value = false
  }
}
</script>

<template>
  <div
    class="dialog-overlay"
    @click.self="!pending && emit('close')"
  >
    <form
      ref="dialog"
      class="dialog remote-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="t('remote.title')"
      tabindex="-1"
      @submit.prevent="submit"
    >
      <header class="remote-head">
        <Server
          :size="17"
          aria-hidden="true"
        />
        <strong>{{ t('remote.title') }}</strong>
        <button
          type="button"
          class="close"
          :aria-label="t('common.close')"
          :disabled="pending"
          @click="emit('close')"
        >
          <X :size="16" />
        </button>
      </header>
      <p class="hint">
        {{ t('remote.hint') }}
      </p>
      <div
        class="remote-modes"
        role="group"
        :aria-label="t('remote.title')"
      >
        <button
          type="button"
          data-test="remote-mode-live"
          :aria-pressed="mode === 'live'"
          :disabled="pending"
          @click="mode = 'live'"
        >
          {{ t('remote.live') }}
        </button>
        <button
          type="button"
          data-test="remote-mode-import"
          :aria-pressed="mode === 'import'"
          :disabled="pending"
          @click="mode = 'import'"
        >
          {{ t('remote.copy') }}
        </button>
      </div>
      <section
        v-if="connections.length"
        class="remote-connections"
      >
        <strong>{{ t('remote.connected') }}</strong>
        <div
          v-for="connection in connections"
          :key="connection.path"
          class="remote-connection"
        >
          <span :title="connection.path">{{ connection.path.split('/').pop() }} · {{ connection.connected ? t('remote.online') : t('remote.offline') }}</span>
          <button
            type="button"
            :disabled="pending"
            @click="disconnect(connection.path)"
          >
            {{ t('remote.disconnect') }}
          </button>
        </div>
      </section>
      <div class="fields">
        <label>{{ t('remote.auth') }}<SelectMenu
          :model-value="authMode"
          :options="authOptions"
          data-test="remote-auth"
          :disabled="pending"
          @update:model-value="setAuthMode"
        /></label>
        <label v-if="authMode === 'key'">{{ t('remote.identityFile') }}<input
          v-model="identityFile"
          data-test="remote-key"
          required
          :disabled="pending"
          placeholder="/home/user/.ssh/id_ed25519"
          spellcheck="false"
        ></label>
        <label v-if="authMode === 'password'">{{ t('remote.password') }}<input
          v-model="password"
          data-test="remote-password"
          type="password"
          required
          :disabled="pending"
          autocomplete="off"
        ></label>
        <label>{{ t('remote.user') }}<input
          v-model="user"
          data-test="remote-user"
          required
          autocomplete="username"
        ></label>
        <label>{{ t('remote.host') }}<input
          v-model="host"
          data-test="remote-host"
          required
          placeholder="example.org"
          spellcheck="false"
        ></label>
        <label>{{ t('remote.port') }}<input
          v-model.number="port"
          data-test="remote-port"
          type="number"
          min="1"
          max="65535"
          required
        ></label>
        <label>{{ t('remote.path') }}<input
          v-model="remotePath"
          data-test="remote-path"
          required
          placeholder="/home/user/notes"
          spellcheck="false"
        ></label>
        <label>{{ t('remote.folder') }}<input
          v-model="folder"
          data-test="remote-folder"
          required
          placeholder="remote-notes"
          spellcheck="false"
        ></label>
      </div>
      <p
        v-if="error"
        class="error"
        role="alert"
      >
        {{ error }}
      </p>
      <footer class="actions">
        <button
          type="button"
          :disabled="pending"
          @click="emit('close')"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          type="submit"
          :data-test="mode === 'live' ? 'remote-connect' : 'remote-import'"
          :disabled="pending || !user.trim() || !host.trim() || !remotePath.trim() || !folder.trim()"
        >
          {{ mode === 'live' ? (pending ? t('remote.connecting') : t('remote.connect')) : (pending ? t('remote.importing') : t('remote.import')) }}
        </button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.remote-dialog { position: fixed; top: 50%; left: 50%; translate: -50% -50%; width: min(420px, 92vw); max-height: 85vh; overflow: auto; padding: 16px; color: var(--app-text); }
.remote-head { display: flex; align-items: center; gap: 8px; font-size: 15px; }
.remote-head strong { flex: 1; }
.close { display: grid; place-items: center; border: 0; background: transparent; color: var(--app-muted); cursor: pointer; }
.hint { margin: 10px 0 14px; color: var(--app-muted); line-height: 1.5; font-size: 12px; }
.remote-modes { display: flex; gap: 2px; padding: 3px; margin-bottom: 14px; background: var(--app-panel); border-radius: 5px; }
.remote-modes button { flex: 1; border: 0; border-radius: 4px; background: transparent; color: var(--app-muted); padding: 7px; cursor: pointer; }
.remote-modes button[aria-pressed="true"] { background: var(--app-elevated); color: var(--app-text); box-shadow: 0 1px 3px #0002; }
.remote-connections { margin-bottom: 14px; font-size: 12px; }
.remote-connection { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 0; border-bottom: 1px solid var(--app-border); }
.remote-connection span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.remote-connection button { flex: none; border: 0; background: transparent; color: var(--app-accent); cursor: pointer; }
.fields { display: grid; gap: 9px; }
.fields label { display: grid; gap: 4px; font-size: 12px; color: var(--app-muted); }
.fields input, .fields .select-trigger { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid var(--app-border); border-radius: 5px; padding: 8px; background: var(--app-elevated); color: var(--app-text); font: inherit; }
.error { color: var(--app-danger); font-size: 12px; overflow-wrap: anywhere; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 17px; }
.actions button { border: 1px solid var(--app-border); border-radius: 5px; background: var(--app-elevated); color: var(--app-text); padding: 7px 12px; cursor: pointer; }
.actions button:last-child { background: var(--app-accent); border-color: var(--app-accent); color: white; }
.actions button:disabled { opacity: .55; cursor: default; }
</style>
