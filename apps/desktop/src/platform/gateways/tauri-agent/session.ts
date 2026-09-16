/**
 * The sessions this gateway opened, and what it knows about each.
 *
 * This is where the contract's session handle comes from and the only place it can come from:
 * the engine owns the session id, the host owns the runtime epoch, and a handle is the two
 * joined with the vault — which is why the contract gives `AgentSession` a phantom brand
 * (`sessionOwnership`). A window cannot construct one, and every call the gateway makes
 * compares the handle it was given against the record it minted (§6.1's composite boundary,
 * checked rather than assumed).
 *
 * The record also keeps the *projection*, not a copy of the state: `models` and
 * `initialModelId` are two views of one config option (T1's rule: "an adapter must fill both
 * from one read so they cannot disagree"), and the option's id is kept beside them because the
 * contract's `selectModel(session, modelId)` carries no option id, so the value alone would not
 * say which option to move.
 */

import type {
  AgentIdentity,
  AgentModelOption,
  AgentSession,
} from '../agent-contracts'
import { AgentFailure } from '../agent-contracts'
import type { AgentHostSession } from './ipc'
import { isRecord } from './fields'

/** What this gateway knows about one open session. */
export interface SessionRecord {
  identity: AgentIdentity
  models: readonly AgentModelOption[]
  initialModelId: string
  /** The engine's id for the option the catalog came from, or null when the engine has none. */
  modelOptionId: string | null
}

export interface SessionBook {
  /** Take the engine's answer and the runtime's epoch, and mint the handle. */
  open(identity: AgentIdentity, answer: AgentHostSession): AgentSession
  /** The record behind a handle, or the refusal — every identity field is compared. */
  recordFor(session: AgentSession): SessionRecord
  /** The same check for a plain identity: a snapshot carries the five fields without the
   *  handle's brand, and the boundary it has to pass is the same one. */
  recordOf(identity: AgentIdentity): SessionRecord
  /** Forget every handle: the runtime that minted them is over. */
  clear(): void
}

/**
 * `started` is asked rather than told, because the two refusals a stale handle can earn are
 * different facts: with no runtime up, nothing can be addressed at all (`runtime-unavailable`);
 * with one up, a handle it did not mint is `session-stale` — the id belongs to an earlier
 * incarnation, and §6.2 requires the UI to be able to tell those apart.
 */
export function createSessionBook(started: () => boolean): SessionBook {
  const sessions = new Map<string, SessionRecord>()

  function recordOf(identity: AgentIdentity): SessionRecord {
    if (!started()) {
      throw new AgentFailure('runtime-unavailable', 'the agent runtime is not started')
    }
    const record = sessions.get(identity.sessionId)
    if (!record) {
      throw new AgentFailure('session-stale', `session ${identity.sessionId} is not open here`)
    }
    const known: AgentIdentity = record.identity
    for (const field of ['agentId', 'profileId', 'runtimeEpoch', 'vaultId'] as const) {
      if (identity[field] !== known[field]) {
        throw new AgentFailure(
          'session-stale',
          `session ${identity.sessionId} is not the one this window opened: ${field} differs`,
        )
      }
    }
    return record
  }

  return {
    open(identity, answer) {
      const projected = projectModels(answer)
      const record: SessionRecord = { identity, ...projected }
      sessions.set(identity.sessionId, record)
      return mintSession(identity, projected)
    },
    recordFor(session) {
      return recordOf(session)
    },
    recordOf,
    clear() {
      sessions.clear()
    },
  }
}

/**
 * Mint the handle for a session this gateway opened.
 *
 * The two-step cast is what the contract's brand is for: `sessionOwnership` is a phantom
 * property, so a plain object is not assignable to `AgentSession` and the only values of that
 * type are the ones a gateway made here. It is the same cast `memory-agent/session.ts` uses,
 * for the same reason.
 */
function mintSession(
  identity: AgentIdentity,
  projected: { models: readonly AgentModelOption[]; initialModelId: string },
): AgentSession {
  return {
    ...identity,
    models: projected.models,
    initialModelId: projected.initialModelId,
  } as unknown as AgentSession
}

/**
 * The model catalog, projected from the config option the host named.
 *
 * One read, both halves (T1's rule for the two views of this wire value). The option's list is
 * an untagged union on the wire — a flat list of values, or a list of groups of them — so both
 * arms are flattened here. What is lost in the grouped case is the grouping: the contract's
 * `AgentModelOption` is an id and a name, and a selector that wanted the headers would need a
 * field the contract does not have. Reported rather than invented.
 *
 * The option's *id* is the engine's, which is why the host answers it
 * (`AgentAdapter::model_option_id` on the Rust side) rather than this file looking for an
 * option whose name or shape happens to suggest a model: §3.4 forbids an engine assumption in
 * either direction.
 */
function projectModels(answer: AgentHostSession): {
  models: readonly AgentModelOption[]
  initialModelId: string
  modelOptionId: string | null
} {
  const options = Array.isArray(answer.configOptions) ? answer.configOptions : []
  const option = options.find(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry.id === answer.modelOptionId,
  )
  const current = option && typeof option.currentValue === 'string' ? option.currentValue : ''
  const models: AgentModelOption[] = []
  if (option && Array.isArray(option.options)) {
    for (const entry of option.options) {
      if (!isRecord(entry)) continue
      // A grouped entry holds the values one level down; an ungrouped one *is* a value.
      const values = Array.isArray(entry.options) ? entry.options : [entry]
      for (const value of values) {
        if (isRecord(value) && typeof value.value === 'string' && typeof value.name === 'string') {
          models.push({ id: value.value, name: value.name })
        }
      }
    }
  }
  return { models, initialModelId: current, modelOptionId: answer.modelOptionId }
}
