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
import type {
  AgentGateway,
  AgentPromptAttachment,
  AgentSession,
  AgentSessionState,
} from '../../../platform/gateways/agent-contracts'
import { isRunLive, sessionKey, type AgentSessionView } from '../services/agent-session-view'
import type { AgentDropReason } from '../services/agent-event-reducer'
import type { AgentLiveNote, LiveNoteLookup } from '../services/agent-context-snapshot'
import {
  useAgentSessionStore,
  type AgentAnswerOutcome,
  type AgentSendOutcome,
} from '../stores/agent-session'
import { useTabsStore } from '../../../stores/tabs'

/**
 * The editor, as {@link openNoteTargets} is allowed to know it.
 *
 * Structural rather than the tab store's own type so the rule can be read — and tested — without a
 * store: what it uses is one tab in front and the ONE lookup, and nothing else about the editor is
 * its business.
 */
export interface OpenNoteSource {
  /** The note in front. `path` is nullable because a tab can be untitled, and an untitled tab has
   *  no path for a baseline to be addressed by — see below. */
  readonly activeTab: { readonly path: string | null } | null
  lookUpLiveNote(path: string): LiveNoteLookup
}

/**
 * The notes a request that names none is about: the note the editor has in front.
 *
 * `AgentEditHost`'s judging half refuses without a baseline, and a baseline only exists for a note
 * a request named — so a send that named nothing would make every later apply a refusal, and the
 * protection `agent-edit-apply.ts` exists for would be a mechanism no reader could reach. The note
 * in front is the document a reader means by "this note", and it is the one at risk while the model
 * thinks: the composer supplies the words, and this supplies the version they are about.
 *
 * Only the `held` arm becomes a target. `cannot-answer` is a tab still on its first read, wearing
 * the note's path while holding a placeholder, and a baseline of the placeholder would be a version
 * of a document the user is not looking at — which is worse than no baseline, because it would
 * pass the judgement. `not-held` is simply no note to name.
 */
export function openNoteTargets(editor: OpenNoteSource): readonly AgentLiveNote[] {
  const tab = editor.activeTab
  // An untitled tab has no path, and every later check in this feature is addressed by one: there
  // is nothing here for a proposal to be bound to, so there is nothing to capture.
  if (tab === null || tab.path === null) return []
  const lookup = editor.lookUpLiveNote(tab.path)
  return lookup.kind === 'held' ? [lookup.note] : []
}

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
  /*
   * The `unread` ref and the `markRead` function used to sit here, then the flag they read and
   * wrote was removed from the store as well: it was written, exposed, and read by nobody — not a
   * component, not a template, not an instrument — and `stores/agent-session.ts`'s `focus` carries
   * the two measurements that made deleting it the honest reading rather than an unfinished one
   * (its only possible renderer is a list of the window's own sessions, which does not exist; and
   * the one reachable way to set it puts the mark on the session that is on screen). Nothing on
   * this binding replaces it, and nothing should: the panel is mounted per session and has no
   * session list to draw a marker on.
   */
  /** §6.2's one active generation: false while a run is in flight, so the composer offers
   *  stop instead of send. */
  canSend: ComputedRef<boolean>
  /** Send one turn. `attachments` is what the message carries beside its words, as the composer
   *  was holding them at this instant; `targets` are the notes the request is about, as the editor
   *  holds them at this instant — they are what an accepted answer is later checked against, so
   *  they have to be read here rather than when the reply arrives (`stores/agent-session.ts`). */
  send(
    text: string,
    attachments: readonly AgentPromptAttachment[],
    targets?: readonly AgentLiveNote[],
  ): Promise<AgentSendOutcome>
  stop(): Promise<void>
  answer(requestId: string, optionId: string): Promise<AgentAnswerOutcome>
  /** Re-establish the state from a fresh snapshot, keeping the timeline. */
  resync(): Promise<void>
  setScroll(scrollTop: number): void
  /** The events that were refused for this session, and the last reason: a window that is
   *  dropping frames should be able to say so rather than look merely quiet. */
  dropped: ComputedRef<number>
  /** Why the last one was refused, exactly as the reducer named it. `null` only until the first
   *  refusal, which is also the only moment `dropped` is `0` — the two are written together, and
   *  the panel's sentence carries the reason so the count is a lead rather than an alarm. */
  lastDrop: ComputedRef<AgentDropReason | null>
}

export function useAgentSession(options: UseAgentSessionOptions): AgentSessionBinding {
  const store = useAgentSessionStore()
  const key = sessionKey(options.session)
  const owns = options.subscribe ?? true

  onMounted(() => {
    // No pointer is moved here, and there is none to move: the panel's own key is the only address
    // this binding uses, and the store keeps no second answer to "which session is in front" (see
    // `stores/agent-session.ts`). What puts a session on screen is the rail's `live` state, which
    // mounts this panel under it — one owner, and nothing a click elsewhere can re-point.
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
    canSend: computed(() => view.value !== null && !isRunLive(view.value)),
    // Every action here is addressed by `key` — this binding's own session, the one the component
    // draws — and there is no other key it could be addressed by: the store holds no "session in
    // front" for a caller to read, so a control can only act on the session it belongs to.
    // `stores/agent-session.ts` carries the argument and the state it replaced.
    //
    // The default is the composer's own subject: the panel hands over the words, and the document
    // they are about is the one the editor has open. See `openNoteTargets` for why an unnamed
    // request still names a version rather than capturing nothing.
    send: (
      text: string,
      attachments: readonly AgentPromptAttachment[],
      targets?: readonly AgentLiveNote[],
    ) => store.send(key, text, attachments, targets ?? openNoteTargets(useTabsStore())),
    stop: () => store.cancel(key),
    answer: (requestId: string, optionId: string) => store.answer(key, requestId, optionId),
    resync: () => store.resync(key),
    setScroll: (scrollTop: number) => store.setScroll(key, scrollTop),
    dropped: computed(() => record.value?.dropped ?? 0),
    lastDrop: computed(() => record.value?.lastDrop ?? null),
  }
}
