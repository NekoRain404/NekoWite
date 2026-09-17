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
  type AgentConfigOptionList,
  type AgentEvent,
  type AgentGateway,
  type AgentIdentity,
  type AgentOpenRequest,
  type AgentRunResult,
  type AgentSession,
  type AgentSessionHistory,
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
    // unknown, and nothing read or written through it can be trusted. A *closed* one is
    // the same refusal for a different reason — the engine stopped serving it — and
    // both are `session-stale` because both mean the handle addresses nothing live.
    if (!record || record.closed || record.identity.runtimeEpoch !== current) {
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
   *  contract has one. See {@link AgentGateway.setConfigOption}.
   *
   *  The refreshed list is the *answer* as well as the frame: a real engine returns the new full
   *  set from `session/set_config_option` and the pinned one also announces it, and a double that
   *  only announced it would let a caller which reads the answer (the panel's row does) go
   *  untested on this side. */
  async function setConfigOption(
    session: AgentSession,
    configId: string,
    value: string,
  ): Promise<AgentConfigOptionList> {
    const record = engineCall(session)
    const moved = moveOption(record, configId, value)
    // The engine tells the session about its own change, and this is the frame that carries it:
    // session-scoped, so `runId` is null rather than the last turn's id.
    pushEvent(record, 'config-changed', { options: moved }, null)
    return moved
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
      sessions.set(
        identity.sessionId,
        createSession(identity, replayLimit, request.cwd, sessionCount),
      )
      publishedOptions.set(identity.sessionId, [...MEMORY_OPTIONS])
      // No title on the handle: the record above has one (`createSession` writes the shape the
      // pinned engine was measured using), but nothing has *stated* it to a window yet — a new
      // session's name is read from `session/list` or not at all, which is the same reason
      // `agent_open_session` answers no title in the real host.
      return mintSession(identity, MEMORY_MODELS, MEMORY_INITIAL_MODEL_ID, MEMORY_OPTIONS, null)
    },

    /**
     * Every session this runtime *knows about* — which is more than the ones it currently
     * serves, and that is the point.
     *
     * A real engine's session table outlives the process that wrote it: the sessions a previous
     * `stop` closed are still there, which is what makes reopening yesterday's conversation
     * possible at all. The double already keeps them (`stop` clears the epoch, not the map;
     * `recordFor` is what refuses a stale handle), so this reads the map rather than a second
     * store — a history kept anywhere else would be the double's own invention rather than a
     * model of the engine's.
     */
    async listSessions(): Promise<AgentSessionHistory> {
      currentEpoch()
      if (dead) throw new AgentFailure('process-exited', 'the agent runtime exited')
      return {
        sessions: [...sessions.values()].map((record) => ({
          sessionId: record.identity.sessionId,
          cwd: record.cwd,
          title: record.title,
          updatedAt: record.updatedAt,
          // The two halves of the table are two halves here too, which is what makes this row the
          // one the production boundary is about: the engine's table is every record, and this
          // runtime instance holds only the ones its own epoch minted (and that a close has not
          // let go). `recordFor` refuses exactly those, so a row this is false for is a row
          // `closeSession` will not act on — the same predicate, read here instead of answered
          // per call.
          held: !record.closed && record.identity.runtimeEpoch === currentEpoch(),
        })),
        // One page, which is what the pinned engine was measured answering — and an honest
        // `null` rather than a fabricated cursor, because a cursor the engine never issued is a
        // page this double could not serve.
        nextCursor: null,
      }
    },

    /**
     * Re-adopt a session this engine already holds, under the current runtime's epoch.
     *
     * **The conversation comes back**, which is the whole reason `load` exists and the one thing
     * a double that merely re-registered the id would fail to model: the previous record's
     * replay tail is pushed into the revived one as ordinary events, stamped with the new epoch
     * and the new sequences. That is what the pinned engine's own replay looks like from the
     * host's side — `agent_session_replay_live_test.rs` measures it arriving as `session/update`
     * frames during the call — so a panel written against this double is written against the
     * real shape.
     *
     * Both refusals are the engine's:
     *
     *  - an id the engine does not hold is not one it can reopen;
     *  - an id it *currently serves* is already open — a load is for a session that is not.
     */
    async loadSession(sessionId: string, request: AgentOpenRequest): Promise<AgentSession> {
      const current = currentEpoch()
      if (dead) throw new AgentFailure('process-exited', 'the agent runtime exited')
      const existing = sessions.get(sessionId)
      if (!existing) {
        throw new AgentFailure(
          'session-stale',
          `session ${sessionId} is not one this engine holds`,
        )
      }
      // A *closed* session is not open, however fresh its epoch: the host removes it from its
      // table on a close (`AgentRuntime::close_session`), so the same load it accepts is one this
      // double must accept too. Refusing on the epoch alone made a freed row permanently
      // unreopenable here and nowhere else.
      if (existing.identity.runtimeEpoch === current && !existing.closed) {
        throw new AgentFailure(
          'session-stale',
          `session ${sessionId} is already open in this runtime`,
        )
      }
      const identity: AgentIdentity = {
        agentId: options.agentId,
        profileId: options.profileId,
        runtimeEpoch: current,
        vaultId: request.vaultId,
        sessionId,
      }
      const revived = createSession(identity, replayLimit, existing.cwd, sessionCount + 1)
      // **A load replays under a run of its own**, and that is the host's shape rather than a
      // convenience here: `AgentRuntime::load_session` mints `load-N` before it sends the request
      // and stamps the replayed frames with it, because `runs::forward_update` attaches turn
      // content to the run a session has in flight and a session with no run drops every replayed
      // text frame. The window's reducer makes the same refusal from the other side — a
      // turn-scoped frame naming no turn is `unattributed-run`, dropped in both modes
      // (`agent-event-reducer.ts`). A double that stamped `null` here therefore modelled a load
      // whose conversation never reaches the reader, which is the one thing `load` exists for;
      // `agent_session_replay_live_test.rs` measured the same frames arriving under `load-0` from
      // the real engine.
      runCount += 1
      const loadRun = `load-${runCount}`
      // **The restored conversation has both halves.** Each run's user turn is replayed before the
      // run's own content, which is the order the pinned engine was measured replaying in — a
      // `user-delta` carrying the prompt verbatim, then the run's thought and answer chunks, all
      // under `load-0` (`agent_session_replay_live_test.rs`). The half was missing here for the
      // same reason it was missing from the runtime: nothing produced it. `session.ts`'s
      // `LiveSession.prompts` is the engine's store, and this is the one call that reads it.
      const prompts = new Map(existing.prompts.map((prompt) => [prompt.runId, prompt.text]))
      const announced = new Set<string>()
      for (const event of existing.buffer) {
        // Announced at the first frame of the run that can be placed, so a run whose content this
        // double does not replay carries no user turn either — the double says only what it can
        // show, and inventing a lone prompt with nothing after it would be a shape no measurement
        // covers.
        if (
          event.runId !== null &&
          !announced.has(event.runId) &&
          (event.kind === 'text-delta' || event.kind === 'thought-delta' || event.kind === 'tool-update')
        ) {
          announced.add(event.runId)
          const text = prompts.get(event.runId)
          if (text !== undefined) pushEvent(revived, 'user-delta', { text }, loadRun)
        }
        switch (event.kind) {
          case 'text-delta':
            pushEvent(revived, 'text-delta', event.payload, loadRun)
            break
          case 'thought-delta':
            pushEvent(revived, 'thought-delta', event.payload, loadRun)
            break
          case 'tool-update':
            pushEvent(revived, 'tool-update', event.payload, loadRun)
            break
          // Everything else is either session-scoped state the engine re-announces on its own
          // (`commands-changed`, `config-changed`) or a turn's ending, which belongs to the turn
          // that produced it rather than to the restored conversation.
          default:
            break
        }
      }
      sessions.set(sessionId, revived)
      publishedOptions.set(sessionId, [...MEMORY_OPTIONS])
      // The name the engine's table already held for it, carried onto the handle: a reopen is the
      // one path where a window has been told what the session is called (the row it picked), and
      // the load answer itself carries none — the real adapter reads the same string off the same
      // `session/list` page.
      return mintSession(
        identity,
        MEMORY_MODELS,
        MEMORY_INITIAL_MODEL_ID,
        MEMORY_OPTIONS,
        existing.title,
      )
    },

    /**
     * Let a session go, and forget its handle.
     *
     * The record is **kept**, not deleted, and that is the engine's own measured behaviour rather
     * than the double being lenient: a close was measured leaving the session in `session/list`
     * (`agent_session_lifecycle_test.rs` §4.4 — removing it is `session/delete`, which the pinned
     * engine answers `-32601` for). So the session stops being served here, its handle goes
     * stale, and it stays in the history — which is exactly the state a panel has to be able to
     * draw, and the reason `closeSession` is not called "delete".
     */
    async closeSession(sessionId: string): Promise<void> {
      // By id, like the contract's — a handle is not needed, because the row a history surface
      // frees may be one this runtime serves *without* the window holding a handle for it (that
      // is the case the by-id shape exists for). But an id must still be one **this runtime
      // instance** holds: the host refuses before the engine is asked (`known_session`, §6.1), so
      // a session left over from an earlier epoch is a refusal here too. `recordFor` is that
      // predicate, and it is the same one the list's `held` flag is computed from — which is what
      // keeps a green test from modelling a call production answers with its own refusal.
      const record = recordFor(sessionId)
      if (dead) throw new AgentFailure('process-exited', 'the agent runtime exited')
      if (dead) throw new AgentFailure('process-exited', 'the agent runtime exited')
      const run = record.run
      if (run) {
        // ACP's own words for a close: the agent "must cancel any ongoing work related to the
        // session". In the double a turn runs synchronously inside `prompt`, so the only turn
        // that can be in flight here is one suspended on a permission or on `hang` — the same
        // pair `crash` cuts.
        run.cancelled = true
        run.failure = new AgentFailure('cancelled', 'the session was closed while the turn ran')
        wake(run)
        record.run = null
      }
      // Marked rather than removed: the handle is now dead (so every call through it refuses)
      // while the session itself stays in the table, which is the state the engine was measured
      // leaving behind.
      record.closed = true
      publishedOptions.delete(sessionId)
    },

    setConfigOption,

    async selectModel(session: AgentSession, modelId: string): Promise<AgentConfigOptionList> {
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
      return setConfigOption(session, MEMORY_MODEL_ID, modelId)
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
