import { computed, type ComputedRef } from 'vue'
import { useSettingsStore } from '../../../stores/settings'

export interface AgentPanelModel {
  /** Whether the right rail shows the agent panel instead of the chat panel. */
  agentPanel: ComputedRef<boolean>
  /** Turn it on or off. Persisted by the slice that owns the value. */
  setAgentPanel: (enabled: boolean) => void
}

/**
 * The one setting the agents section carries: which panel the right rail shows.
 *
 * The store read is here rather than in the section component (§13.11's
 * `components` 不 import `stores`), which is the same split the other sections
 * use — `use-general-settings`, `use-editor-settings` and the rest — so the
 * component only renders what this returns.
 *
 * It is deliberately a *read and a write of one boolean* and nothing more: the
 * switch's consequences (an engine that starts, a panel that is unmounted, a
 * reply that is cancelled) belong to the surfaces that feel them, which are the
 * shell and the rail, and a section that also modelled them would be a second
 * place deciding what the switch means.
 */
export function useAgentPanel(): AgentPanelModel {
  const settings = useSettingsStore()
  return {
    agentPanel: computed(() => settings.agentPanel),
    setAgentPanel: (enabled: boolean) => {
      settings.agentPanel = enabled
    },
  }
}
