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
  AgentConfigChoice,
  AgentConfigOption,
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
  /**
   * Every option `session/new` answered with, in the engine's order.
   *
   * The same answer the catalog is projected from, and the reason it is kept whole: the response
   * is not a frame, so a window that only read `config-changed` would show one control where the
   * engine reported two until something happened to change. The pinned engine reports a model
   * *and* a session mode (`agent_session_lifecycle_test.rs`'s probe: `{id: "model", name:
   * "Model", currentValue: "opencode/big-pickle"}` beside `{id: "mode", name: "Session Mode",
   * currentValue: "build"}`), and Zed's row shows both from the moment the session opens.
   */
  options: readonly AgentConfigOption[]
}

export interface SessionBook {
  /** Take the engine's answer and the runtime's epoch, and mint the handle. */
  open(identity: AgentIdentity, answer: AgentHostSession): AgentSession
  /** The record behind a handle, or the refusal — every identity field is compared. */
  recordFor(session: AgentSession): SessionRecord
  /** The same check for a plain identity: a snapshot carries the five fields without the
   *  handle's brand, and the boundary it has to pass is the same one. */
  recordOf(identity: AgentIdentity): SessionRecord
  /**
   * Forget one handle, because the engine has let that session go.
   *
   * Answers whether there was one. The caller is `closeSession`, which has already checked the
   * handle it was given; what this returns is for the case where something else removed it in
   * between, which is not an error — the session is gone either way.
   */
  close(sessionId: string): boolean
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
      // One answer, read twice: the model catalog the contract has always carried, and the whole
      // list of options the engine reported. Both are the same read of `configOptions`, so they
      // cannot come from two moments (T1's rule for the two views of this wire value).
      const projected = projectModels(answer)
      const options = readConfigOptions(answer.configOptions)
      const record: SessionRecord = { identity, ...projected, options }
      sessions.set(identity.sessionId, record)
      return mintSession(identity, { ...projected, options })
    },
    recordFor(session) {
      return recordOf(session)
    },
    recordOf,
    close(sessionId) {
      // Removed rather than marked: a handle for a session the engine has let go is a handle
      // every later call must reject, and the one place that decides is `recordOf`. A tombstone
      // would be a second kind of entry for the same question.
      return sessions.delete(sessionId)
    },
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
  projected: {
    models: readonly AgentModelOption[]
    initialModelId: string
    options: readonly AgentConfigOption[]
  },
): AgentSession {
  return {
    ...identity,
    models: projected.models,
    initialModelId: projected.initialModelId,
    options: projected.options,
  } as unknown as AgentSession
}

/**
 * Every option the engine answered `session/new` with, in the contract's shape.
 *
 * The same mapping `agent_runtime/events.rs`'s `config_option` makes for a `config-changed`
 * frame, for the same three reasons it gives: the discriminator is on the option on the wire
 * (`type`) and on the value in the contract (`value.kind`, and `toggle` where the wire says
 * `boolean`); the current value is `currentValue` there and `value.current` here; and a select's
 * choices are an untagged union on the wire — a flat list, or a list of *groups* of them — which
 * the contract holds flat. Flattening loses the group's name, which is the residual T4b §7
 * reported rather than a decision taken here.
 *
 * An option this reader cannot express is **left out** rather than sent as something it is not,
 * and the rest of the list is still read: one unreadable entry costs its own control, where
 * refusing the whole answer would cost every control on the row. The engine's own list is the
 * report, so what is kept is kept as it came — order, names and values untouched.
 */
function readConfigOptions(raw: unknown): AgentConfigOption[] {
  if (!Array.isArray(raw)) return []
  const options: AgentConfigOption[] = []
  for (const entry of raw) {
    const option = readConfigOption(entry)
    if (option !== null) options.push(option)
  }
  return options
}

function readConfigOption(entry: unknown): AgentConfigOption | null {
  if (!isRecord(entry)) return null
  const { id, name, description, type, currentValue } = entry
  if (typeof id !== 'string' || id === '' || typeof name !== 'string') return null
  const shared = description === undefined ? {} : { description: String(description) }
  if (type === 'select') {
    if (typeof currentValue !== 'string') return null
    return {
      id,
      name,
      ...shared,
      value: { kind: 'select', current: currentValue, choices: readChoices(entry.options) },
    }
  }
  if (type === 'boolean') {
    if (typeof currentValue !== 'boolean') return null
    return { id, name, ...shared, value: { kind: 'toggle', current: currentValue } }
  }
  // `SessionConfigKind` is `#[non_exhaustive]`: a type the pinned schema does not name yet is a
  // shape this adapter has no arm for, and the contract's two are the whole of what it can say.
  return null
}

/** A select's choices, flattened out of the wire's untagged union and in the engine's order. */
function readChoices(raw: unknown): AgentConfigChoice[] {
  if (!Array.isArray(raw)) return []
  const choices: AgentConfigChoice[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    // A grouped entry holds the values one level down; an ungrouped one *is* a value. The same
    // test `projectModels` makes of the same union, because it is the same union.
    const values = Array.isArray(entry.options) ? entry.options : [entry]
    for (const value of values) {
      if (!isRecord(value)) continue
      const { value: id, name, description } = value
      if (typeof id !== 'string' || typeof name !== 'string') continue
      choices.push({
        value: id,
        name,
        ...(description === undefined ? {} : { description: String(description) }),
      })
    }
  }
  return choices
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
