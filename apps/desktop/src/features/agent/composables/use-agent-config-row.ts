/**
 * The session's own configuration options, as the composer's control row draws them: what the row
 * contains, which control is being set right now, and what a refusal said.
 *
 * The row belongs to the session and the call belongs to the gateway, and this is where the two
 * meet — which is why it is neither the store's business nor the composer's. The composer takes
 * the result as props (it draws the row and reports the choice); the panel took the result as its
 * own state and this file is that state, moved out when `AgentPanel.vue` went past the size this
 * project allows one component.
 *
 * **The engine's answer is written back, and that is the half that was missing.** The command
 * returns the refreshed option list (`commands/agent.rs`), the port used to drop it, and the row
 * therefore moved only when the engine *also* announced the change as `config-changed` — true of
 * the pinned engine, and not something a caller may rely on. Both paths end in the same field, so
 * the notification now finds the list already there rather than being the only way it ever
 * arrives. A `null` answer means the list could not be read, and the row keeps the engine's last
 * known value rather than being cleared by a response nobody understood.
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type {
  AgentConfigOption,
  AgentGateway,
  AgentSession,
} from '../../../platform/gateways/agent-contracts'
import {
  configControls,
  setConfigOption,
  type AgentConfigControl,
} from '../services/agent-config-options'
import type { AgentSessionView } from '../services/agent-session-view'

export interface UseAgentConfigRowOptions {
  gateway: AgentGateway
  session: AgentSession
  /** The store's reduced view, whose `config` field the engine's frames replace whole. */
  view: ComputedRef<AgentSessionView | null>
  /**
   * Where the engine's refreshed list goes when a set is accepted. The store owns that field
   * (`stores/agent-session.ts`'s `adoptOptions`, which takes the session's key), so it is handed in
   * rather than reached for.
   */
  adopt: (options: readonly AgentConfigOption[]) => void
}

export interface AgentConfigRow {
  /** The options the row draws, in the engine's own order. */
  controls: ComputedRef<readonly AgentConfigControl[]>
  /** The control whose value is being set right now. A second choice while one is in flight is
   *  refused by the control itself (it is disabled), so this is also what the row reads to know
   *  which trigger to hold still. */
  busy: Ref<string | null>
  /** The last set that did not take. Kept rather than dropped because the row goes on showing the
   *  engine's value: without a word about it, a press that did nothing looks like a press that
   *  worked. */
  failure: Ref<{ key: string; message: string } | null>
  /** One choice in the control row. */
  set(configKey: string, value: string | boolean): Promise<void>
}

export function useAgentConfigRow(options: UseAgentConfigRowOptions): AgentConfigRow {
  /**
   * The session's own configuration options, as the composer's control row draws them.
   *
   * Read from the view — the engine's own frames, replaced whole by each `config-changed` — and
   * seeded by the session handle for as long as no frame has carried them, which is the state a
   * session is in the moment it opens. `services/agent-config-options.ts` holds that rule and the
   * reason for it; nothing here decides what the row contains, because what it contains is the
   * engine's report rather than this app's list.
   */
  const controls = computed<readonly AgentConfigControl[]>(() =>
    configControls(options.session, options.view.value?.config ?? []),
  )

  const busy = ref<string | null>(null)
  const failure = ref<{ key: string; message: string } | null>(null)

  /**
   * One choice in the control row.
   *
   * Not the store's business and not the composer's: the option belongs to the session and the
   * call belongs to the gateway, and both are here. A refusal is already reported to the reader by
   * the row that made the choice, so nothing is thrown at a click handler that could not catch it.
   */
  async function set(configKey: string, value: string | boolean): Promise<void> {
    const control = controls.value.find((entry) => entry.key === configKey)
    if (control === undefined) return
    busy.value = configKey
    failure.value = null
    const outcome = await setConfigOption(options.gateway, options.session, control, value)
    busy.value = null
    if (!outcome.accepted && outcome.reason === 'refused') {
      failure.value = { key: configKey, message: outcome.message }
    }
    if (outcome.accepted && outcome.options !== null) {
      options.adopt(outcome.options)
    }
  }

  return { controls, busy, failure, set }
}
