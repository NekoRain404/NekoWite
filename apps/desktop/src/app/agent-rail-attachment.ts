/**
 * The rail, as the shell drives it: three readings in, the state it should draw out.
 *
 * Split from `agent-rail.ts` at the line budget and along the seam the two halves already had
 * (`agent-rail.ts`'s header states it: the composition is a factory, the rail is a lifecycle with
 * a state machine, "and the lifecycle is the half that needs a test that can drive it without a
 * window"). What is left here is the half that *does* need one: `watch` and `onBeforeUnmount` are
 * Vue's, and the shell is the layer that owns the switch, the folder and whether the rail is on
 * screen. The rules below are the lifecycle's; this file is where they are attached to a window.
 */

import { onBeforeUnmount, watch, type Ref } from 'vue'
import type { AgentComposition } from './agent-composition'
import { createAgentRail, type AgentRailState } from './agent-rail'

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
  onResumeFailed?: (error: unknown) => void
  onNewSessionFailed?: (error: unknown) => void
}

export interface AttachedAgentRail {
  /** What the rail draws. */
  readonly state: Ref<AgentRailState>
  /** The live composition, for the editor pane's surface — see {@link AgentRail.composition}. */
  readonly composition: Ref<AgentComposition | null>
  /**
   * Ask the backend again after a refusal.
   *
   * The one action the rail's own body needs. Its other way out — going back to the chat panel —
   * is the *switch*, which belongs to the caller (`inputs.enabled` is the caller's own value),
   * so undoing it is the caller's own act rather than a second path into the same decision.
   */
  retry(): Promise<void>
  /**
   * The way between sessions of one runtime: what the panel's history control leads to, and what
   * the pet's task link asks for (§6.2's 点击返回任务 — the session a task names is a session this
   * runtime has served, so it comes back on screen without the engine being asked for it again).
   *
   * On the attached rail as well as the created one, because both gestures arrive here — the
   * shell is what holds both the rail and the folder the session was opened for.
   */
  resume(sessionId: string): Promise<void>
  /**
   * A third: a conversation that has never existed, on the same runtime — what the list's own
   * "new session" entry leads to. Here for the same reason `resume` is: the gesture arrives from
   * the panel, and the shell is the layer that holds both the rail and the folder.
   */
  newSession(): Promise<void>
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
    ...(inputs.onResumeFailed ? { onResumeFailed: inputs.onResumeFailed } : {}),
    ...(inputs.onNewSessionFailed ? { onNewSessionFailed: inputs.onNewSessionFailed } : {}),
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

  return {
    state: rail.state,
    composition: rail.composition,
    retry: () => rail.retry(),
    resume: (sessionId) => rail.resume(sessionId),
    newSession: () => rail.newSession(),
  }
}

