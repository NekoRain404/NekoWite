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
 * to address, when it is released — and `AppShell.vue` is over §13.1's 400-line rung. It is
 * deliberately not in `features/agent`: the store there is the thing being addressed, and a feature
 * that subscribes to a channel in order to focus itself is a feature that owns a wire.
 *
 * Three rules, and each is a bug the obvious version has:
 *
 *  - **Registered for the window's life, not for the rail's.** The flow this exists for is 收起面板
 *    → 完成提醒 → 返回: the click happens while the agent panel is collapsed, which is exactly when a
 *    listener mounted with the panel would not exist. §3.1.3 also keeps the run going while the
 *    panel is away, so the click is the *only* way back to a session nobody is looking at.
 *  - **A click addresses a session this window holds, and nothing else.** The store's `focus` takes
 *    any string and its records are keyed by the exact five-field identity, so a key this window is
 *    not holding would set an active key that answers to nothing — and, worse, would stop the
 *    session actually on screen from being marked unread (`stores/agent-session.ts`'s own rule:
 *    a frame for a session that is not active is unread). A key the window does not hold is a
 *    session the engine is no longer running; the window is still raised, and the rail still shows
 *    what it has, which is the honest answer and the one the host's own `PET_TASK_OPEN_CHANNEL` doc
 *    already promises ("the main window re-validates it against the sessions it holds").
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
import { useAgentSessionStore } from '../features/agent/stores/agent-session'
import { sessionKey } from '../features/agent/services/agent-session-view'

export interface PetTaskLinkInputs {
  /** Whether the agent rail is on screen. The shell's own value, read when a click lands. */
  railOpen: () => boolean
  /** Ask for the rail — the shell emits `toggle-rail` and picks the panel. This file opens nothing. */
  onOpenRail: () => void
}

/**
 * Attach the link, from a component's setup: the listener is registered on mount and released on
 * unmount.
 *
 * The store is taken here rather than reached for inside the callback, so the dependency is chosen
 * once at the composition site like every other one in this layer — and so a test drives the link
 * against a store it can read afterwards.
 */
export function attachPetTaskLink(inputs: PetTaskLinkInputs): void {
  const store = useAgentSessionStore()
  /** Set once the listener resolves, so an unmount during registration still releases it. */
  let release: (() => void) | null = null
  let stopped = false

  onMounted(async () => {
    const off = await onPetTaskRequest((key) => {
      // The five identity fields and no run: the record a session keeps, and the one the pet's key
      // contains field for field (`sessionKey`).
      const target = sessionKey(key)
      // Read before the rail is asked for, because asking can start an engine: a click on a session
      // this window is not holding still raises the window and shows the rail, and it does not
      // re-point the store at a key nothing answers to.
      if (store.recordFor(target) !== null) store.focus(target)
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
