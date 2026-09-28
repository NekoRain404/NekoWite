<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import SelectMenu from '../../../components/SelectMenu.vue'
import { fillTemplate, planEngineSwitch, type AgentRegistryReadout, type RegistryRefusal } from '../services/agent-registry-policy'
import type { AgentRegistryLabels } from './agent-registry-labels'

const props = defineProps<{
  readout: AgentRegistryReadout | null
  profileId: string
  sessionAgentId: string | null
  canStartSession: boolean
  labels: AgentRegistryLabels
  refusalText: (refusal: RegistryRefusal | null) => string
}>()
const emit = defineEmits<{ 'new-session': [agentId: string] }>()
const selectedEngine = ref('')
const selectable = computed(() => props.readout?.entries.filter((entry) => entry.enabled) ?? [])
const engineOptions = computed(() => selectable.value.map((entry) => ({ value: entry.agentId, label: entry.displayName || entry.agentId })))
const nameOf = (agentId: string): string =>
  props.readout?.entries.find((entry) => entry.agentId === agentId)?.displayName || agentId
watch([selectable, () => props.sessionAgentId], () => {
  const preferred = props.sessionAgentId ?? props.readout?.defaultAgentId ?? ''
  if (selectable.value.some((entry) => entry.agentId === selectedEngine.value)) return
  selectedEngine.value = selectable.value.some((entry) => entry.agentId === preferred)
    ? preferred : (selectable.value[0]?.agentId ?? '')
}, { immediate: true })
const enginePlan = computed(() => props.readout === null || selectedEngine.value === '' ? null :
  planEngineSwitch({ sessionAgentId: props.sessionAgentId, agentId: selectedEngine.value,
    profileId: props.profileId, readout: props.readout }))
const engineText = computed(() => {
  if (enginePlan.value === null) return props.labels.engine.none
  if (enginePlan.value.kind === 'refused') return props.refusalText(enginePlan.value.refusal)
  const engine = nameOf(enginePlan.value.agentId)
  return enginePlan.value.kind === 'keep-session'
    ? fillTemplate(props.labels.engine.keeps, { engine }) : fillTemplate(props.labels.engine.creates, { engine })
})
</script>
<template>
  <div class="registry-engine">
    <span class="settings-label">{{ labels.engine.title }}</span>
    <span
      class="settings-note registry-engine-current"
      data-test="registry-engine-current"
    >
      {{ sessionAgentId === null ? labels.engine.none : fillTemplate(labels.engine.current, { engine: nameOf(sessionAgentId) }) }}
    </span>
    <span
      v-if="!canStartSession"
      class="settings-note"
      data-test="registry-engine-elsewhere"
    >{{ labels.engine.elsewhere }}</span>
    <template v-else>
      <label class="settings-field">
        <span>{{ labels.engine.choose }}</span>
        <SelectMenu
          :model-value="selectedEngine"
          :options="engineOptions"
          class="registry-input"
          data-test="registry-engine-select"
          @update:model-value="selectedEngine = String($event)"
        />
      </label>
      <span class="settings-note registry-engine-plan">{{ engineText }}</span>
      <button
        v-if="enginePlan?.kind === 'new-session'"
        type="button"
        class="registry-button"
        data-test="registry-new-session"
        @click="emit('new-session', selectedEngine)"
      >
        {{ fillTemplate(labels.engine.start, { engine: nameOf(selectedEngine) }) }}
      </button>
    </template>
  </div>
</template>
<style scoped src="./agent-registry-settings.css"></style>
