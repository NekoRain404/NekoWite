/**
 * The options a session has published, and the one path that moves one.
 *
 * Both refusals below are the engine's own rules rather than this double's invention — an
 * option the session never published, and a value the option does not offer — so this file
 * changes when the config-option contract does, and not when the session table or the turn
 * in flight does. `selectModel` belongs here for the contract's own reason: a model is one
 * instance of a config option, so it is moved through this same call rather than by a
 * second mechanism beside it.
 */

import {
  AgentFailure,
  type AgentConfigOption,
  type AgentConfigOptionList,
  type AgentSession,
} from '../agent-contracts'
import { MEMORY_MODEL_ID, MEMORY_OPTIONS } from './scenario'
import { pushEvent, type LiveSession } from './session'
import { engineCall, type LiveRuntime } from './runtime'

export function optionsOf(runtime: LiveRuntime, record: LiveSession): AgentConfigOption[] {
  // The map is seeded by `openSession`, so the fallback is the no-session case rather than a
  // second place the seed is written.
  return runtime.publishedOptions.get(record.identity.sessionId) ?? [...MEMORY_OPTIONS]
}

/**
 * The session's options with one of them moved, or the refusal.
 *
 * Both refusals are the engine's own rules rather than this double's invention: an option
 * this session never published, and a value the option does not offer. Whether the *engine*
 * would refuse a value it did publish is not measured, which is why the published list is the
 * boundary — the same one `selectModel` has always drawn.
 */
export function moveOption(
  runtime: LiveRuntime,
  record: LiveSession,
  configId: string,
  value: string,
): AgentConfigOption[] {
  const options = optionsOf(runtime, record)
  const option = options.find((entry) => entry.id === configId)
  if (option === undefined) {
    throw new AgentFailure(
      'invalid-response',
      `this session published no ${configId} option`,
    )
  }
  if (option.value.kind !== 'select') {
    throw new AgentFailure('invalid-response', `${configId} is not a select option`)
  }
  if (!option.value.choices.some((choice) => choice.value === value)) {
    throw new AgentFailure(
      'invalid-response',
      `${value} is not one of ${configId}'s values`,
    )
  }
  const moved = options.map((entry) =>
    entry.id === configId && entry.value.kind === 'select'
      ? { ...entry, value: { kind: 'select' as const, current: value, choices: entry.value.choices } }
      : entry,
  )
  runtime.publishedOptions.set(record.identity.sessionId, moved)
  return moved
}

/** Move one of the session's own options, whatever it is — the double's one path, as the
 *  contract has one. See {@link AgentGateway.setConfigOption}.
 *
 *  The refreshed list is the *answer* as well as the frame: a real engine returns the new full
 *  set from `session/set_config_option` and the pinned one also announces it, and a double that
 *  only announced it would let a caller which reads the answer (the panel's row does) go
 *  untested on this side. */
export async function setConfigOption(
  runtime: LiveRuntime,
  session: AgentSession,
  configId: string,
  value: string,
): Promise<AgentConfigOptionList> {
  const record = engineCall(runtime, session)
  const moved = moveOption(runtime, record, configId, value)
  // The engine tells the session about its own change, and this is the frame that carries it:
  // session-scoped, so `runId` is null rather than the last turn's id.
  pushEvent(record, 'config-changed', { options: moved }, null)
  return moved
}

export async function selectModel(
  runtime: LiveRuntime,
  session: AgentSession,
  modelId: string,
): Promise<AgentConfigOptionList> {
  engineCall(runtime, session)
  // The host refuses to forward a model it never offered, the way it refuses a
  // permission option the engine never offered (§6.3). Whether the engine itself
  // would reject the value is T4's to find out and report.
  if (!session.models.some((model) => model.id === modelId)) {
    throw new AgentFailure(
      'invalid-response',
      `model ${modelId} is not one of the session's models`,
    )
  }
  // Through the general call, as the contract's two methods relate to each other: the model
  // option is one of the session's options, and a double that moved it by a second route
  // would be the parallel mechanism the contract exists to avoid.
  return setConfigOption(runtime, session, MEMORY_MODEL_ID, modelId)
}
