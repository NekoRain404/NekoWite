/**
 * The session this panel is mounted on: the store's own binding, the conversation's read-only facts,
 * the `/` menu over the draft, and the composer's config row — gathered as the one thing the panel
 * reads its session through.
 *
 * **It is not `use-agent-session` beside it, and the difference is the reason this file exists.**
 * That one is the *subscription*: one gateway, one session, the store's actions, with the lifecycle
 * tied to the component. What is here is the panel's side of the binding — which of the session's
 * facts the panel draws, and the two reads and writes that only the panel can address because only
 * it holds the key: the position the transcript opens at, and where the engine's refreshed option
 * list goes. Both are the store's own state (`stores/agent-session.ts`), addressed by the key this
 * file holds rather than reached for from each site; the rule behind the first is stated where it is
 * made, below.
 *
 * §5.1's three acceptance rules are stated, and argued, in the panel's own header — this file is what
 * keeps them true now that the binding is not written in the component: the subscription is attached
 * and released with the panel's life and no run is stopped by either, and nothing here keeps state of
 * its own, because the draft and the position are the store's, keyed by the session's identity.
 *
 * The four concerns are still each their own file — `use-agent-conversation`,
 * `use-agent-command-menu`, `use-agent-config-row` and `use-agent-session` — and this one only binds
 * them to one session. It was the panel's own setup until `AgentPanel.vue` was split, and it moved
 * as a *move*: every call is the same call, in the same order, with the same arguments.
 */
import { useAgentCommandMenu, type AgentCommandMenu } from './use-agent-command-menu'
import { useAgentConfigRow, type AgentConfigRow } from './use-agent-config-row'
import { useAgentConversation, type AgentConversation } from './use-agent-conversation'
import { useAgentSession, type AgentSessionBinding } from './use-agent-session'
import { useAgentSessionStore } from '../stores/agent-session'
import type { AgentGateway, AgentSession } from '../../../platform/gateways/agent-contracts'

export interface UseAgentPanelSessionOptions {
  /** The adapter behind the session, chosen at the composition site (§6.1). */
  gateway: AgentGateway
  /** The session to bind to. Read once — a panel is mounted per session, so the composition site
   *  keys it (or remounts it) rather than re-pointing it at another session. */
  session: AgentSession
}

/** The four bindings, together: every value the panel's template draws from its session, and every
 *  action it takes on it. Each member's own file says what it is and why. */
export interface AgentPanelSession
  extends AgentSessionBinding,
    AgentConversation,
    AgentCommandMenu,
    AgentConfigRow {}

export function useAgentPanelSession(options: UseAgentPanelSessionOptions): AgentPanelSession {
  const store = useAgentSessionStore()

  const binding = useAgentSession({ gateway: options.gateway, session: options.session })

  /**
   * The conversation on screen: what this session is called, how long the turn has taken, and the
   * request it is waiting on. Read-only derivations of the binding above — the rules behind them,
   * and why each is written the way it is, are in `use-agent-conversation`.
   *
   * The one thing supplied from here is the timeline's opening position, for §5.1
   * 「每会话独立…滚动位置」: read from the store rather than taken as a prop, because the binding
   * above writes the position (`setScroll`) and has no reader for it. A session the panel has shown
   * before keeps its record across a collapse, and this is the only moment that record is of any
   * use. A record that does not exist yet means nobody has read this session — `undefined` opens it
   * at the end rather than at offset 0, which is what a first look wants. The one case the store
   * cannot tell apart is a record that exists but was never scrolled; that is a session whose
   * transcript the reader has not seen, and opening it at the end is the cheaper mistake.
   */
  const conversation = useAgentConversation({
    session: options.session,
    view: binding.view,
    dropped: binding.dropped,
    lastDrop: binding.lastDrop,
    initialScrollTop: store.recordFor(binding.key)?.scrollTop,
  })

  /** The `/` menu (T8): the engine's published commands for this session, filtered by the token
   *  being typed. Both halves of it are the panel's — the draft is the store's and the keys are the
   *  composer's — which is why it is bound here and owned by `use-agent-command-menu`. */
  const commands = useAgentCommandMenu({ view: binding.view, text: binding.draft })

  /** The composer's control row: the session's own config options, and the one write the panel
   *  makes to the session's state. The call itself is `use-agent-config-row`'s; where the engine's
   *  refreshed list goes is the store's, addressed by this panel's key. */
  const config = useAgentConfigRow({
    gateway: options.gateway,
    session: options.session,
    view: binding.view,
    adopt: (list) => store.adoptOptions(binding.key, list),
  })

  return { ...binding, ...conversation, ...commands, ...config }
}
