/**
 * The `/` menu, wired to one session: the engine's published commands, the token being typed, and
 * the two ways a frame that says the conversation is gone reaches it.
 *
 * `use-agent-commands.ts` beside this file is the menu's *state* — which commands exist, which of
 * them the token keeps, what a key means while an IME has a candidate list open. What it does not
 * own is where the frames come from or what a settlement writes to, and both of those are the
 * session's: the list arrives through the store's own feed, and settling on a row puts a string
 * into the panel's draft (§4.1 sends a command as an ordinary prompt rather than running anything
 * on this side). That wiring is this file, moved out of `AgentPanel.vue` when it went past the size
 * this project allows one component.
 *
 * It takes the draft rather than the store, and it takes the view rather than the session: the two
 * facts it reads are the identity the list belongs to and the failure code that closes it, and both
 * live on the reduced view.
 */
import { onBeforeUnmount, watch, type ComputedRef, type Ref } from 'vue'
import type { AgentCommand, AgentFailureCode } from '../../../platform/gateways/agent-contracts'
import { useAgentCommands, type UseAgentCommands } from './use-agent-commands'
import { useAgentSessionStore } from '../stores/agent-session'
import type { AgentSessionView } from '../services/agent-session-view'

export interface UseAgentCommandMenuOptions {
  /** The session's reduced view, or null while nothing has been reduced yet. */
  view: ComputedRef<AgentSessionView | null>
  /** The half-written message. Read for the token, written when a row is settled on. */
  text: Ref<string>
}

export interface AgentCommandMenu {
  /** The menu's own state and key handling, as `useAgentCommands` returns it. */
  commands: UseAgentCommands
  /** Settle on a row: the command's name replaces the token, and nothing else changes. */
  choose(command: AgentCommand): void
  /** An IME began or ended a composition over the field. */
  composition(phase: 'start' | 'end'): void
}

export function useAgentCommandMenu(options: UseAgentCommandMenuOptions): AgentCommandMenu {
  const store = useAgentSessionStore()

  /**
   * The list it filters arrives here frame by frame, through the store's own feed
   * (`store.observeEvents`): `useAgentCommands` is fed the engine's events through its
   * `accept(event)`, and those frames belong to the store. The reduced view is deliberately not the
   * source — it reports "nothing published yet" and "the engine published an empty list" as the
   * same empty `commands` array, and the menu tells those apart because the user's next move
   * differs. Feeding it the frames keeps that distinction where it is already modelled, and it is
   * what makes the empty state's `/ for commands` a true sentence rather than an offer of a menu
   * that would never fill.
   */
  const commands = useAgentCommands({
    identity: () => options.view.value?.identity ?? null,
    text: () => options.text.value,
    select: choose,
  })

  // The feed is released with the component: a listener left behind would keep filtering frames for
  // a session whose menu is not on screen any more. Registered at setup rather than on mount,
  // because the events of the very first frame must not be missed between the two.
  const stopObserving = store.observeEvents((event) => commands.accept(event))
  onBeforeUnmount(stopObserving)

  // ...and the second way the same fact arrives. A *call* the host refused is not a frame, so it
  // never reaches `accept`: `agent_prompt` answering `session-stale` (or `runtime-unavailable`, or
  // `process-exited`) is recorded on the view by the store's send, and this is where the menu hears
  // it. The watch is on the failure alone rather than on the view, because every frame replaces the
  // view and the menu would otherwise be re-told about a failure it has already acted on.
  //
  // Only the codes that mean the conversation is gone do anything (`invalidate` is the rule's own
  // home, beside the frame arm that applies the same list). A refusal about the turn — the race of a
  // second send — leaves the rows alone, which is what the reader would expect: the session is busy,
  // not absent.
  watch(
    () => options.view.value?.failure?.code ?? null,
    (code: AgentFailureCode | null) => {
      if (code !== null) commands.invalidate(code)
    },
  )

  /**
   * What settling on a menu row means: the command's name replaces the token, and everything the
   * reader typed after it is kept exactly as it was — this function cannot read an argument, so it
   * cannot trim, requote or reinterpret one (§4.1 「原样参数保留」).
   *
   * One function for both paths on purpose: `<AgentCommandMenu>`'s `@select` (a click) and the
   * menu's own `select` (Enter on the highlighted row) are the same act on the same row.
   */
  function choose(command: AgentCommand): void {
    options.text.value = commands.textWithCommand(command)
  }

  function composition(phase: 'start' | 'end'): void {
    if (phase === 'start') commands.onCompositionStart()
    else commands.onCompositionEnd()
  }

  return { commands, choose, composition }
}
