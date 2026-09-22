import type { AgentSession } from '../platform/gateways/agent-contracts'
import type { AgentComposition } from './agent-composition'
import { t } from '../i18n'
import type { AgentRailState } from './agent-rail-contracts'
import type { PetTaskKey } from '../platform/gateways/pet-contracts'

export function taskUnavailableSentence(live: AgentRailState, key: PetTaskKey): string {
  if ((live.kind === 'live' || live.kind === 'starting') && live.vaultId !== key.vaultId) {
    return t('agent.rail.taskUnavailable.elsewhere', { showing: live.vaultId })
  }
  if (live.kind === 'live') return t('agent.rail.taskUnavailable.otherEngine', { engine: live.engineName })
  if (live.kind === 'starting') return t('agent.rail.taskUnavailable.starting')
  return t('agent.rail.taskUnavailable.noRuntime', { vault: key.vaultId })
}

/** Epochs keep identical engine session ids from sharing a mounted panel. */
export function railKey(session: AgentSession): string {
  return `${session.runtimeEpoch}:${session.sessionId}`
}

/** Registry read failure must not turn an already-open session into a startup refusal. */
export async function engineNameFor(composition: AgentComposition, agentId: string): Promise<string> {
  try {
    const readout = await composition.registry.read()
    const name = readout.entries.find((entry) => entry.agentId === agentId)?.displayName
    return name !== undefined && name.trim() !== '' ? name : agentId
  } catch {
    return agentId
  }
}

export function failureSentence(error: unknown): string {
  if (typeof error === 'string' && error.trim().length > 0) return error
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return t('agent.rail.unknownFailure')
}
