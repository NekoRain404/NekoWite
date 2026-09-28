<script setup lang="ts">
import { ref } from 'vue'
import type { AgentDiscoveryCandidate, AgentRegistryClient } from '../services/agent-registry-policy'
import type { AgentRegistryLabels } from './agent-registry-labels'
const props = defineProps<{ client: AgentRegistryClient; labels: AgentRegistryLabels }>()
const emit = defineEmits<{ use: [candidate: AgentDiscoveryCandidate] }>()
const discovered = ref<readonly AgentDiscoveryCandidate[]>([])
const discoveryBusy = ref(false)
const discoveryFailed = ref(false)
async function discover(): Promise<void> {
  discoveryBusy.value = true
  discoveryFailed.value = false
  try {
    discovered.value = await props.client.discover?.() ?? []
  } catch {
    discoveryFailed.value = true
  } finally {
    discoveryBusy.value = false
  }
}
</script>
<template>
  <div class="registry-discovery">
    <div class="registry-discovery-heading">
      <div>
        <span class="settings-label">{{ labels.discovery.title }}</span>
        <span class="settings-note">{{ labels.discovery.hint }}</span>
      </div>
      <button
        type="button"
        class="registry-button"
        :disabled="discoveryBusy"
        data-test="registry-discover"
        @click="discover"
      >
        {{ discoveryBusy ? labels.discovery.scanning : labels.discovery.scan }}
      </button>
    </div>
    <span
      v-if="discoveryFailed"
      class="settings-note is-error"
    >{{ labels.discovery.failed }}</span>
    <ul
      v-else-if="discovered.length"
      class="registry-discovery-list"
    >
      <li
        v-for="candidate in discovered"
        :key="candidate.agentId"
        class="registry-discovery-row"
      >
        <div>
          <strong>{{ candidate.displayName }}</strong>
          <span class="settings-note">
            {{ labels.discovery.acp }} · {{ candidate.available ? candidate.program : labels.discovery.unavailable }}
          </span>
        </div>
        <button
          type="button"
          class="registry-button"
          :disabled="!candidate.available"
          @click="emit('use', candidate)"
        >
          {{ labels.discovery.use }}
        </button>
      </li>
    </ul>
    <span
      v-else
      class="settings-note"
    >{{ labels.discovery.empty }}</span>
  </div>
</template>
<style scoped>
.registry-discovery { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px solid var(--app-border); }
.registry-discovery-heading, .registry-discovery-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.registry-discovery-heading > div, .registry-discovery-row > div { display: flex; flex-direction: column; gap: 3px; min-width: 0; overflow-wrap: anywhere; }
.registry-discovery-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.registry-discovery-row { padding: 7px 8px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); }
.settings-label { font-size: 10px; font-weight: 600; color: var(--app-muted); }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.is-error { color: var(--app-danger); }
.registry-button { flex-shrink: 0; font: inherit; font-size: 11px; padding: 4px 10px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-accent); color: var(--app-accent-contrast); cursor: pointer; }
.registry-button:disabled { opacity: 0.5; cursor: default; }
</style>
