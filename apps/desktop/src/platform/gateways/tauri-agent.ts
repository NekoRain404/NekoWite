/**
 * The real agent gateway: the contract's `AgentGateway` on top of the window's IPC.
 *
 * It is the second implementation of the interface `platform/gateways/agent-contracts.ts`
 * states — `memory-agent.ts` is the other — and the two are interchangeable at the composition
 * site (§9: `app/agent-composition.ts` injects one or the other). Nothing in `features/agent`
 * may tell which one it has, and this file keeps that true from its own side: it imports no
 * JSON-RPC, no ACP type and no engine name, and every Tauri call it makes is behind the
 * `AgentIpc` port in `tauri-agent/ipc.ts`.
 *
 * ## What the double gets for free and this file has to do
 *
 * The double *is* the runtime and the gateway in one object; here they are a process away, and
 * four things that cost nothing there are deliberate work here — each in its own module, by
 * subject:
 *
 *  - **`frames.ts` / `tools.ts`** — the mapping from the runtime's frames to the contract's
 *    events, which is where the two vocabularies are reconciled. It is the reason this task
 *    exists; `frames.ts`'s header states all three disagreements and which side moved.
 *  - **`session.ts`** — the session handle, which only a gateway may mint, and the model
 *    catalog projected from the option the host names.
 *  - **`channel.ts`** — one removable registration of the host's event channel, and the
 *    snapshot-then-subscribe handshake §6.2 requires.
 *
 * What is left here is the gateway surface itself and the two pieces of bookkeeping that belong
 * to no single one of those: the runtime handle, and the promises of the turns in flight.
 *
 * ## The turn promises, and why the frames settle them
 *
 * `prompt` resolves when the turn ends, and a turn ends as an *event*: the Rust runtime's
 * `prompt` returns the host's run id immediately (`runs.rs`) and the story is finished by
 * `run-finished` or `run-failed`. So a promise here is settled by the frame stream — with the
 * ordering race the store documents in its own header, in which the engine's reaction can be
 * delivered *before* the call that asked for it returns, which is why an ending for a run whose
 * id has not been learned yet is parked rather than dropped.
 *
 * ## The latch, and what may release it
 *
 * One turn at a time per session (§6.2), held in this adapter's own `running` table. Its invariant
 * is "a turn is in flight", so **anything that proves no turn is in flight releases it** — and
 * that set, not the ending frame alone, is what this adapter holds to:
 *
 *  - an ending frame for the run (the ordinary path), or `ipc.prompt` rejecting, which means no
 *    run was started at all;
 *  - **`closeSession`**: the engine has let the session go (`agent_close_session` drops the host's
 *    slot, and `runs.rs`'s `finish_run` publishes nothing for a slot that is gone), so nothing can
 *    be in flight on it — and the turn is ended here rather than abandoned, because the ending it
 *    was waiting for can never be sent;
 *  - **`stop`**: the runtime that could hold a turn is over, whatever the bookkeeping was in the
 *    middle of, so every latch it minted goes with it.
 *
 * Deliberately *not* in that set is `cancel`. This repository's ruling is that a cancel is a
 * request and not an outcome (`features/agent/stores/agent-session.ts`: "Marking it locally would
 * be the host claiming an ending it has not been told about"), and a latch released on one would
 * let a second turn onto a session whose first may still be running — the interleaving §6.2
 * forbids, and the reason the refusal exists at all.
 *
 * **A latch held past the runtime's own bound is reported rather than kept.** The bound — the
 * host's own on a generation, plus a delivery allowance — is `turn-bound.ts`'s subject, and what
 * this file does with it is arm one deadline per turn: past it, the turn is failed as `timeout`
 * rather than waited on forever. Without that net, an engine whose ending never arrives (a host
 * that publishes none, a transport that says nothing) leaves the session unsendable for the life
 * of the runtime; with it, the worst case is a reported turn rather than a silent one.
 *
 * Every release is matched on the turn's own token, so a turn winding down cannot free the latch
 * of the turn that replaced it — a release that could would be the interleaving §6.2 forbids,
 * arrived at by repair.
 */

import {
  AgentFailure,
  readCapabilityReports,
  readSessionHistory,
  type AgentCapabilityReport,
  type AgentConfigOptionList,
  type AgentEvent,
  type AgentGateway,
  type AgentIdentity,
  type AgentOpenRequest,
  type AgentPromptAttachment,
  type AgentRunResult,
  type AgentSession,
  type AgentSessionHistory,
  type AgentSessionSnapshot,
} from './agent-contracts'
import { createEventChannel, checkSnapshot, mapAll, readHostState } from './tauri-agent/channel'
import { KEY_SEPARATOR } from './tauri-agent/fields'
import { ToolProjection } from './tauri-agent/tools'
import {
  createTauriAgentIpc,
  type AgentIpc,
  type AgentRuntimeHandle,
} from './tauri-agent/ipc'
import { createSessionBook, readRefreshedOptions } from './tauri-agent/session'
import { expiredTurn, TURN_LIVENESS_BOUND_MS } from './tauri-agent/turn-bound'

export { AGENT_EVENT_CHANNEL, createTauriAgentIpc } from './tauri-agent/ipc'
export type { AgentIpc, AgentRuntimeHandle } from './tauri-agent/ipc'
export { mapHostFrame, readFrameShape } from './tauri-agent/frames'
export type { FrameShape } from './tauri-agent/frames'
export { ToolProjection } from './tauri-agent/tools'
export type { PublishedToolCall } from './tauri-agent/tools'

export interface TauriAgentOptions {
  /**
   * The vault a runtime is started for.
   *
   * Required, and not taken from `AgentOpenRequest`: a runtime instance is per
   * (agent, profile, vault) — §6.2's identity says so, and the Rust registry refuses to run two
   * engines for one triple — while the contract's `start()` takes no argument, so the vault has
   * to arrive with the gateway. The composition site is the only place that knows it.
   */
  vaultId: string
  /** The IPC port. Defaults to the window's; a test hands in its own. */
  ipc?: AgentIpc
  /**
   * Where a frame this window could not use is reported when it belongs to no run.
   *
   * It has to be *somewhere*: the whole failure this adapter exists to prevent is a frame that
   * fails quietly. A frame that belongs to a run is reported through that run instead (see
   * `frames.ts`), so what arrives here is the smaller set — the command list, a permission
   * request, a frame with no identity. Defaults to the console; the composition site can put it
   * in front of the user instead.
   */
  onUnmappable?: (failure: AgentFailure) => void
}

/** A prompt that has been sent and not yet ended. */
interface PendingRun {
  settle(result: AgentRunResult): void
  fail(failure: AgentFailure): void
  /** The host's id for the run, once `agent_prompt` has returned it. */
  runId: string | null
  /**
   * The session the turn belongs to.
   *
   * Kept because one caller has only the *id* to go on: `closeSession` takes a session id
   * (`AgentGateway.closeSession`), and it is the call that has to end the turn that id was
   * running.
   */
  sessionId: string
}

export function createTauriAgentGateway(options: TauriAgentOptions): AgentGateway {
  const ipc = options.ipc ?? createTauriAgentIpc()
  const report =
    options.onUnmappable ??
    ((failure) => console.error(`[NekoWite] an agent frame was dropped: ${failure.message}`))
  const tools = new ToolProjection()
  const pending = new Map<string, PendingRun>()
  /**
   * The turn each session has in flight, by session id — §6.2's one active generation per session.
   *
   * The value is the turn's own token rather than a marker, because a release has to belong to the
   * turn making it: a `finally` can run after the session was reopened and a new turn took the
   * latch, and a release matched on the id alone would free a latch it no longer owns — which is
   * precisely the interleaving this holds shut (see the header).
   */
  const running = new Map<string, symbol>()
  /** A session whose `agent_prompt` call is in flight, the turn that is starting, and any ending
   *  that arrived first. */
  let starting: { sessionId: string; turn: symbol; parked: AgentEvent[] } | null = null
  /** The live runtime instance, or null before `start` / after `stop`. */
  let runtime: AgentRuntimeHandle | null = null

  const book = createSessionBook(() => runtime !== null)
  /**
   * The names the engine gave the sessions in its most recent `session/list` answer, by id.
   *
   * Kept because a *reopen* needs a title the load call cannot carry: ACP's load response has no
   * title field, and the frame that would state one (`SessionInfoUpdate`) is not mapped, so the
   * row the reader picked from is the only place this app ever reads a session's name — and the
   * row is answered to *this* adapter (`listSessions`), which is where it is held until the pick
   * it belongs to (`loadSession`) asks for it. A name the engine wrote is the only thing that can
   * enter this map, which is what keeps the bar from ever drawing a name this app made up.
   *
   * Replaced rather than merged on every list — a page is the engine's answer about the sessions
   * that exist, and a name from a list two reads ago is a claim nothing has asked the engine
   * again — and cleared with the handles, because an id alone does not survive a runtime the way
   * a session id of the same engine does (the epoch is part of every handle).
   */
  let listedTitles = new Map<string, string>()
  const channel = createEventChannel({
    ipc,
    tools,
    report,
    onFrame(event) {
      if (event.kind === 'run-finished' || event.kind === 'run-failed') settle(event)
    },
  })

  function runKey(identity: AgentIdentity, runId: string): string {
    return [identity.agentId, identity.profileId, identity.runtimeEpoch, identity.sessionId,
      runId].join(KEY_SEPARATOR)
  }

  /**
   * Give a session's latch back — if this turn is the one holding it.
   *
   * The check is the whole of the function, and it is what keeps the release from being a way
   * around the latch: a turn that failed after its session was reopened must not free the latch
   * its successor took, or the next prompt would be allowed onto a session that already has a turn
   * in flight (§6.2, and the header's own account of what that costs).
   */
  function releaseTurn(sessionId: string, turn: symbol): void {
    if (running.get(sessionId) === turn) running.delete(sessionId)
  }

  /**
   * End the turn a session was running, because the session itself is gone.
   *
   * `closeSession` is the one caller. `agent_close_session` drops the host's slot and `runs.rs`'s
   * `finish_run` publishes no ending for a slot that is gone, so the frame this turn was waiting
   * for can never be sent: the promise is ended here with the host's own word for a turn that was
   * stopped rather than finished, and the latch is released by that turn's own `finally`.
   */
  function endTurnFor(sessionId: string, message: string): void {
    for (const run of pending.values()) {
      if (run.sessionId !== sessionId) continue
      run.fail(new AgentFailure('cancelled', message))
      return
    }
    // No pending entry: the turn is still inside its own `agent_prompt` call, which cannot be
    // failed from here. Its latch is released by the token it took — safely, because that token is
    // this session's only turn — and its call will fail on its own, the host it addressed no
    // longer holding the session.
    if (starting !== null && starting.sessionId === sessionId) {
      releaseTurn(sessionId, starting.turn)
    }
  }

  /**
   * Settle the promise of the turn this frame ends.
   *
   * The parked half is the race, not a precaution: `run-finished` for a run whose id the
   * adapter has not learned yet would otherwise be dropped, leaving `prompt` waiting on a turn
   * that is over — which is the failure mode the whole task is about.
   */
  function settle(event: AgentEvent): void {
    if (event.runId === null) return
    const run = pending.get(runKey(event, event.runId))
    if (run) {
      finish(run, event)
      return
    }
    if (starting !== null && starting.sessionId === event.sessionId) {
      starting.parked.push(event)
    }
  }

  function finish(run: PendingRun, event: AgentEvent): void {
    // Removed before settling: the promise's continuation may start the next turn, and a key
    // that is still present would make that turn's first frame look like this one's.
    for (const [key, entry] of pending) {
      if (entry === run) pending.delete(key)
    }
    // A switch rather than a pair of ifs: `AgentEvent` is a mapped union, and switching on the
    // discriminant is what narrows `payload` to the arm the kind names.
    switch (event.kind) {
      case 'run-finished':
        run.settle({ stopReason: event.payload.stopReason, usage: event.payload.usage })
        return
      case 'run-failed':
        run.fail(new AgentFailure(event.payload.code, event.payload.message))
        return
      default:
        return
    }
  }

  /**
   * Move one of the session's own options, whichever one it is.
   *
   * One path for both public calls, because there is one protocol call behind them
   * (`session/set_config_option`, id and value as the engine defined them) and one boundary in
   * front of it: the handle has to be one this gateway minted for a runtime that is still the
   * live one (§6.1). `selectModel` is the model's name for this, and adds the one check only a
   * model can carry — that the value is in the catalog this session published.
   *
   * The engine's answer is read rather than dropped: it is the refreshed option list, in the
   * same schema shape the session opened with, and `readRefreshedOptions` is the same reader
   * `openSession` uses. `null` means the answer was not a list this window can read, which the
   * caller must treat as "nothing changed" rather than "no options" — see
   * {@link AgentGateway.setConfigOption}.
   */
  async function setConfigOption(
    session: AgentSession,
    configId: string,
    value: string,
  ): Promise<AgentConfigOptionList> {
    book.recordFor(session)
    return readRefreshedOptions(await ipc.selectModel(session.sessionId, configId, value))
  }

  return {
    async start(): Promise<void> {
      // A redundant start is a no-op, like the double's: it must not invalidate the handles a
      // window is already holding.
      if (runtime !== null) return
      runtime = await ipc.start(options.vaultId)
    },

    async stop(): Promise<void> {
      if (runtime === null) return
      await ipc.stop()
      runtime = null
      // The turns in flight are ended rather than abandoned, and the caller's promise rejects:
      // the request that would have answered it is gone with the runtime.
      const failure = new AgentFailure('cancelled', 'the runtime stopped while the turn was running')
      for (const run of [...pending.values()]) run.fail(failure)
      pending.clear()
      // The latch goes with the runtime, and not only through the turns that were pending: a turn
      // whose `agent_prompt` call has not answered yet has no pending entry to fail, and it is the
      // one that would have held its session for the life of the next runtime. A turn cannot be in
      // flight in a runtime that is over, so nothing is claimed by clearing this — and the release
      // a still-winding-down turn performs on its way out is matched on its own token, so it
      // cannot free a later turn's latch (see `releaseTurn`).
      running.clear()
      // The handles name a runtime that is over, and the projection is keyed by its epoch. The
      // listed names go with them: a session id is the engine's, but "the last list this window
      // read" is not, and a row picked before the stop is not one the next runtime answered for.
      book.clear()
      listedTitles = new Map()
      await channel.closeAll()
    },

    async openSession(request: AgentOpenRequest): Promise<AgentSession> {
      if (runtime === null) {
        throw new AgentFailure('runtime-unavailable', 'the agent runtime is not started')
      }
      const answer = await ipc.openSession(request.vaultId, request.cwd)
      const identity: AgentIdentity = {
        ...runtime,
        vaultId: request.vaultId,
        sessionId: answer.sessionId,
      }
      // A new session has no name: the engine names one on its own terms, and nothing has stated
      // one by the time this call answers.
      return book.open(identity, answer, null)
    },

    async listSessions(cursor?: string): Promise<AgentSessionHistory> {
      // The runtime check is this adapter's, not the host's: `agent_list_sessions` needs a live
      // session slot to reach the runtime through, so without one it would refuse with the host's
      // own sentence. Answering the contract's `runtime-unavailable` here instead is the same fact
      // said in the vocabulary every other call on this gateway already uses, and it keeps a
      // caller from having to know which of the two wordings means "not started".
      if (runtime === null) {
        throw new AgentFailure('runtime-unavailable', 'the agent runtime is not started')
      }
      const answer = await ipc.listSessions(cursor)
      const history = readSessionHistory(answer)
      if (history === null) {
        // A rejected read, not an empty history — for the reason `capabilities` gives about a
        // rejected capability report: a shorter list would reach the panel as "this engine holds
        // no sessions", which is a claim about the engine made from a frame this window could
        // not read.
        throw new AgentFailure(
          'invalid-response',
          'the host answered a session list this window could not read',
        )
      }
      // Held for the reopen this page is read *for*: it is the only place a session's name is
      // ever stated by the engine, and the pick that follows is answered by `loadSession`, one
      // method down. Read after the refusal check, so a page this window could not read leaves
      // the names of the last good answer alone rather than half-replacing them.
      listedTitles = new Map(
        history.sessions.flatMap((row) => (row.title === null ? [] : [[row.sessionId, row.title]])),
      )
      return history
    },

    async loadSession(sessionId: string, request: AgentOpenRequest): Promise<AgentSession> {
      if (runtime === null) {
        throw new AgentFailure('runtime-unavailable', 'the agent runtime is not started')
      }
      // The same call the host makes for a new session, one method over: `agent_load_session`
      // answers the identical handle shape, and the engine replays the restored conversation as
      // ordinary events on the channel this gateway is already listening to. So there is no
      // second path here, and the record is built the same way `openSession` builds one — plus
      // the one thing a reopen has and a new session does not: a name the engine already gave it,
      // read off the row the reader picked (see `listedTitles`).
      const answer = await ipc.loadSession(request.vaultId, request.cwd, sessionId)
      const identity: AgentIdentity = {
        ...runtime,
        vaultId: request.vaultId,
        sessionId: answer.sessionId,
      }
      return book.open(identity, answer, listedTitles.get(sessionId) ?? null)
    },

    async closeSession(sessionId: string): Promise<void> {
      // No handle check, and deliberately so: the id may name a session this gateway never
      // minted a handle for — a row the engine listed — which is the case the by-id shape exists
      // for. What replaces that check is the host's own `known_session`: it refuses an id it did
      // not open, so a renderer still cannot free a session id it composed. What is *not*
      // replaced is dropping the record: a session this gateway was following must stop being
      // followable, or its handle would outlive the engine's session.
      await ipc.closeSession(sessionId)
      book.close(sessionId)
      // ...and the turn that session was running is over with it. A latch held here would refuse
      // the reader's next send on a session the engine has already let go — including the reopened
      // handle they would take from the very row they just freed, whose engine id is the same one
      // this latch is keyed by.
      endTurnFor(sessionId, `session ${sessionId} was closed while the turn was running`)
    },

    setConfigOption,

    async selectModel(session: AgentSession, modelId: string): Promise<AgentConfigOptionList> {
      const record = book.recordFor(session)
      // The same rule as the double's, and §6.3's for permission options: the host does not
      // forward a choice it never published. Whether the *engine* would refuse the value is not
      // measured, which is exactly why the host's own list is the boundary.
      if (!record.models.some((model) => model.id === modelId)) {
        throw new AgentFailure(
          'invalid-response',
          `model ${modelId} is not one of this session's models`,
        )
      }
      if (record.modelOptionId === null) {
        throw new AgentFailure('invalid-response', 'this engine has no model option to move')
      }
      return setConfigOption(session, record.modelOptionId, modelId)
    },

    async prompt(
      session: AgentSession,
      text: string,
      attachments: readonly AgentPromptAttachment[] = [],
    ): Promise<AgentRunResult> {
      const record = book.recordFor(session)
      // One turn at a time per session (§6.2): a second would interleave two runs into one
      // stream with no way to tell which text belongs to which — and the refusal says *that*,
      // rather than `buffer-conflict`'s "this stream cannot be continued" (`channel.ts`) or "this
      // view is larger than the host will hold" (`agent-event-reducer.ts`).
      if (running.has(session.sessionId)) {
        throw new AgentFailure(
          'turn-in-flight',
          `session ${session.sessionId} already has a turn in flight`,
        )
      }
      const turn = Symbol('turn')
      running.set(session.sessionId, turn)
      await channel.handle()
      let settleRun!: (result: AgentRunResult) => void
      let failRun!: (failure: AgentFailure) => void
      const ended = new Promise<AgentRunResult>((resolve, reject) => {
        settleRun = resolve
        failRun = reject
      })
      // Owned from the moment it exists, and that is not the same as being awaited: the deadline
      // below can fire while `agent_prompt` is still outstanding, and it would reject a promise
      // whose rejection the caller only reads a moment later — an unhandled rejection in the
      // window between, which this codebase treats as a reported error rather than a private one
      // (see the vitest config's own note). This handler does not swallow the failure: `await
      // ended` further down is still what carries it to the caller, once, with the same value.
      void ended.catch(() => {})
      // The turn's own deadline, armed here rather than at some frame that would end it: nothing
      // is promised to arrive, so the only thing this window can do about a turn that outlives the
      // host's own bound is end it itself and say which fact that was (`turn-bound.ts` holds the
      // number and the sentence).
      const bound = setTimeout(() => failRun(expiredTurn()), TURN_LIVENESS_BOUND_MS)
      const run: PendingRun = {
        runId: null,
        sessionId: session.sessionId,
        settle: settleRun,
        fail: failRun,
      }
      starting = { sessionId: session.sessionId, turn, parked: [] }
      let runId: string | null = null
      try {
        runId = await ipc.prompt(session.sessionId, text, attachments)
        run.runId = runId
        pending.set(runKey(record.identity, runId), run)
        // An ending that arrived while the call was in flight belongs to this run — the engine
        // cannot have ended a run the host had not started — so it settles now, in order.
        const parked = starting.parked
        starting = null
        for (const event of parked) {
          if (event.runId === runId) finish(run, event)
        }
        return await ended
      } finally {
        // One place for the whole of what a turn leaves behind, reached however it ended: an
        // ending frame, a call the host refused, the deadline above, or a session that was let go
        // underneath it. The latch is released by the token this turn took, so a turn winding down
        // here after its session was reopened cannot free its successor's (see `releaseTurn`).
        if (runId !== null) pending.delete(runKey(record.identity, runId))
        if (starting !== null && starting.turn === turn) starting = null
        clearTimeout(bound)
        releaseTurn(session.sessionId, turn)
        await channel.release()
      }
    },

    async cancel(session: AgentSession): Promise<void> {
      book.recordFor(session)
      // Cancelling with no turn in flight is a no-op, not a failure: the user can press stop in
      // the same instant the turn ends, and that race must not surface as an error.
      await ipc.cancel(session.sessionId)
    },

    async answerPermission(
      session: AgentSession,
      requestId: string,
      optionId: string,
    ): Promise<void> {
      const record = book.recordFor(session)
      try {
        await ipc.answerPermission({ session: record.identity, requestId, optionId })
      } catch (error) {
        if (error instanceof AgentFailure) throw error
        // The host refuses an answer with a sentence rather than a code: its five refusals —
        // expired, answered already, another request's identity, an option the engine never
        // offered, an unknown session — all arrive as text. `permission-denied` is the one code
        // in the vocabulary for "this answer did not take effect"; which of the five it was
        // stays in the host's own wording, which is the part the user reads.
        const message = error instanceof Error ? error.message : String(error)
        throw new AgentFailure('permission-denied', message)
      }
    },

    async capabilities(session: AgentSession): Promise<readonly AgentCapabilityReport[]> {
      // The handle check first, like every other session-scoped call: rows about a session this
      // window did not open would be this adapter inventing a session's state.
      book.recordFor(session)
      const answer = await ipc.capabilities(session.sessionId)
      const reports = readCapabilityReports(answer)
      if (reports === null) {
        // A rejected read, not an empty report: the panel's answer to this is "unreadable, try
        // again", never "this engine can do none of it" — which is what a shorter list would say.
        throw new AgentFailure(
          'invalid-response',
          'the host answered a capability report this window could not read',
        )
      }
      return reports
    },

    async snapshot(session: AgentSession): Promise<AgentSessionSnapshot> {
      const record = book.recordFor(session)
      const host = await ipc.snapshot(session.sessionId)
      checkSnapshot(record, host)
      return {
        identity: record.identity,
        state: readHostState(host.state),
        runId: host.runId,
        sequence: host.sequence,
        events: mapAll(host.events, tools, report),
        permissions: mapAll(host.permissions, tools, report).filter(
          (event): event is Extract<AgentEvent, { kind: 'permission-request' }> =>
            event.kind === 'permission-request',
        ),
      }
    },

    async subscribe(
      from: AgentSessionSnapshot,
      onEvent: (event: AgentEvent) => void,
    ): Promise<() => void> {
      // A snapshot carries the same five identity fields a handle does, without the handle's
      // brand — which is why the book checks the fields rather than the type.
      const record = book.recordOf(from.identity)
      return channel.subscribe(record, from, onEvent)
    },
  }
}
