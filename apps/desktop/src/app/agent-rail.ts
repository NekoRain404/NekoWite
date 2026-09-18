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
 * ## The five rules it is written to
 *
 *  - **The switch is off, nothing happens.** No composition is built, no process is asked
 *    for, and the rail keeps the chat panel it has always had (§12's 新旧功能开关可回退
 *    applies to the work as well as to the pixels: a rollback that left an engine running
 *    would be a rollback in name only).
 *  - **The engine starts on demand and the panel does not own it.** Opening the rails starts
 *    it; closing the rail does not stop it (§3.1.3「关闭面板不终止任务」, §5.1). What stops it
 *    is a different vault, the switch going off, or the window going away.
 *  - **A vault change is a new runtime.** A runtime instance is per (agent, profile, vault)
 *    (§6.2, enforced by the Rust registry's epoch claim), so the previous one is torn down
 *    before the next is started rather than left running behind it.
 *  - **A refusal is data, not an exception.** `agent_start` refuses in sentences — no
 *    bundled program beside the executable, a profile that belongs to another engine, an
 *    engine already running for this vault — and every one of them is shown as it was
 *    received, over the two ways out (try again, or go back to the chat). A rollback that
 *    looks like a crash is not a rollback.
 *  - **A session this runtime serves is shown, not loaded.** The rail holds the handles it
 *    minted ({@link createAgentRail}'s `serving`), so a move between two sessions of one runtime
 *    is a remount for the one the window already holds and a `loadSession` for one it does not —
 *    the engine refuses a load of a session it is serving, and that refusal is right. This is the
 *    rule the pet's task link and the panel's history list both arrive through.
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

import { shallowRef, type Ref } from 'vue'
import type { AgentGateway, AgentSession } from '../platform/gateways/agent-contracts'
import { createAgentComposition, type AgentComposition } from './agent-composition'
import { t } from '../i18n'

/** What the shell can be showing, and nothing else. `idle` is both "the switch is off" and
 *  "the rail is not open" — the shell does not render either, so they are one arm. */
export type AgentRailState =
  | { kind: 'idle' }
  | { kind: 'starting'; vaultId: string }
  | {
      kind: 'live'
      vaultId: string
      /**
       * The directory the engine runs in — the vault root on disk, which is what an open or a
       * load was asked for.
       *
       * Carried because a *load* needs it: `AgentOpenRequest` takes a vault and a folder, and a
       * reopen is a call for the vault the runtime was started for rather than for a new one.
       * The panel's history rows read it too, to say which of the engine's sessions were recorded
       * somewhere else.
       */
      cwd: string
      /** Stable per session, and the key the panel is mounted under — see {@link railKey}. */
      key: string
      gateway: AgentGateway
      session: AgentSession
      /**
       * The engine's own name, for the sentences that have to name it — the session bar's title
       * and the transcript's first line. Read from the registration the backend holds
       * ({@link engineNameFor}), never a constant here, and never absent: an engine the registry
       * does not describe is named by its id, and the id is a fact.
       */
      engineName: string
    }
  | { kind: 'refused'; vaultId: string; reason: string }

export interface AgentRailDeps {
  /** How a runtime for one vault is built. Injected by a test; the app builds the real one. */
  compose?: (vaultId: string) => AgentComposition
  /** A `stop` that failed. Reported rather than swallowed: an engine that would not go away
   *  is a fact about the machine, and it is the one failure the next start will meet again. */
  onStopFailed?: (error: unknown) => void
  /**
   * A `loadSession` that failed — the engine would not hand back a session the user picked out of
   * its history.
   *
   * Reported rather than drawn, and for a reason the other failures here do not have: the rail
   * has no arm for "live, with a notice", and the session on screen is *not* the one at fault, so
   * publishing a refusal would take a running conversation off the screen because a different one
   * could not be opened. The rail keeps the session it is on and hands the engine's own sentence
   * to the caller, which is where the user is looking.
   */
  onResumeFailed?: (error: unknown) => void
  /**
   * A `session/new` that failed — the engine would not open another session on a runtime that is
   * already serving one.
   *
   * The same shape as {@link onResumeFailed}, for the same reason: the session on screen is not
   * the one at fault and the reader is looking at a list rather than at a broken panel, so a live
   * conversation must not be taken off the screen because a *new* one could not be opened.
   */
  onNewSessionFailed?: (error: unknown) => void
}

export interface AgentRail {
  readonly state: Ref<AgentRailState>
  /**
   * The composition behind the runtime that is up, or null.
   *
   * Published because it is the only object that can mint an SVG-insertion binding
   * (`AgentComposition.connectSvgInsertion`), and the surface that needs one is the editor pane's —
   * a different subtree from the rail, with no path to this file's closure. Held here rather than in
   * {@link AgentRailState} because it is a handle and not something to draw: the state is what the
   * rail shows, and a second reader of one value is how the two would come to disagree about when
   * the runtime ended.
   *
   * It is the LIVE one and only the live one: cleared by every teardown, so a binding minted after
   * a stop is a binding to nothing rather than to a runtime that has gone away.
   */
  readonly composition: Ref<AgentComposition | null>
  /**
   * Bring an engine up for this vault and open a session, unless one is already live for it.
   * Idempotent, because the caller watches three inputs (the switch, the vault, the rail) and
   * two of them can change without the answer changing.
   *
   * Resolves when the attempt has settled — `live` or `refused` — and never rejects: every
   * failure this call can meet is a state the rail draws, which is what lets a caller that
   * does not care about the answer leave it as a floating promise (`void`) without an
   * unhandled rejection waiting to happen.
   */
  open(vaultId: string, cwd: string): Promise<void>
  /**
   * Put one of this runtime's sessions on screen — the one move between two sessions of one
   * runtime, and the only one there is.
   *
   * Two ways in, and which one is taken is a fact about this window, not a preference: a session
   * this runtime has **already served** is shown from the handle this window holds for it
   * (nothing is asked of the engine — a load is refused for a session a runtime is serving, and
   * rightly so: a conversation does not change by being looked at), and a session it has not is
   * loaded, which is what `loadSession` is for. Both land in the same `live` arm under a new
   * {@link railKey}, so a session change is a remount and never a re-point of the panel.
   *
   * Resolves when the attempt has settled, and never rejects: a load that failed leaves the
   * session that was already open exactly where it was, and reports the engine's refusal through
   * {@link AgentRailDeps.onResumeFailed}. Nothing happens for a rail that is not `live` — a
   * reopen is a move *within* a runtime, so there is nothing to move from — and nothing happens
   * for the session already on screen, which is the row a list is most likely to be asked about.
   */
  resume(sessionId: string): Promise<void>
  /**
   * Open a session that has never existed before, on the runtime that is already up, and put it on
   * screen — a *new* conversation rather than an old one.
   *
   * `resume`'s sibling and deliberately not a restart. A new session is one more `session/new` on
   * the engine that is serving this one, so the session the reader was in is left open on it and
   * the run it may be in the middle of is untouched: a "New session" that quietly cancelled the
   * answer being read would be the one thing a reader pressing it does not expect. The vault and
   * the folder do not change — a session is a move *within* a runtime, and the runtime is started
   * for a folder the user opened.
   *
   * Resolves when the attempt has settled and never rejects, like the rest of this file: nothing
   * happens for a rail that is not `live` (there is no runtime to open one on), and a refusal is
   * reported through {@link AgentRailDeps.onNewSessionFailed} with the session that was open left
   * exactly where it was.
   */
  newSession(): Promise<void>
  /** Ask again after a refusal: a fresh composition, which is a fresh `runtimeEpoch`. */
  retry(): Promise<void>
  /** Take the runtime down and go back to `idle`. */
  close(): Promise<void>
}

/**
 * The panel's mount key: a session change is a remount, never a re-point.
 *
 * The epoch is half of it because two engines can name a session the same thing (§3.4's
 * multi-agent boundary), and a panel mounted for the previous engine's session id would
 * subscribe to an identity that engine never minted.
 */
export function railKey(session: AgentSession): string {
  return `${session.runtimeEpoch}:${session.sessionId}`
}

/**
 * The name to put in front of the user for the engine a session runs on (§3.4: the name is the
 * backend's fact, so no component carries one of its own).
 *
 * Read from the registry's own registration for the agent the session reports, because that is
 * where the name the user sees lives — `AgentRegistration::display_name` on the Rust side, which
 * the settings list and the new-session chooser already show. Falling back to the **agent id**,
 * not to a word this file chose: an id is a fact and is always drawable, which is what keeps the
 * panel's title available without inventing an engine. The same fallback covers a registry that
 * cannot be read at all, and that is deliberate — the session is already open and everything else
 * the panel needs is here, so a registry call that failed must not turn a live session into a
 * refusal.
 *
 * A blank display name counts as absent for the reason the fallback exists: a registration whose
 * name is empty would otherwise put a hole in the middle of a sentence.
 */
async function engineNameFor(composition: AgentComposition, agentId: string): Promise<string> {
  try {
    const readout = await composition.registry.read()
    const name = readout.entries.find((entry) => entry.agentId === agentId)?.displayName
    return name !== undefined && name.trim() !== '' ? name : agentId
  } catch {
    return agentId
  }
}

/**
 * The backend's own sentence for a refusal.
 *
 * The IPC rejects with a string (the Rust commands answer `Result<_, String>`), and §6.2's
 * failure codes are for the stream rather than for a call that never opened a session —
 * so what is shown is what was received, with a fallback for the case where something other
 * than the backend rejected (a bug in the window, or a `stop` on a runtime that is gone).
 */
export function failureSentence(error: unknown): string {
  if (typeof error === 'string' && error.trim().length > 0) return error
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return t('agent.rail.unknownFailure')
}

export function createAgentRail(deps: AgentRailDeps = {}): AgentRail {
  const compose = deps.compose ?? ((vaultId: string) => createAgentComposition({ vaultId }))
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
  /**
   * Every session this runtime instance has served, by the engine's own id — the handles this
   * window would otherwise have dropped.
   *
   * It exists for one question a caller cannot answer for itself: *is this session one this window
   * already holds?* The engine refuses a load of a session a runtime is serving (`session-open`),
   * so without this table a session the reader left — a task still running, a conversation from
   * ten seconds ago — could not be brought back on screen at all, by the history list or by the
   * pet's task link, even though this window holds a working handle for it. A table rather than a
   * second state field: nothing draws it, and what is on screen is still the one `live` arm.
   *
   * Cleared with the runtime, and that is what keeps an id honest: a session id outlives a runtime
   * instance (the engine's own table is on its disk), so the handle under an id is only the right
   * one for the instance that minted it — a new runtime re-adopts the session as a new handle.
   */
  const serving = new Map<string, AgentSession>()
  /** The last request, so `retry` has something to repeat. */
  let asked: { vaultId: string; cwd: string } | null = null
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

  async function teardown(): Promise<void> {
    const held = live
    live = null
    // Published first, so a surface that asked during the teardown gets nothing rather than a
    // binding to a runtime this call is on its way to stopping.
    composition.value = null
    // The handles go with the runtime: they were minted by it, and a new one re-adopts every
    // session it serves as a handle of its own (see `serving`).
    serving.clear()
    if (held === null) return
    try {
      await held.composition.stop()
    } catch (error) {
      // The state still moves on: the window has to be able to say the runtime is gone even
      // when the backend disagreed about how it went.
      onStopFailed(error)
    }
  }

  function request(vaultId: string, cwd: string, force: boolean): Promise<void> {
    asked = { vaultId, cwd }
    const now = state.value
    if (!force && now.kind !== 'idle' && now.vaultId === vaultId) return Promise.resolve()
    const mine = ++generation
    return enqueue(async () => {
      if (mine !== generation) return
      await teardown()
      if (mine !== generation) return
      state.value = { kind: 'starting', vaultId }
      let compositionOrThrow: AgentComposition
      try {
        compositionOrThrow = compose(vaultId)
      } catch (error) {
        // A composition that could not even be built is the same kind of answer as a runtime
        // that would not start, and it goes to the same place rather than out of the promise.
        state.value = { kind: 'refused', vaultId, reason: failureSentence(error) }
        return
      }
      live = { composition: compositionOrThrow }
      try {
        const session = await compositionOrThrow.openSession({ vaultId, cwd })
        if (mine !== generation) return
        // One read of the registry, for the engine's own name. It cannot reject (see
        // `engineNameFor`), and the supersession check is repeated because it is an await like
        // any other: a vault switch during it must not be answered with the old session.
        const engineName = await engineNameFor(compositionOrThrow, session.agentId)
        if (mine !== generation) return
        serving.set(session.sessionId, session)
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
   * Put a session on screen: the one move between two sessions of one runtime.
   *
   * Two ways in, and the order is the whole point. A session this runtime has **already served**
   * (`serving`) is one this window holds a working handle for, so showing it is not a call to the
   * engine at all — and cannot be, because the engine refuses to load a session a runtime is
   * already serving (`session-open`). That refusal is right: a conversation does not change by
   * being looked at, and the case it covers is an ordinary one — the reader left a session, the
   * run in it went on (§5.1), and the pet's reminder or the history list asks for it back
   * (§6.2's 点击返回任务). Everything else goes to `loadSession`, which is what mints a handle for a
   * session the engine holds and this runtime does not.
   *
   * Both arms go through the **same `enqueue` and the same generation latch**, because the races
   * are the same ones: a vault switch or the switch going off while an adopt or a load is in
   * flight must not let the session arrive as the current one, and neither may overlap a start or
   * a stop (the backend is being asked about a runtime that may be on its way out). Both publish
   * the same `live` arm, so a session change is a remount under a {@link railKey} and the panel —
   * which reads its session once, and whose store addresses every action by the key it was mounted
   * with — is replaced rather than re-pointed.
   *
   * Three things it does *not* do, each of them a decision:
   *
   *  - **No runtime, no call.** A reopen is a move between two sessions of one runtime, so a rail
   *    that is not `live` has nothing to move from; a row picked while the runtime was going away
   *    is not an error worth a sentence.
   *  - **The row already open is not a call.** The engine refuses to load a session it is
   *    currently serving, and the panel marks that row instead of asking.
   *  - **A failure does not become a state.** The session on screen is not the one at fault, and
   *    taking a live conversation off the screen because a different session would not open is
   *    the wrong trade — so the state is left exactly as it is and the engine's refusal goes to
   *    {@link AgentRailDeps.onResumeFailed}.
   */
  async function resume(sessionId: string): Promise<void> {
    const now = state.value
    if (now.kind !== 'live' || now.session.sessionId === sessionId) return
    const served = serving.get(sessionId)
    if (served !== undefined && (await adopt(served))) return
    return load(sessionId)
  }

  /**
   * Show a session this runtime already serves, from the handle this window holds — or report that
   * the handle is no longer one to show.
   *
   * The liveness read is the reason this is a queued step rather than an assignment: a handle can
   * outlive its session. The history list's free action closes a session on the engine
   * (`services/agent-session-history.ts` → `AgentGateway.closeSession`), and the handle this table
   * holds for it is dead from that moment — publishing it would mount a panel whose only possible
   * report is a failure about a session nobody asked to close. The read is the same snapshot the
   * panel's own handshake takes, so it is a fact the gateway can answer without an engine call,
   * and its refusal means the handle is gone; the entry is dropped and the caller falls back to
   * `load`, which is what can still bring a freed session back.
   *
   * Answers whether it published. A `false` is about the *handle*, never about the session: the
   * caller that wants one on screen has the load path left to try.
   */
  function adopt(session: AgentSession): Promise<boolean> {
    const mine = ++generation
    return enqueue(async () => {
      if (mine !== generation) return false
      const held = live
      if (held === null) return false
      const now = state.value
      if (now.kind !== 'live' || now.session.sessionId === session.sessionId) return false
      try {
        await held.composition.gateway.snapshot(session)
      } catch {
        serving.delete(session.sessionId)
        return false
      }
      if (mine !== generation) return false
      // The engine's name is read again for the session being shown — it is the same engine, and a
      // name cached from the previous session would be this file answering for a registration it
      // has not read.
      const engineName = await engineNameFor(held.composition, session.agentId)
      if (mine !== generation) return false
      publishLive(held.composition, session, now.vaultId, now.cwd, engineName)
      return true
    })
  }

  /**
   * Load a session the engine holds into this runtime — the arm for a session this window has
   * never served (a row from the engine's own history), and the one a dead handle falls back to.
   *
   * Takes no early-return of its own for a session already on screen beyond re-reading the state
   * it must publish over: `resume` decided that, and a state that moved while an adopt was in
   * flight is caught here for the same reason the generation latch exists.
   */
  function load(sessionId: string): Promise<void> {
    const now = state.value
    if (now.kind !== 'live' || now.session.sessionId === sessionId) return Promise.resolve()
    // The pair an `AgentOpenRequest` needs, read from the runtime that is up rather than from
    // `asked`: those are the same values, and the state is the one that is true *now*.
    const target = { vaultId: now.vaultId, cwd: now.cwd }
    const mine = ++generation
    return enqueue(async () => {
      if (mine !== generation) return
      const held = live
      if (held === null) return
      try {
        const session = await held.composition.gateway.loadSession(sessionId, target)
        if (mine !== generation) return
        // The engine's name is read again for the session that came back — it is the same engine,
        // and a name cached from the previous session would be this file answering for a
        // registration it has not read.
        const engineName = await engineNameFor(held.composition, session.agentId)
        if (mine !== generation) return
        // Now a session this runtime serves, like the ones `open` and `newSession` mint: a second
        // ask for it is a move, not a load.
        serving.set(session.sessionId, session)
        publishLive(held.composition, session, target.vaultId, target.cwd, engineName)
      } catch (error) {
        if (mine !== generation) return
        onResumeFailed(error)
      }
    })
  }

  /**
   * Open a session that has never existed — `resume`'s sibling, one call apart.
   *
   * The same `enqueue` and the same generation latch, because the races are the same ones: the
   * switch going off, or the vault changing, while `session/new` is in flight must not let the new
   * session arrive as the current one, and it must not overlap a start or a stop (the backend is
   * being asked for a session on a runtime that may be on its way out). On success it publishes the
   * same `live` arm, so the change is a remount under a new {@link railKey}.
   *
   * Three things it does *not* do, each of them a decision:
   *
   *  - **No runtime, no call.** A new session is a move *within* a runtime, so a rail that is not
   *    `live` has nothing to open one on; starting a runtime for a folder the user has not opened
   *    is `open`'s job, and the shell calls it for the vault it holds.
   *  - **Nothing is torn down.** The engine keeps serving the session the reader was in, and a run
   *    it is in the middle of goes on (§5.1 任务可以在面板收起后继续). The reader gets a second
   *    conversation, not a cancelled one — which is the whole difference between this and `retry`.
   *  - **A failure does not become a state.** See {@link AgentRailDeps.onNewSessionFailed}.
   */
  function newSession(): Promise<void> {
    const now = state.value
    if (now.kind !== 'live') return Promise.resolve()
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
        serving.set(session.sessionId, session)
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
      return request(last.vaultId, last.cwd, true)
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
