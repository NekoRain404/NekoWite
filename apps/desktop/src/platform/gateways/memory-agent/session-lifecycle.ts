/**
 * The engine's session table, and the four calls that move through it: open, list, load
 * and close.
 *
 * All four answer the same question — what the engine holds — and they change together
 * for one reason: the measured behaviour of that table. A close leaves the row in it, a
 * load revives a row into a handle under the current epoch and replays the conversation
 * the row's record kept, a list reports which rows the live runtime still serves, and a
 * page cursor the engine never issued is a page it refuses to serve.
 */

import {
  AgentFailure,
  type AgentIdentity,
  type AgentOpenRequest,
  type AgentSession,
  type AgentSessionHistory,
} from '../agent-contracts'
import { MEMORY_INITIAL_MODEL_ID, MEMORY_MODELS, MEMORY_OPTIONS } from './scenario'
import { createSession, mintSession, pushEvent, wake } from './session'
import { currentEpoch, recordFor, type LiveRuntime } from './runtime'

/**
 * The cursor this double mints, and the one rule about it: it is opaque to the caller and only
 * ever handed back here. Encoded as the offset it starts at, with a prefix that makes a cursor
 * from somewhere else recognisable — a real engine's cursor would be its own string and equally
 * meaningless to this side, which is the property the contract relies on.
 */
const PAGE_PREFIX = 'memory-page:'

function readPageCursor(cursor: string | undefined, total: number): number {
  if (cursor === undefined) return 0
  const encoded = cursor.startsWith(PAGE_PREFIX) ? Number(cursor.slice(PAGE_PREFIX.length)) : NaN
  if (!Number.isInteger(encoded) || encoded < 0 || encoded > total) {
    // Refused rather than clamped: a cursor this double never issued is a page it cannot serve,
    // and answering the first page for it would be the caller's mistake reading as a success.
    throw new AgentFailure('invalid-response', `unknown session cursor: ${cursor}`)
  }
  return encoded
}

export async function openSession(
  runtime: LiveRuntime,
  request: AgentOpenRequest,
): Promise<AgentSession> {
  const current = currentEpoch(runtime)
  if (runtime.dead) throw new AgentFailure('process-exited', 'the agent runtime exited')
  runtime.sessionCount += 1
  const identity: AgentIdentity = {
    agentId: runtime.options.agentId,
    profileId: runtime.options.profileId,
    runtimeEpoch: current,
    vaultId: request.vaultId,
    sessionId: `session-${runtime.sessionCount}`,
  }
  runtime.sessions.set(
    identity.sessionId,
    createSession(identity, runtime.replayLimit, request.cwd, runtime.sessionCount),
  )
  runtime.publishedOptions.set(identity.sessionId, [...MEMORY_OPTIONS])
  // No title on the handle: the record above has one (`createSession` writes the shape the
  // pinned engine was measured using), but nothing has *stated* it to a window yet — a new
  // session's name is read from `session/list` or not at all, which is the same reason
  // `agent_open_session` answers no title in the real host.
  return mintSession(identity, MEMORY_MODELS, MEMORY_INITIAL_MODEL_ID, MEMORY_OPTIONS, null)
}

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
export async function listSessions(
  runtime: LiveRuntime,
  cursor?: string,
): Promise<AgentSessionHistory> {
  currentEpoch(runtime)
  if (runtime.dead) throw new AgentFailure('process-exited', 'the agent runtime exited')
  const all = [...runtime.sessions.values()].map((record) => ({
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
    held: !record.closed && record.identity.runtimeEpoch === currentEpoch(runtime),
  }))
  const size = runtime.options.pageSize
  if (size === undefined) {
    // One page, which is what the pinned engine was measured answering — and an honest
    // `null` rather than a fabricated cursor, because a cursor the engine never issued is a
    // page this double could not serve.
    return { sessions: all, nextCursor: null }
  }
  const from = readPageCursor(cursor, all.length)
  const page = all.slice(from, from + size)
  const next = from + size
  return { sessions: page, nextCursor: next < all.length ? `${PAGE_PREFIX}${next}` : null }
}

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
export async function loadSession(
  runtime: LiveRuntime,
  sessionId: string,
  request: AgentOpenRequest,
): Promise<AgentSession> {
  const current = currentEpoch(runtime)
  if (runtime.dead) throw new AgentFailure('process-exited', 'the agent runtime exited')
  const existing = runtime.sessions.get(sessionId)
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
    // `session-open` and not `session-stale`: the runtime this session belongs to *is* the live
    // one, so nothing about it has gone stale — what refused is that a load is for a session
    // that is not open, and this one is. The host answers the same condition with the same code
    // (`SessionError::AlreadyOpen`), which is what makes the two implementations of this
    // contract tell a caller the same thing.
    throw new AgentFailure(
      'session-open',
      `session ${sessionId} is already open in this runtime`,
    )
  }
  // `load-in-flight` — the third refusal this call has in the contract, for a second load of
  // the same session while the first is still on the wire — is deliberately not modelled here:
  // this body never suspends, so two loads cannot overlap in it and there is no moment at
  // which one could be told the other is coming back. A `await` invented to make the arm
  // reachable would be a suspension the real thing does not have, which is the wrong direction
  // for a double; the host that *does* await the engine answers it
  // (`SessionError::LoadInFlight`), and the contract documents it.
  const identity: AgentIdentity = {
    agentId: runtime.options.agentId,
    profileId: runtime.options.profileId,
    runtimeEpoch: current,
    vaultId: request.vaultId,
    sessionId,
  }
  const revived = createSession(
    identity,
    runtime.replayLimit,
    existing.cwd,
    runtime.sessionCount + 1,
  )
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
  runtime.runCount += 1
  const loadRun = `load-${runtime.runCount}`
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
  runtime.sessions.set(sessionId, revived)
  runtime.publishedOptions.set(sessionId, [...MEMORY_OPTIONS])
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
}

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
export async function closeSession(runtime: LiveRuntime, sessionId: string): Promise<void> {
  // By id, like the contract's — a handle is not needed, because the row a history surface
  // frees may be one this runtime serves *without* the window holding a handle for it (that
  // is the case the by-id shape exists for). But an id must still be one **this runtime
  // instance** holds: the host refuses before the engine is asked (`known_session`, §6.1), so
  // a session left over from an earlier epoch is a refusal here too. `recordFor` is that
  // predicate, and it is the same one the list's `held` flag is computed from — which is what
  // keeps a green test from modelling a call production answers with its own refusal.
  const record = recordFor(runtime, sessionId)
  if (runtime.dead) throw new AgentFailure('process-exited', 'the agent runtime exited')
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
  runtime.publishedOptions.delete(sessionId)
}
