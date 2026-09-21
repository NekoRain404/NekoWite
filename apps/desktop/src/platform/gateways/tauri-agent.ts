/** Tauri agent gateway: session ownership and IPC projection, with per-session turns. */

import {
  AgentFailure,
  readCapabilityReports,
  readChangeRecovery,
  readSessionHistory,
  type AgentCapabilityReport,
  type AgentChangeRecovery,
  type AgentConfigOptionList,
  type AgentEvent,
  type AgentGateway,
  type AgentIdentity,
  type AgentOpenRequest,
  type AgentPromptAttachment,
  type AgentSession,
  type AgentSessionHistory,
  type AgentSessionSnapshot,
} from './agent-contracts'
import { createEventChannel, checkSnapshot, mapAll, readHostState } from './tauri-agent/channel'
import { ToolProjection } from './tauri-agent/tools'
import {
  createTauriAgentIpc,
  type AgentIpc,
  type AgentRuntimeHandle,
} from './tauri-agent/ipc'
import { createSessionBook, readRefreshedOptions } from './tauri-agent/session'
import { createAgentTurns } from './tauri-agent/turns'

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

export function createTauriAgentGateway(options: TauriAgentOptions): AgentGateway {
  const ipc = options.ipc ?? createTauriAgentIpc()
  const report =
    options.onUnmappable ??
    ((failure) => console.error(`[NekoWite] an agent frame was dropped: ${failure.message}`))
  const tools = new ToolProjection()
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
      if (event.kind === 'run-finished' || event.kind === 'run-failed') turns.settle(event)
    },
  })

  const turns = createAgentTurns(ipc, channel)

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
      turns.stop()
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
      turns.closeSession(sessionId)
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
    ) {
      const record = book.recordFor(session)
      return turns.prompt(record.identity, text, attachments)
    },

    async recoverChange(session: AgentSession, path: string): Promise<AgentChangeRecovery> {
      // The handle check first, like every other session-scoped call: a path is only a path inside
      // one vault, and the host resolves the change under the root of the session it is given —
      // so a session this gateway did not mint has no root to look one up under.
      const record = book.recordFor(session)
      const answer = readChangeRecovery(await ipc.recoverChange(record.identity.sessionId, path))
      if (answer === null) {
        // A rejected read, not a refusal: a refusal is a code this window knows, and drawing an
        // unreadable answer as one would put a sentence about a condition nobody established in
        // front of the reader — the same rule `capabilities` and `listSessions` follow.
        throw new AgentFailure(
          'invalid-response',
          'the host answered a recovery this window could not read',
        )
      }
      return answer
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
