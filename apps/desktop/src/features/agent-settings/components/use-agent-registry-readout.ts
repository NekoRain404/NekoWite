import { onBeforeUnmount, ref, watch } from 'vue'
import type { AgentRegistryClient, AgentRegistryReadout } from '../services/agent-registry-policy'

export function useAgentRegistryReadout(client: () => AgentRegistryClient) {
  const readout = ref<AgentRegistryReadout | null>(null)
  const loadState = ref<'loading' | 'ready' | 'unreadable'>('loading')
  let generation = 0
  let disposed = false

  async function load(): Promise<void> {
    if (disposed) return
    const token = ++generation
    const source = client()
    loadState.value = 'loading'
    try {
      const answer = await source.read()
      if (token !== generation || source !== client()) return
      readout.value = answer
      loadState.value = 'ready'
    } catch {
      if (token === generation && source === client()) loadState.value = 'unreadable'
    }
  }

  // Late answers belong to their original client and cannot replace the current registry.
  watch(client, () => { readout.value = null; void load() }, { immediate: true })
  onBeforeUnmount(() => { disposed = true; generation++ })
  return { readout, loadState, load }
}
