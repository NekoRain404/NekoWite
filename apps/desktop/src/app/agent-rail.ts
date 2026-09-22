/**
 * The rail's agent half: which runtime is up, for which vault, and what the window knows
 * while it is not up.
 *
 * `agent-composition.ts` answers *how* the app talks to an engine; this file answers *when*
 * it is asked to, and what the shell shows when the answer is no. They are separate because
 * the composition is a factory with three calls (T4's file, extended by T9/T10/T11) and this
 * is a lifecycle with a state machine — and because the lifecycle is the half that needs a
 * test that can drive it without a window. The half that does need one — the two `watch`es and
 * the unmount that attach this lifecycle to a component — is `agent-rail-attachment.ts`.
 *
 * Engines start on demand and survive panel closure. Vault changes replace the runtime;
 * agent selection first verifies every served session is inactive. Served session handles
 * are reused rather than loaded twice, and startup refusals remain retryable UI state.
 *
 * ## Latest-wins, by a queue and a generation
 *
 * Every request appends one step to a single queue, so a start and a stop can never be in
 * flight at once (a `stop` racing an `openSession` would ask the backend to tear down a
 * runtime it was still building). A step that finds itself superseded — a newer request, or
 * the switch going off — returns without touching the state, which is what keeps the answer
 * of an engine that was already on its way out from arriving as if it were the current one.
 * The same latch guards the failure path: a refusal from a superseded request is dropped
 * rather than shown over the runtime that replaced it.
 */

import { shallowRef } from 'vue'
import type { AgentSession } from '../platform/gateways/agent-contracts'
import { createAgentComposition, type AgentComposition } from './agent-composition'
import { t } from '../i18n'
import type { AgentRail, AgentRailDeps, AgentRailState } from './agent-rail-contracts'
import { engineNameFor, failureSentence, railKey } from './agent-rail-presentation'
export { failureSentence, railKey } from './agent-rail-presentation'
export type { AgentRail, AgentRailDeps, AgentRailState } from './agent-rail-contracts'

export function createAgentRail(deps: AgentRailDeps = {}): AgentRail {
  const compose = deps.compose ?? ((vaultId: string, agentId?: string) =>
    createAgentComposition({ vaultId, ...(agentId !== undefined ? { agentId } : {}) }))
  const onStopFailed =
    deps.onStopFailed ??
    ((error: unknown) => {
      console.error('[NekoWite] the agent runtime could not be stopped', error)
    })
  const onResumeFailed =
    deps.onResumeFailed ??
    ((error: unknown) => {
      console.error('[NekoWite] the agent session could not be reopened', error)
    })
  const onNewSessionFailed =
    deps.onNewSessionFailed ??
    ((error: unknown) => {
      console.error('[NekoWite] a new agent session could not be opened', error)
    })

  // `shallowRef`, not `ref`: the state is replaced wholesale and never mutated, and a deep
  // reactive proxy over the live arm would wrap the gateway and the session handle — two
  // objects the feature below compares by identity (`===`) and keys its store by. Reactivity
  // here is the replacement, which `shallowRef` already is.
  const state = shallowRef<AgentRailState>({ kind: 'idle' })
  /** The live composition, if one is up. Held here rather than in the state because the
   *  state is what the view draws and a handle is not something to draw. */
  let live: { composition: AgentComposition } | null = null
  /** The same object, for the one reader outside this file: the editor pane's note surface, which
   *  is in another subtree and reaches this file through the shell. Written wherever `live` is, so
   *  the two cannot describe different moments. */
  const composition = shallowRef<AgentComposition | null>(null)
  // Retain offscreen handles because loading an already-served session is refused by ACP.
  // The table is runtime-scoped: teardown clears handles before a new epoch can use them.
  const serving = new Map<string, AgentSession>()
  /** The last request, so `retry` has something to repeat. */
  let asked: { vaultId: string; cwd: string; agentId?: string; switching?: boolean } | null = null
  /** Bumped by every request and by `close`; a step older than the current value is dropped. */
  let generation = 0
  /** The one queue: at most one start, stop or open in flight, in the order they were asked. */
  let queue: Promise<unknown> = Promise.resolve()

  function enqueue<T>(step: () => Promise<T>): Promise<T> {
    // Both handlers are the step: a queue that stopped after one failure would be a rail that
    // silently ignores every later click. No step is allowed to reject — the one thing that
    // can throw before an await (`compose`) is guarded where it is called — so the queue is
    // never left holding a rejection and the returned promise always resolves.
    const next = queue.then(step, step)
    queue = next
    return next
  }

  /** Publish the arm that means "this session is on screen, on this runtime".
   *
   *  One writer for the state and the composition behind it, because the two describe one moment:
   *  a surface that read them during a gap would otherwise get one of them from a different moment
   *  than the other — which is the disagreement `composition`'s own doc says it is held apart to
   *  avoid. Every path that puts a session on screen goes through here. */
  function publishLive(
    composition_: AgentComposition,
    session: AgentSession,
    vaultId: string,
    cwd: string,
    engineName: string,
  ): void {
    state.value = {
      kind: 'live',
      vaultId,
      cwd,
      key: railKey(session),
      gateway: composition_.gateway,
      session,
      engineName,
    }
    composition.value = composition_
  }

  async function teardown(strict = false): Promise<void> {
    const held = live
    // A switch cannot forget ownership until stop succeeds: otherwise retry could launch a
    // second engine while the first still owns live sessions or permissions.
    if (strict && held !== null) await held.composition.stop()
    live = null
    // Published first, so a surface that asked during the teardown gets nothing rather than a
    // binding to a runtime this call is on its way to stopping.
    composition.value = null
    // The handles go with the runtime: they were minted by it, and a new one re-adopts every
    // session it serves as a handle of its own (see `serving`).
    serving.clear()
    if (held === null || strict) return
    try {
      await held.composition.stop()
    } catch (error) {
      // The state still moves on: the window has to be able to say the runtime is gone even
      // when the backend disagreed about how it went.
      onStopFailed(error)
    }
  }

  function request(vaultId: string, cwd: string, force: boolean, agentId?: string, switching = false): Promise<void> {
    const now = state.value
    if (!force && now.kind !== 'idle' && now.vaultId === vaultId) return Promise.resolve()
    asked = { vaultId, cwd, ...(agentId !== undefined ? { agentId } : {}), switching }
    const mine = ++generation
    return enqueue(async () => {
      if (mine !== generation) return
      try {
        if (switching && live !== null) {
          for (const session of serving.values()) {
            const snapshot = await live.composition.gateway.snapshot(session)
            if (mine !== generation) return
            if (!['idle', 'ready', 'completed', 'cancelled', 'failed'].includes(snapshot.state)
              || snapshot.permissions.length > 0) {
              throw new Error(t('agent.rail.switchBusy'))
            }
          }
        }
        if (mine !== generation) return
        if (switching) state.value = { kind: 'starting', vaultId }
        await teardown(switching)
      } catch (error) {
        if (mine === generation) {
          state.value = now
          onNewSessionFailed(error)
        }
        return
      }
      if (mine !== generation) return
      state.value = { kind: 'starting', vaultId }
      let compositionOrThrow: AgentComposition
      try {
        compositionOrThrow = agentId === undefined ? compose(vaultId) : compose(vaultId, agentId)
      } catch (error) {
        // A composition that could not even be built is the same kind of answer as a runtime
        // that would not start, and it goes to the same place rather than out of the promise.
        state.value = { kind: 'refused', vaultId, reason: failureSentence(error) }
        return
      }
      live = { composition: compositionOrThrow }
      try {
        const session = await compositionOrThrow.openSession({ vaultId, cwd })
        if (live?.composition === compositionOrThrow) serving.set(session.sessionId, session)
        if (mine !== generation) return
        // One read of the registry, for the engine's own name. It cannot reject (see
        // `engineNameFor`), and the supersession check is repeated because it is an await like
        // any other: a vault switch during it must not be answered with the old session.
        const engineName = await engineNameFor(compositionOrThrow, session.agentId)
        if (mine !== generation) return
        publishLive(compositionOrThrow, session, vaultId, cwd, engineName)
      } catch (error) {
        if (mine !== generation) return
        // The composition is kept: it is what a `close` has to stop, and the runtime may well
        // be up even though the session was refused.
        state.value = { kind: 'refused', vaultId, reason: failureSentence(error) }
      }
    })
  }

  /**
   * A served session must be adopted: the engine rejects loading an already-open session.
   * Keep adoption and its dead-handle fallback in one queued operation and one generation.
   * The lookup happens inside that queue because an earlier request may acquire the handle
   * even when a newer UI request supersedes it.
   */
  async function resume(sessionId: string): Promise<void> {
    const now = state.value
    if (now.kind !== 'live' || now.session.sessionId === sessionId) return
    const mine = ++generation
    return enqueue(async () => {
      if (mine !== generation) return
      // The preceding queued call may have acquired this handle while its UI request expired.
      const served = serving.get(sessionId)
      if (served !== undefined && (await adopt(served, mine)) !== 'dead') return
      if (mine !== generation) return
      await load(sessionId, mine)
    })
  }

  /**
   * A history action may have freed a cached handle. Snapshot refusal permits a load fallback;
   * supersession does not. Both outcomes must remain distinct across the awaited snapshot.
   */
  async function adopt(session: AgentSession, mine: number): Promise<'published' | 'dead' | 'stale'> {
    if (mine !== generation) return 'stale'
    const held = live
    if (held === null) return 'stale'
    const now = state.value
    if (now.kind !== 'live' || now.session.sessionId === session.sessionId) return 'stale'
    try {
      await held.composition.gateway.snapshot(session)
    } catch {
      if (mine !== generation) return 'stale'
      serving.delete(session.sessionId)
      return 'dead'
    }
    if (mine !== generation) return 'stale'
    // The engine's name is read again for the session being shown — it is the same engine, and a
    // name cached from the previous session would be this file answering for a registration it
    // has not read.
    const engineName = await engineNameFor(held.composition, session.agentId)
    if (mine !== generation) return 'stale'
    publishLive(held.composition, session, now.vaultId, now.cwd, engineName)
    return 'published'
  }

  /**
   * Load a session the engine holds into this runtime — the arm for a session this window has
   * never served (a row from the engine's own history), and the one a dead handle falls back to.
   *
   * Takes no early-return of its own for a session already on screen beyond re-reading the state
   * it must publish over: `resume` decided that, and a state that moved while an adopt was in
   * flight is caught here for the same reason the generation latch exists.
   */
  async function load(sessionId: string, mine: number): Promise<void> {
    const now = state.value
    if (now.kind !== 'live' || now.session.sessionId === sessionId) return Promise.resolve()
    // The pair an `AgentOpenRequest` needs, read from the runtime that is up rather than from
    // `asked`: those are the same values, and the state is the one that is true *now*.
    const target = { vaultId: now.vaultId, cwd: now.cwd }
    if (mine !== generation) return
    const held = live
    if (held === null) return
    try {
      const session = await held.composition.gateway.loadSession(sessionId, target)
      // Backend ownership survives superseded UI requests until this runtime is torn down.
      if (live === held) serving.set(session.sessionId, session)
      if (mine !== generation) return
      // The engine's name is read again for the session that came back — it is the same engine,
      // and a name cached from the previous session would be this file answering for a
      // registration it has not read.
      const engineName = await engineNameFor(held.composition, session.agentId)
      if (mine !== generation) return
      // Now a session this runtime serves, like the ones `open` and `newSession` mint: a second
      // ask for it is a move, not a load.
      publishLive(held.composition, session, target.vaultId, target.cwd, engineName)
    } catch (error) {
      if (mine !== generation) return
      onResumeFailed(error)
    }
  }

  /**
   * New conversations share this runtime and leave its other sessions and turns running.
   * Successful acquisition always enters serving; only the latest request publishes the UI.
   * Teardown clears those handles before the next runtime starts.
   */
  function newSession(agentId?: string): Promise<void> {
    const now = state.value
    if (now.kind === 'refused' && agentId !== undefined && asked !== null) {
      return request(asked.vaultId, asked.cwd, true, agentId, true)
    }
    if (now.kind !== 'live') return Promise.resolve()
    if (agentId !== undefined && agentId !== now.session.agentId) {
      return request(now.vaultId, now.cwd, true, agentId, true)
    }
    // The pair an `AgentOpenRequest` needs, read from the runtime that is up rather than from
    // `asked`: those are the same values, and the state is the one that is true *now*.
    const target = { vaultId: now.vaultId, cwd: now.cwd }
    const mine = ++generation
    return enqueue(async () => {
      if (mine !== generation) return
      const held = live
      if (held === null) return
      try {
        const session = await held.composition.openSession(target)
        // Keep every acquired handle, including one a newer view request no longer publishes.
        if (live === held) serving.set(session.sessionId, session)
        if (mine !== generation) return
        // The engine's name is read again, exactly as the resume path reads it: it is the same
        // engine, and a name cached from the previous session would be this file answering for a
        // registration it has not read.
        const engineName = await engineNameFor(held.composition, session.agentId)
        if (mine !== generation) return
        // **The session being left is not closed, and that is what `serving` is for.** The run in
        // it goes on (§5.1), the engine keeps serving it, and this table is what remembers the
        // handle — so the reader can come back to it (the pet's task link, or the history list)
        // without the engine being asked to hand over a session it is already serving.
        publishLive(held.composition, session, target.vaultId, target.cwd, engineName)
      } catch (error) {
        if (mine !== generation) return
        onNewSessionFailed(error)
      }
    })
  }

  return {
    state,
    composition,
    open(vaultId, cwd) {
      return request(vaultId, cwd, false)
    },
    resume,
    newSession,
    retry() {
      const last = asked
      if (last === null) return Promise.resolve()
      return request(last.vaultId, last.cwd, true, last.agentId, last.switching)
    },
    close() {
      // Bumped before the queue runs, not inside it: a start that is already queued behind
      // this must find itself superseded when its turn comes, instead of opening a session
      // for a runtime this call is on its way to stopping.
      ++generation
      return enqueue(async () => {
        state.value = { kind: 'idle' }
        await teardown()
      })
    },
  }
}
