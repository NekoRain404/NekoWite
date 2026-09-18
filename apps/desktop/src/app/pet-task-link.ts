/**
 * The pet window's click on a task, as this window acts on it: one listener, one session, one
 * release.
 *
 * §6.2's 点击返回任务 is two halves and this is the second one. The sending half is the pet's row:
 * it calls `desktop_pet_open_task`, the host raises this window and emits D1's `PetTaskKey` on
 * `pet-open-task`, and what arrives is six strings and nothing else. What *this* file decides is the
 * three things the payload does not carry: which session the key names, whether this window is
 * showing it, and what has to change for the user to be back in front of it.
 *
 * It is a file rather than a handful of lines in the shell for the reason `pet-settings-link.ts`
 * gives one file over: it is a *policy* — when the listener is registered, what a click is allowed
 * to address, when it is released — and `AppShell.vue` is over §13.1's 400-line rung.
 *
 * ## What a click does, and what it does not
 *
 *  - **It is registered for the window's life, not for the rail's.** The flow this exists for is
 *    收起面板 → 完成提醒 → 返回: the click happens while the agent panel is collapsed, which is
 *    exactly when a listener mounted with the panel would not exist. §3.1.3 also keeps the run
 *    going while the panel is away, so the click is the *only* way back to a session nobody is
 *    looking at.
 *  - **It asks the rail for the session, and the rail puts it on screen.** The rail's `resume` is
 *    the one move between two sessions of one runtime (`app/agent-rail.ts`), and it takes the
 *    session the window already serves from the handle it holds rather than asking the engine to
 *    load it again — so a task **still running** in a session the reader left comes back without
 *    the run being touched (§5.1). The panel then remounts under the new `railKey` and subscribes
 *    from a fresh snapshot, which is how the run's state arrives with it.
 *  - **It moves no pointer, because the store has none.** It used to call the agent store's
 *    `focus`: the store's pointer was moved to the session the key named while the rail kept the
 *    session it was on, so the store and the screen could name two different sessions and nothing
 *    said so. Every surface that could act on the session in front has since been given its own
 *    (`d3ec961` and the note host), the pointer was deleted rather than left with no reader
 *    (`features/agent/stores/agent-session.ts`), and this file no longer imports the store at all:
 *    what is on screen is the rail's `live` state and nothing else re-points it.
 *  - **A click addresses a session of *this window's* runtime, and nothing else.** The key carries
 *    the engine, the profile and the vault an identity is bound to, and the rail can only serve the
 *    vault it was started for (`agent_load_session` refuses another before the engine is asked).
 *    For a key from another vault or another engine the window is still raised and the rail still
 *    shows what it has, which is the honest answer and the one the host's own
 *    `PET_TASK_OPEN_CHANNEL` doc already promises ("the main window re-validates it against the
 *    sessions it holds"). The epoch is deliberately *not* one of the fields compared: it names a
 *    runtime instance, and a session id outlives one — an engine that was restarted still holds the
 *    session on its disk, which is what lets a task from before the restart be reopened at all.
 *  - **Released on unmount, including a registration that is still in flight.** `listen` resolves
 *    after an await and the window can be gone by then; a registration nobody released is a listener
 *    on a channel whose other end is still emitting.
 *
 * What it deliberately does *not* do is call `desktop_pet_*` or talk to the pet at all. The user's
 * click has already been acted on by the host by the time it arrives; this side only puts the
 * window in front of what it clicked.
 */

import { onBeforeUnmount, onMounted } from 'vue'
import { onPetTaskRequest } from '../platform/pet-task-request'
import type { AgentIdentity } from '../platform/gateways/agent-contracts'
import type { PetTaskKey } from '../platform/gateways/pet-contracts'

export interface PetTaskLinkInputs {
  /** Whether the agent rail is on screen. The shell's own value, read when a click lands. */
  railOpen: () => boolean
  /** Ask for the rail — the shell emits `toggle-rail` and picks the panel. This file opens nothing. */
  onOpenRail: () => void
  /**
   * The session the rail is showing, or null when no engine is up.
   *
   * The shell's own reading of its rail state, and the one question this file has to ask before it
   * asks for anything: whether the key names a session of the runtime this window is serving.
   */
  session: () => AgentIdentity | null
  /**
   * Ask the rail to put a session of its runtime on screen — `AttachedAgentRail.resume`.
   *
   * A callback rather than a rail handle for the reason the two above are: the shell owns the rail
   * and is the only layer that can be asked; this file decides *when* to ask.
   */
  onShow: (sessionId: string) => void
}

/**
 * Whether a key names a session of the runtime `shown` is serving.
 *
 * The three fields that say *whose* session this is: the engine, the profile and the vault. The
 * fifth, `sessionId`, is what makes it a different session *of* that runtime — the case the rail
 * can move within — and the fourth, `runtimeEpoch`, is left out on purpose: it names one instance
 * of a runtime, and the engine's own session ids outlive instances (that is what its history list
 * is), so a task from before the last restart is still one this window can go back to.
 */
function sameRuntime(shown: AgentIdentity, key: PetTaskKey): boolean {
  return shown.agentId === key.agentId && shown.profileId === key.profileId && shown.vaultId === key.vaultId
}

/**
 * Attach the link, from a component's setup: the listener is registered on mount and released on
 * unmount.
 *
 * The inputs are read inside the callback rather than captured here, so the dependency is chosen
 * once at the composition site like every other one in this layer — and so a test drives the link
 * against the state it supplies at the moment of the click.
 */
export function attachPetTaskLink(inputs: PetTaskLinkInputs): void {
  /** Set once the listener resolves, so an unmount during registration still releases it. */
  let release: (() => void) | null = null
  let stopped = false

  onMounted(async () => {
    const off = await onPetTaskRequest((key) => {
      // The five identity fields and no run: the record a session keeps, and the one the pet's key
      // contains field for field. Nothing here reads the store — the key is compared against the
      // rail's own session, which is what decides whether the click can be honoured.
      const shown = inputs.session()
      // A click on a session that is not this window's to show still raises the window and shows
      // the rail; it does not ask for a session the runtime cannot serve, and it does not pretend
      // to have moved.
      if (shown !== null && sameRuntime(shown, key) && shown.sessionId !== key.sessionId) {
        inputs.onShow(key.sessionId)
      }
      if (!inputs.railOpen()) inputs.onOpenRail()
    })
    if (stopped) off()
    else release = off
  })

  onBeforeUnmount(() => {
    stopped = true
    release?.()
    release = null
  })
}
