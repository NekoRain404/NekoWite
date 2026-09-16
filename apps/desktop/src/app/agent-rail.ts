/**
 * The rail's agent half: which runtime is up, for which vault, and what the window knows
 * while it is not up.
 *
 * `agent-composition.ts` answers *how* the app talks to an engine; this file answers *when*
 * it is asked to, and what the shell shows when the answer is no. They are separate because
 * the composition is a factory with three calls (T4's file, extended by T9/T10/T11) and this
 * is a lifecycle with a state machine — and because the lifecycle is the half that needs a
 * test that can drive it without a window.
 *
 * ## The four rules it is written to
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

import { onBeforeUnmount, shallowRef, watch, type Ref } from 'vue'
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
      /** Stable per session, and the key the panel is mounted under — see {@link railKey}. */
      key: string
      gateway: AgentGateway
      session: AgentSession
    }
  | { kind: 'refused'; vaultId: string; reason: string }

export interface AgentRailDeps {
  /** How a runtime for one vault is built. Injected by a test; the app builds the real one. */
  compose?: (vaultId: string) => AgentComposition
  /** A `stop` that failed. Reported rather than swallowed: an engine that would not go away
   *  is a fact about the machine, and it is the one failure the next start will meet again. */
  onStopFailed?: (error: unknown) => void
}

export interface AgentRail {
  readonly state: Ref<AgentRailState>
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
  /** Ask again after a refusal: a fresh composition, which is a fresh `runtimeEpoch`. */
  retry(): Promise<void>
  /** Take the runtime down and go back to `idle`. */
  close(): Promise<void>
}

/**
 * What the shell gives the rail: three readings, and the two things a runtime needs to be built.
 *
 * They are getters rather than values because all three are live — the switch is a setting the
 * user can flip in the dialog that is open over this very rail, the folder is the vault the app
 * has open, and the rail is on screen or not — and a rail that captured one of them at setup
 * would keep working on the answer it was first given.
 */
export interface AgentRailInputs {
  /** §12's feature switch. See `stores/settings-agent.ts` for the value and its default. */
  enabled: () => boolean
  /** The folder the app has open, or null. A runtime is started *for* one. */
  vaultPath: () => string | null
  /** Whether the rail is on screen. */
  railOpen: () => boolean
  compose?: (vaultId: string) => AgentComposition
  onStopFailed?: (error: unknown) => void
}

export interface AttachedAgentRail {
  /** What the rail draws. */
  readonly state: Ref<AgentRailState>
  /**
   * Ask the backend again after a refusal.
   *
   * The one action the rail's own body needs. Its other way out — going back to the chat panel —
   * is the *switch*, which belongs to the caller (`inputs.enabled` is the caller's own value),
   * so undoing it is the caller's own act rather than a second path into the same decision.
   */
  retry(): Promise<void>
}

/**
 * Drive a rail from the shell's three inputs, and hand back the state it should draw.
 *
 * This is the whole of the policy the acceptance clause 「新旧功能开关可回退」 is about, and it is
 * here rather than in `AppShell.vue` because it is the same subject as the rest of this file:
 * when an engine runs. What the shell keeps is the decision it has no business delegating — the
 * *value* of the switch (a setting) and the *value* of the folder (the vault it opened).
 *
 * Four readings of the three inputs, and each is a rule:
 *
 *  - **Off, or no folder, or no rail: nothing runs.** The switch going off closes the runtime, so
 *    the rollback is a real one — no process is left behind that could still write to the open
 *    note. The folder closing is the same rule, and deliberately not conditioned on the rail
 *    being open: an engine for a folder the user has left has no session in front of it, and a
 *    process nobody can see is a process nobody can stop.
 *  - **On, with a folder, with the rail open: started on demand** (§3.1.3).
 *  - **The rail closing is not a stop** (§5.1 任务可以在面板收起后继续): the panel is unmounted —
 *    that is what releases its subscription — and the run goes on. Reopening re-establishes the
 *    panel from a snapshot, and this call is idempotent for the vault already live.
 *  - **The window going away is the one teardown** §3.4.8 asks for: this host cleans up the
 *    processes this host started.
 */
export function attachAgentRail(inputs: AgentRailInputs): AttachedAgentRail {
  const rail = createAgentRail({
    ...(inputs.compose ? { compose: inputs.compose } : {}),
    ...(inputs.onStopFailed ? { onStopFailed: inputs.onStopFailed } : {}),
  })

  /** Start one, if there is a folder to work in, a switch asking for one and a rail to draw it
   *  in. Idempotent for the vault already live, so the three inputs can change independently
   *  without the answer changing. */
  function start(): void {
    const vault = inputs.vaultPath()
    if (!inputs.enabled() || vault === null || !inputs.railOpen()) return
    void rail.open(vault, vault)
  }

  watch(
    () => [inputs.enabled(), inputs.vaultPath()] as const,
    () => {
      if (!inputs.enabled() || inputs.vaultPath() === null || !inputs.railOpen()) void rail.close()
      else start()
    },
    { immediate: true },
  )

  watch(inputs.railOpen, (open) => {
    if (open) start()
  })

  onBeforeUnmount(() => {
    void rail.close()
  })

  return { state: rail.state, retry: () => rail.retry() }
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

  // `shallowRef`, not `ref`: the state is replaced wholesale and never mutated, and a deep
  // reactive proxy over the live arm would wrap the gateway and the session handle — two
  // objects the feature below compares by identity (`===`) and keys its store by. Reactivity
  // here is the replacement, which `shallowRef` already is.
  const state = shallowRef<AgentRailState>({ kind: 'idle' })
  /** The live composition, if one is up. Held here rather than in the state because the
   *  state is what the view draws and a handle is not something to draw. */
  let live: { composition: AgentComposition } | null = null
  /** The last request, so `retry` has something to repeat. */
  let asked: { vaultId: string; cwd: string } | null = null
  /** Bumped by every request and by `close`; a step older than the current value is dropped. */
  let generation = 0
  /** The one queue: at most one start, stop or open in flight, in the order they were asked. */
  let queue: Promise<void> = Promise.resolve()

  function enqueue(step: () => Promise<void>): Promise<void> {
    // Both handlers are the step: a queue that stopped after one failure would be a rail that
    // silently ignores every later click. No step is allowed to reject — the one thing that
    // can throw before an await (`compose`) is guarded where it is called — so the queue is
    // never left holding a rejection and the returned promise always resolves.
    const next = queue.then(step, step)
    queue = next
    return next
  }

  async function teardown(): Promise<void> {
    const held = live
    live = null
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
      let composition: AgentComposition
      try {
        composition = compose(vaultId)
      } catch (error) {
        // A composition that could not even be built is the same kind of answer as a runtime
        // that would not start, and it goes to the same place rather than out of the promise.
        state.value = { kind: 'refused', vaultId, reason: failureSentence(error) }
        return
      }
      live = { composition }
      try {
        const session = await composition.openSession({ vaultId, cwd })
        if (mine !== generation) return
        state.value = {
          kind: 'live',
          vaultId,
          key: railKey(session),
          gateway: composition.gateway,
          session,
        }
      } catch (error) {
        if (mine !== generation) return
        // The composition is kept: it is what a `close` has to stop, and the runtime may well
        // be up even though the session was refused.
        state.value = { kind: 'refused', vaultId, reason: failureSentence(error) }
      }
    })
  }

  return {
    state,
    open(vaultId, cwd) {
      return request(vaultId, cwd, false)
    },
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
