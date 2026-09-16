/**
 * The binding a component calls.
 *
 * It is deliberately thin: everything a session knows and everything that can be done to it
 * is in the store and the reducer, and this file is the surface a panel names in a template —
 * refs for what it renders, functions for what it does, and the subscription lifecycle tied
 * to the component's own.
 *
 * The panel is not a store and must not become one (§10.2: components take props and emit; the
 * state lives in the store). So this returns values and actions, not the store itself, and a
 * component that needs something narrower than this should take it as a prop instead of
 * reaching into the store for it.
 *
 * `subscribe` is what keeps two callers from fighting over one session: `AgentGateway.subscribe`
 * is per session, and a second caller that attached would replace the first one's subscription
 * and rebuild its view from a fresh snapshot — losing a timeline the first one was drawing.
 * A component that only reads the store passes `subscribe: false`.
 */

import { computed, onBeforeUnmount, onMounted, type ComputedRef, type WritableComputedRef } from 'vue'
import type { AgentGateway, AgentSession, AgentSessionState } from '../../../platform/gateways/agent-contracts'
import { isRunLive, sessionKey, type AgentSessionView } from '../services/agent-session-view'
import {
  useAgentSessionStore,
  type AgentAnswerOutcome,
  type AgentSendOutcome,
} from '../stores/agent-session'

export interface UseAgentSessionOptions {
  /** The gateway behind the session. Chosen at the composition site, so nothing here knows
   *  whether it is the memory double or the real runtime. */
  gateway: AgentGateway
  /** The session this component is showing. */
  session: AgentSession
  /** Whether this caller owns the session's subscription — see the note above. Default: yes. */
  subscribe?: boolean
}

export interface AgentSessionBinding {
  /** The store's key for this session: what every per-session action below is addressed by. */
  key: string
  view: ComputedRef<AgentSessionView | null>
  state: ComputedRef<AgentSessionState | null>
  timeline: ComputedRef<AgentSessionView['timeline']>
  permissions: ComputedRef<AgentSessionView['permissions']>
  /** A hole in the stream, if one has been recorded: the panel owes the user an explanation
   *  and a resync rather than a silent partial transcript. */
  gap: ComputedRef<AgentSessionView['gap']>
  /** The half-written message. Reading and writing it goes through here so the component does
   *  not have to know that drafts are kept per session. */
  draft: WritableComputedRef<string>
  unread: ComputedRef<boolean>
  /** §6.2's one active generation: false while a run is in flight, so the composer offers
   *  stop instead of send. */
  canSend: ComputedRef<boolean>
  send(text: string): Promise<AgentSendOutcome>
  stop(): Promise<void>
  answer(requestId: string, optionId: string): Promise<AgentAnswerOutcome>
  /** Re-establish the state from a fresh snapshot, keeping the timeline. */
  resync(): Promise<void>
  markRead(): void
  setScroll(scrollTop: number): void
  /** The events that were refused for this session, and the last reason: a window that is
   *  dropping frames should be able to say so rather than look merely quiet. */
  dropped: ComputedRef<number>
}

export function useAgentSession(options: UseAgentSessionOptions): AgentSessionBinding {
  const store = useAgentSessionStore()
  const key = sessionKey(options.session)
  const owns = options.subscribe ?? true

  onMounted(() => {
    store.focus(key)
    if (owns) void store.attach(options.gateway, options.session)
  })

  onBeforeUnmount(() => {
    // Only the owner releases the subscription. A reader that detached would take the
    // timeline out from under whoever is drawing it.
    if (owns) store.detach(key)
  })

  const record = computed(() => store.records[key] ?? null)
  const view = computed<AgentSessionView | null>(() => record.value?.view ?? null)
  const draft = computed({
    get: () => record.value?.draft ?? '',
    set: (text: string) => store.setDraft(key, text),
  })

  return {
    key,
    view,
    state: computed(() => view.value?.state ?? null),
    timeline: computed(() => view.value?.timeline ?? []),
    permissions: computed(() => view.value?.permissions ?? []),
    gap: computed(() => view.value?.gap ?? null),
    draft,
    unread: computed(() => record.value?.unread ?? false),
    canSend: computed(() => view.value !== null && !isRunLive(view.value)),
    send: (text: string) => store.send(text),
    stop: () => store.cancel(key),
    answer: (requestId: string, optionId: string) => store.answer(requestId, optionId),
    resync: () => store.resync(key),
    markRead: () => store.markRead(key),
    setScroll: (scrollTop: number) => store.setScroll(key, scrollTop),
    dropped: computed(() => record.value?.dropped ?? 0),
  }
}
