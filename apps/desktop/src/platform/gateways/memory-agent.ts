/**
 * The in-memory agent gateway: a runtime a test drives by hand.
 *
 * It exists so the feature layer can be written and tested with no process, no
 * network call and no credential — and, more to the point, so the awkward cases are
 * *representable*: a turn that refuses, a turn cancelled while it waits for an
 * answer, a runtime that dies mid-turn, and frames that arrive late — from a runtime
 * instance that is over, from a run that already ended, with a sequence already
 * used, or for the vault the user just left. A reducer can only be written against
 * states a double can actually produce.
 *
 * The frames it hands out pass `readAgentEvent` on the way out, so the double cannot
 * invent an event the contract does not allow. What it *can* do, deliberately, is
 * stamp a foreign identity on one: that is the late-frame case, and refusing to
 * model it would be refusing to model the race.
 *
 * What it deliberately does not produce: `timeout`, `authentication-required` and
 * `protocol-incompatible` are failures of a real runtime's startup and transport
 * (T2/T4 report them), and nothing here models a process that is slow to answer,
 * unauthenticated or speaking a different protocol version.
 */

import {
  AGENT_CAPABILITY_FEATURES,
  AgentFailure,
  type AgentCapabilityReport,
  type AgentConfigOption,
  type AgentEvent,
  type AgentGateway,
  type AgentIdentity,
  type AgentOpenRequest,
  type AgentRunResult,
  type AgentSession,
  type AgentSessionSnapshot,
} from './agent-contracts'
import {
  DEFAULT_REPLAY_LIMIT,
  MEMORY_INITIAL_MODEL_ID,
  MEMORY_MODEL_ID,
  MEMORY_MODELS,
  MEMORY_OPTIONS,
  type MemoryAgentOptions,
  type MemoryEvent,
  type MemoryRunScript,
  unverifiedCapability,
} from './memory-agent/scenario'
import {
  answerPermissionOn,
  createSession,
  dropRunPermissions,
  mintSession,
  pushEvent,
  snapshotOf,
  subscribeTo,
  wake,
  type LiveRun,
  type LiveSession,
} from './memory-agent/session'
import { runTurn } from './memory-agent/turn'

export {
  MEMORY_MODE_OPTION,
  MEMORY_MODEL_ID,
  MEMORY_MODEL_OPTION,
  MEMORY_OPTIONS,
} from './memory-agent/scenario'
export type {
  MemoryAgentOptions,
  MemoryEvent,
  MemoryEventPatches,
  MemoryRunScript,
} from './memory-agent/scenario'

export interface MemoryAgentGateway extends AgentGateway {
  /** Set what subsequent turns do; see {@link MemoryRunScript}. */
  script(script: MemoryRunScript): void
  /**
   * Emit one event out of band, as the runtime would if the frame had been queued,
   * replayed or misdelivered. The frame still has to be a valid event — only its
   * identity, run and sequence may be foreign.
   */
  emit(session: AgentSession, event: MemoryEvent): void
  /**
   * The runtime died. Turns in flight fail with `process-exited` and everything that
   * needs the engine rejects until `start` brings a new runtime up; reads of a
   * session still work, because the session's last known state outlives the process
   * that produced it.
   */
  crash(message?: string): void
}

export function createMemoryAgentGateway(options: MemoryAgentOptions): MemoryAgentGateway {
  const replayLimit = options.replayLimit ?? DEFAULT_REPLAY_LIMIT
  const sessions = new Map<string, LiveSession>()
  let sessionCount = 0
  let runCount = 0
  let epochCount = 0
  /** The current runtime instance's epoch, or null while no runtime is up. */
  let epoch: string | null = null
  /** `crash` leaves the runtime down for a different reason than `stop` does, and the
   *  code a later call gets has to say which of the two happened. */
  let dead = false
  let script: MemoryRunScript = {}

  /**
   * The epoch of the runtime instance a call addresses. A call that needs the engine
   * to *act* goes through this; a call that only reads what the host already knows
   * does not, or a crash would hide the state the UI needs in order to say what
   * happened.
   */
  function currentEpoch(): string {
    if (!epoch) throw new AgentFailure('runtime-unavailable', 'the agent runtime is not started')
    return epoch
  }

  /** A session may only be addressed by a handle its own runtime instance minted. */
  function recordFor(sessionId: string): LiveSession {
    const record = sessions.get(sessionId)
    const current = currentEpoch()
    // An id minted under another epoch means the session outlived the runtime that
    // owned it: the live runtime never opened it, so the handle is stale rather than
    // unknown, and nothing read or written through it can be trusted.
    if (!record || record.identity.runtimeEpoch !== current) {
      throw new AgentFailure(
        'session-stale',
        `session ${sessionId} belongs to an earlier runtime instance`,
      )
    }
    return record
  }

  /** A record named by a handle that `emit` addresses, live or not: a late frame, by
   *  definition, arrives for a runtime that is no longer the one running. */
  function anyRecord(sessionId: string): LiveSession {
    const record = sessions.get(sessionId)
    if (!record) {
      throw new AgentFailure(
        'session-stale',
        `session ${sessionId} was never opened by this gateway`,
      )
    }
    return record
  }

  /** A session whose engine can act: the runtime is up and the handle is current. */
  function engineCall(session: AgentSession): LiveSession {
    const record = recordFor(session.sessionId)
    if (dead) throw new AgentFailure('process-exited', 'the agent runtime exited')
    return record
  }

  /**
   * The options each session has published, seeded with the one the session opened with.
   *
   * Kept here rather than on the session record because it is the *gateway's* account of what
   * the engine would accept: the record is about the stream, and this is about the call. It is
   * what lets a test drive the frame the panel's row is built from — a value moved through
   * `setConfigOption` is published back as `config-changed`, which is how the pinned engine
   * announces its own change too (measured after every `session/set_config_option`).
   */
  const publishedOptions = new Map<string, AgentConfigOption[]>()

  function optionsOf(record: LiveSession): AgentConfigOption[] {
    // The map is seeded by `openSession`, so the fallback is the no-session case rather than a
    // second place the seed is written.
    return publishedOptions.get(record.identity.sessionId) ?? [...MEMORY_OPTIONS]
  }

  /**
   * The session's options with one of them moved, or the refusal.
   *
   * Both refusals are the engine's own rules rather than this double's invention: an option
   * this session never published, and a value the option does not offer. Whether the *engine*
   * would refuse a value it did publish is not measured, which is why the published list is the
   * boundary — the same one `selectModel` has always drawn.
   */
  function moveOption(record: LiveSession, configId: string, value: string): AgentConfigOption[] {
    const options = optionsOf(record)
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
    publishedOptions.set(record.identity.sessionId, moved)
    return moved
  }

  /** Move one of the session's own options, whatever it is — the double's one path, as the
   *  contract has one. See {@link AgentGateway.setConfigOption}. */
  async function setConfigOption(
    session: AgentSession,
    configId: string,
    value: string,
  ): Promise<void> {
    const record = engineCall(session)
    const moved = moveOption(record, configId, value)
    // The engine tells the session about its own change, and this is the frame that carries it:
    // session-scoped, so `runId` is null rather than the last turn's id.
    pushEvent(record, 'config-changed', { options: moved }, null)
  }

  return {
    async start() {
      // Starting an already-running runtime is a no-op rather than a restart: a
      // redundant call must not invalidate every open session. Coming up after
      // `crash` or `stop` is a new runtime instance and mints a new epoch, which is
      // what makes the handles of the previous one stale.
      if (epoch && !dead) return
      epochCount += 1
      epoch = `epoch-${epochCount}`
      dead = false
    },

    async stop() {
      if (epoch && !dead) {
        for (const record of sessions.values()) {
          const run = record.run
          if (!run) continue
          // The turn ends as cancelled — that is the turn's own record, and the
          // runtime is being taken down rather than failing — but the caller's
          // promise rejects: the request that would have answered it is gone with the
          // runtime, so the call did not complete.
          run.cancelled = true
          run.failure = new AgentFailure(
            'cancelled',
            'the runtime stopped while the turn was running',
          )
          wake(run)
        }
      }
      epoch = null
      dead = false
    },

    async openSession(request: AgentOpenRequest): Promise<AgentSession> {
      const current = currentEpoch()
      if (dead) throw new AgentFailure('process-exited', 'the agent runtime exited')
      sessionCount += 1
      const identity: AgentIdentity = {
        agentId: options.agentId,
        profileId: options.profileId,
        runtimeEpoch: current,
        vaultId: request.vaultId,
        sessionId: `session-${sessionCount}`,
      }
      sessions.set(identity.sessionId, createSession(identity, replayLimit))
      publishedOptions.set(identity.sessionId, [...MEMORY_OPTIONS])
      return mintSession(identity, MEMORY_MODELS, MEMORY_INITIAL_MODEL_ID, MEMORY_OPTIONS)
    },

    setConfigOption,

    async selectModel(session: AgentSession, modelId: string): Promise<void> {
      engineCall(session)
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
      await setConfigOption(session, MEMORY_MODEL_ID, modelId)
    },

    async prompt(session: AgentSession, text: string): Promise<AgentRunResult> {
      const record = engineCall(session)
      // One turn at a time per session (§6.2). A second turn would interleave two runs
      // into one stream with no way to tell which text belongs to which, so it is
      // refused here rather than run quietly — the host's own queue, not the gateway,
      // is where the next input waits.
      if (record.run) {
        throw new AgentFailure(
          'buffer-conflict',
          `session ${session.sessionId} already has a turn in flight`,
        )
      }
      runCount += 1
      const run: LiveRun = {
        runId: `run-${runCount}`,
        cancelled: false,
        failure: null,
        wake: null,
      }
      record.run = run
      record.state = 'running'
      try {
        return await runTurn(record, text, run, script)
      } finally {
        record.run = null
        dropRunPermissions(record, run.runId)
      }
    },

    async cancel(session: AgentSession): Promise<void> {
      const record = engineCall(session)
      const run = record.run
      // Cancelling a session with nothing in flight is a no-op, not a failure: the
      // user can press stop in the same instant the turn ends, and that race must not
      // surface as an error the UI would have to explain.
      if (!run) return
      run.cancelled = true
      wake(run)
    },

    async answerPermission(
      session: AgentSession,
      requestId: string,
      optionId: string,
    ): Promise<void> {
      answerPermissionOn(engineCall(session), requestId, optionId, sessions.values())
    },

    async capabilities(session: AgentSession): Promise<readonly AgentCapabilityReport[]> {
      // A handle check, not an engine call: `crash` must not hide the report, because the report is
      // what a page draws to say what the engine could not do — and a session of a *previous*
      // runtime is refused here exactly as it is everywhere else.
      recordFor(session.sessionId)
      const declared = options.capabilities ?? {}
      // Every feature, from the contract's one list, in its order: a double that answered only the
      // features a test named would be teaching a page to expect a short report, and the short
      // report is the failure §3.4's row exists to prevent.
      return AGENT_CAPABILITY_FEATURES.map((feature) => ({
        feature,
        declared: 'unverified',
        finding: declared[feature] ?? unverifiedCapability(feature),
      }))
    },

    async snapshot(session: AgentSession): Promise<AgentSessionSnapshot> {
      return snapshotOf(recordFor(session.sessionId))
    },

    async subscribe(
      from: AgentSessionSnapshot,
      onEvent: (event: AgentEvent) => void,
    ): Promise<() => void> {
      return subscribeTo(recordFor(from.identity.sessionId), from, onEvent)
    },

    script(next: MemoryRunScript) {
      script = next
    },

    emit(session: AgentSession, event: MemoryEvent) {
      const record = anyRecord(session.sessionId)
      // `null` is a value here: an event that belongs to no run must stay that way,
      // which is why the default only applies when the field was left out.
      const runId = event.runId === undefined ? record.lastRunId : event.runId
      pushEvent(record, event.kind, event.payload, runId, {
        sequence: event.sequence,
        identity: event.identity,
      })
    },

    crash(message = 'the agent runtime exited') {
      dead = true
      for (const record of sessions.values()) {
        const run = record.run
        // Only a turn suspended on a permission or on `hang` can be cut by a crash: a
        // turn with neither has already run to completion inside the synchronous burst
        // that started it.
        if (!run) continue
        run.failure = new AgentFailure('process-exited', message)
        wake(run)
      }
    },
  }
}
